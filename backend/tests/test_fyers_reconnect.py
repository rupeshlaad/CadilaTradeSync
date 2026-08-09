"""
Sprint 6.2.13 Fyers OAuth reconnect fix — regression tests.

PostgreSQL is NOT available in this pod (no postgres binaries, no DATABASE_URL),
so the NestJS API cannot connect to a DB and live HTTP tests of
GET /brokers/fyers/callback are impossible. Instead this module drives the
COMPILED FyersController / FyersService (apps/api/dist) against an in-memory
Prisma double via a Node harness, which exercises the real production code path:

    exchangeToken -> getProfile -> saveSession -> validatePersistedSession -> redirect

Harness: /app/backend/tests/fyers_reconnect_harness.cjs
"""

import os
import subprocess

import pytest

API_DIR = "/app/apps/api"
HARNESS = "/app/backend/tests/fyers_reconnect_harness.cjs"
FYERS_DIR = "/app/apps/api/src/brokers/fyers"


@pytest.fixture(scope="module")
def harness_output():
    assert os.path.exists(HARNESS), "harness script missing"
    proc = subprocess.run(
        ["node", HARNESS],
        cwd=API_DIR,
        capture_output=True,
        text=True,
        timeout=180,
    )
    print(proc.stdout[-8000:])
    print(proc.stderr[-2000:])
    return proc


# --- Fyers callback ordering / persistence + validation before success -------
class TestFyersCallbackHarness:
    def test_harness_runs_clean(self, harness_output):
        assert harness_output.returncode == 0, (
            "Fyers reconnect harness reported failures:\n"
            + harness_output.stdout[-4000:]
        )
        assert "RESULT: ALL PASS" in harness_output.stdout

    @pytest.mark.parametrize(
        "check",
        [
            "S1 ORDERING persist -> validate(findUnique) -> redirect",
            "S1 success redirect contains connected=1",
            "S1 loginTime set on create",
            "S1 lastHeartbeat set on create",
            "S2 loginTime REFRESHED on update",
            "S2 lastHeartbeat refreshed on update",
            "S2 userId refreshed on update",
            "S2 token overwritten with new token",
            "S3 failure redirect (no connected=1)",
            "S4 failure redirect on empty access token",
            "S5 failure redirect on missing auth code",
            "S6 failure redirect on missing reconnect context",
            "S7 failure redirect on broker status param",
            "S8 failure redirect on token exchange error",
            "S9 valid row -> ok:true with userId",
            "S10 no success redirect when heartbeat update throws",
        ],
    )
    def test_individual_check_passed(self, harness_output, check):
        assert f"PASS  {check}" in harness_output.stdout, (
            f"check did not pass: {check}"
        )


# --- Static guarantees on the changed source --------------------------------
class TestFyersSourceInvariants:
    def test_success_redirect_only_after_validation(self):
        src = open(f"{FYERS_DIR}/fyers.controller.ts").read()
        i_save = src.index("saveSession(")
        i_validate = src.index("validatePersistedSession(")
        i_guard = src.index("if (!validation.ok)")
        i_success = src.index("result: { ok: true }")
        assert i_save < i_validate < i_guard < i_success

    def test_savesession_refreshes_timestamps_on_create_and_update(self):
        src = open(f"{FYERS_DIR}/fyers.service.ts").read()
        assert src.count("loginTime: now") == 2  # update + create
        assert "lastHeartbeat: now" in src
        assert "connectionStatus: 'CONNECTED'" in src

    def test_validation_uses_same_unique_key_as_adapter_factory(self):
        src = open(f"{FYERS_DIR}/fyers.service.ts").read()
        block = src[src.index("validatePersistedSession"):]
        assert "tradingAccountId_broker" in block
        assert "broker: 'FYERS'" in block
        for reason in [
            "No persisted Fyers session found after save",
            "could not be decrypted",
            "access token is empty",
            "(API ID) is empty",
        ]:
            assert reason in block


# --- No regression to other brokers ----------------------------------------
class TestNoOtherBrokerFilesChanged:
    def test_only_fyers_files_modified(self):
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd="/app",
            capture_output=True,
            text=True,
        )
        changed = [
            line[3:].strip()
            for line in proc.stdout.splitlines()
            if line.strip()
            and not line[3:].strip().startswith(".emergent/")
            # test artefacts added by this testing pass
            and not line[3:].strip().startswith("backend/tests/")
            and not line[3:].strip().startswith("test_reports/")
        ]
        offenders = [
            p
            for p in changed
            if not p.startswith("apps/api/src/brokers/fyers/")
            # Sprint 6.2.15 — account isolation also makes Fyers reads use the
            # account's own App ID in the shared broker adapter factory.
            and p != "apps/api/src/brokers/broker.service.ts"
        ]
        assert offenders == [], f"unexpected modified files: {offenders}"
