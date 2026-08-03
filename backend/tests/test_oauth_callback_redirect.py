"""Sprint 3.1 - OAuth reconnect callback redirect tests.

All callback outcomes (success context missing, missing token, invalid token,
Zerodha status=failure) must respond with HTTP 302 to the admin app and MUST
NOT return raw JSON with success/profile keys.
"""
import re
import pytest
import requests

API_BASE = "http://localhost:4000"
ADMIN_BASE = "http://localhost:3001"


def _assert_admin_redirect(resp, expected_path_prefix="/dashboard/master-accounts"):
    assert resp.status_code == 302, f"Expected 302 got {resp.status_code}, body={resp.text[:200]}"
    loc = resp.headers.get("Location", "")
    assert loc.startswith(ADMIN_BASE + expected_path_prefix), f"Bad Location: {loc}"
    # Ensure the body is not the old raw JSON payload
    body = resp.text or ""
    assert '"success"' not in body, f"Response body leaks JSON success: {body[:200]}"
    assert '"profile"' not in body, f"Response body leaks JSON profile: {body[:200]}"


class TestZerodhaCallbackRedirect:
    def test_callback_status_failure_redirects(self):
        r = requests.get(f"{API_BASE}/brokers/zerodha/callback",
                         params={"status": "failure"}, allow_redirects=False)
        _assert_admin_redirect(r)
        assert "error=" in r.headers["Location"]

    def test_callback_missing_token_redirects(self):
        r = requests.get(f"{API_BASE}/brokers/zerodha/callback",
                         allow_redirects=False)
        _assert_admin_redirect(r)
        assert "Missing+request+token" in r.headers["Location"] or "Missing%20request%20token" in r.headers["Location"]

    def test_callback_invalid_token_redirects(self):
        r = requests.get(f"{API_BASE}/brokers/zerodha/callback",
                         params={"request_token": "INVALID_TOKEN_XYZ"},
                         allow_redirects=False)
        _assert_admin_redirect(r)
        assert "error=" in r.headers["Location"]

    def test_login_then_callback_invalid_still_redirects(self):
        # (a) login stores the tradingAccountId
        r1 = requests.get(f"{API_BASE}/brokers/zerodha/login",
                          params={"tradingAccountId": "abc-123-xyz"},
                          allow_redirects=False)
        assert r1.status_code == 302
        assert "kite.zerodha.com" in r1.headers.get("Location", "")

        # (b) callback with invalid token still redirects to admin (not JSON)
        r2 = requests.get(f"{API_BASE}/brokers/zerodha/callback",
                          params={"request_token": "INVALID_TOKEN_XYZ"},
                          allow_redirects=False)
        _assert_admin_redirect(r2)
        assert "error=" in r2.headers["Location"]
