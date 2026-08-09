"""
Sprint 6.2.15 Fyers multi-account isolation fix — regression tests.

Reproduces the reported production bug: two Fyers master accounts with different
API Key (App ID) + Secret — reconnecting account B (Rupesh) still authenticated
account A (Dimple), because the OAuth URL, token exchange and read header all
used the global FYERS_APP_ID/FYERS_SECRET_ID.

PostgreSQL is NOT available in this pod, so the COMPILED FyersController /
FyersService / FyersAdapter (apps/api/dist) are driven against an in-memory
Prisma double via a Node harness. The real per-account credential resolution
(decrypt encryptedApiKey/encryptedApiSecret -> FyersAdapter.setCredentials) runs
unchanged; only the SDK-touching adapter methods are patched, and they derive
their result from the adapter's OWN appId so any env/global leakage fails loudly.

Harness: /app/backend/tests/fyers_account_isolation_harness.cjs
"""

import os
import subprocess

import pytest

API_DIR = "/app/apps/api"
HARNESS = "/app/backend/tests/fyers_account_isolation_harness.cjs"
BROKERS_DIR = "/app/apps/api/src/brokers"
FYERS_DIR = "/app/apps/api/src/brokers/fyers"


@pytest.fixture(scope="module")
def harness_output():
    assert os.path.exists(HARNESS), "isolation harness script missing"
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


class TestFyersAccountIsolationHarness:
    def test_harness_runs_clean(self, harness_output):
        assert harness_output.returncode == 0, (
            "Fyers account-isolation harness reported failures:\n"
            + harness_output.stdout[-4000:]
        )
        assert "RESULT: ALL PASS" in harness_output.stdout

    @pytest.mark.parametrize(
        "check",
        [
            "login A URL carries App ID A",
            "login B URL carries App ID B",
            "login A URL does NOT carry env/global App ID",
            "login B URL does NOT carry App ID A (no crossover)",
            "reconnect A → success redirect",
            "A session authenticated Dimple",
            "reconnect B → success redirect",
            "B session authenticated Rupesh (NOT Dimple)",
            "B token derived from App ID B",
            "repeated switching: no crossover in any step",
            "final A row still Dimple",
            "final B row still Rupesh",
            "A and B tokens are distinct (per-account App ID/Secret)",
            "two independent FYERS session rows persisted",
            "login without API Key/Secret → error redirect",
            "callback without API Key/Secret → error redirect (no success)",
            "callback for unknown account → error redirect",
        ],
    )
    def test_individual_check_passed(self, harness_output, check):
        assert f"PASS  {check}" in harness_output.stdout, (
            f"check did not pass: {check}"
        )


class TestFyersSourceInvariants:
    def test_adapter_uses_instance_credentials_not_env(self):
        src = open(f"{FYERS_DIR}/fyers.adapter.ts").read()
        assert "setCredentials(appId: string, secretId: string)" in src
        # generate_access_token must use the account's own creds, never env.
        block = src[src.index("async exchangeToken"):]
        assert "client_id: this.appId" in block
        assert "secret_key: this.secretId" in block
        assert "process.env.FYERS_APP_ID" not in block
        assert "process.env.FYERS_SECRET_ID" not in block

    def test_controller_builds_per_account_adapter(self):
        src = open(f"{FYERS_DIR}/fyers.controller.ts").read()
        assert "buildAccountAdapter" in src
        assert "encryptedApiKey" in src and "encryptedApiSecret" in src
        assert "adapter.setCredentials(appId, secretId)" in src
        # no controller-shared singleton adapter keyed off env
        assert "private readonly adapter = new FyersAdapter()" not in src

    def test_broker_service_fyers_reads_use_account_creds(self):
        src = open(f"{BROKERS_DIR}/broker.service.ts").read()
        assert "accountApiCreds" in src
        fyers_case = src[src.index("case Broker.FYERS:"):]
        assert "adapter.setCredentials(creds.apiKey" in fyers_case


class TestNoOtherBrokerBehaviourChanged:
    """Zerodha / ICICI / Shoonya adapters must be byte-identical (isolation
    fix is Fyers-only + the shared factory's Fyers branch)."""

    def test_other_broker_adapters_untouched(self):
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
            and not line[3:].strip().startswith("backend/tests/")
            and not line[3:].strip().startswith("test_reports/")
        ]
        for broker in ("zerodha", "icici", "shoonya"):
            offenders = [
                p for p in changed if p.startswith(f"apps/api/src/brokers/{broker}/")
            ]
            assert offenders == [], f"{broker} unexpectedly modified: {offenders}"
