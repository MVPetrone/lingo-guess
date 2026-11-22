#!/usr/bin/env python3
"""
Security + behaviour suite for Google sign-in and account sync.

    python3 tests/security/test_auth.py http://127.0.0.1:8099 [/path/to/storage]
    BASE_URL=https://lingoguess.com python3 tests/security/test_auth.py

Runs the anonymous surface against any target. When STORAGE_DIR points at the
target's storage/ directory (local runs only), it also seeds a player and a
session straight into crm.sqlite and exercises the signed-in paths — there is
no way to mint a real Google id_token here, so the callback's success path is
not covered by this suite.

Cookies are sent by hand: they are Secure, and Python's cookie jar will not
send a Secure cookie to an http:// test server.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE_URL", "http://127.0.0.1:8099")).rstrip("/")
STORAGE_DIR = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("STORAGE_DIR", "")
LOCAL = BASE.startswith("http://127.0.0.1") or BASE.startswith("http://localhost")
ORIGIN = {"Origin": "https://lingoguess.com" if LOCAL else BASE}
CLIENT = {"X-Lingo-Client": "1"}

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"  [{detail}]" if detail and not ok else ""))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect())


def req(method: str, path: str, body: bytes | None = None, headers: dict | None = None, cookies: dict | None = None):
    """Returns (status, headers as a list of pairs, body)."""
    request = urllib.request.Request(BASE + path, data=body, method=method)
    request.add_header("User-Agent", "security-suite/1.0")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    if cookies:
        request.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
    try:
        with OPENER.open(request, timeout=30) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


def put_json(path: str, payload, headers: dict | None = None, cookies: dict | None = None):
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    return req("PUT", path, json.dumps(payload).encode(), hdrs, cookies)


def set_cookies(headers) -> dict[str, str]:
    """Set-Cookie headers by cookie name (the raw header, attributes included)."""
    out = {}
    for raw in headers.get_all("Set-Cookie") or []:
        out[raw.split("=", 1)[0].strip()] = raw
    return out


def cookie_value(raw: str) -> str:
    return urllib.parse.unquote(raw.split(";", 1)[0].split("=", 1)[1])


def as_json(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def is_signin_error(headers) -> bool:
    return (headers.get("Location") or "").startswith("/?signin=error")


# --------------------------------------------------------------------------- #
# 1. me.php
# --------------------------------------------------------------------------- #
status, headers, raw = req("GET", "/admin/api/me.php")
check("me.php without a cookie says signed_in:false", status == 200 and as_json(raw) == {"signed_in": False}, f"{status} {raw[:80]!r}")
check("me.php is JSON + nosniff + no-store",
      (headers.get("Content-Type") or "").startswith("application/json")
      and headers.get("X-Content-Type-Options") == "nosniff"
      and "no-store" in (headers.get("Cache-Control") or ""), str(headers.get("Content-Type")))

status, headers, raw = req("GET", "/admin/api/me.php", cookies={"lingo_sess": secrets.token_hex(32)})
check("me.php with a forged session is signed out", status == 200 and as_json(raw) == {"signed_in": False}, str(status))
check("me.php clears a forged session cookie", "lingo_sess" in set_cookies(headers), str(set_cookies(headers).keys()))

status, _, _ = req("POST", "/admin/api/me.php", b"")
check("me.php is GET-only", status == 405, str(status))

# --------------------------------------------------------------------------- #
# 2. sync.php without a session
# --------------------------------------------------------------------------- #
small = {"data": json.dumps({"v": 1}), "base_updated_at": 0}

status, _, raw = put_json("/admin/api/sync.php", small, ORIGIN)
check("sync PUT without X-Lingo-Client is 403", status == 403, f"{status} {raw[:60]!r}")

status, _, raw = put_json("/admin/api/sync.php", small, {**CLIENT, "Origin": "https://evil.example"})
check("sync PUT from a foreign origin is 403", status == 403, f"{status} {raw[:60]!r}")

status, _, raw = put_json("/admin/api/sync.php", small, {**CLIENT, **ORIGIN})
check("sync PUT without a session is 401", status == 401 and b"unauthorized" in raw, f"{status} {raw[:60]!r}")

status, _, raw = put_json("/admin/api/sync.php", small, {**CLIENT, **ORIGIN}, {"lingo_sess": "f" * 64})
check("sync PUT with a forged session is 401", status == 401, str(status))

big = {"data": json.dumps({"v": 1, "pad": "x" * 300_000}), "base_updated_at": 0}
status, _, raw = put_json("/admin/api/sync.php", big, {**CLIENT, **ORIGIN})
check("sync PUT with data over 256 KB is 413", status == 413, f"{status} {raw[:60]!r}")

huge = {"data": "x" * 700_000, "base_updated_at": 0}
status, _, raw = put_json("/admin/api/sync.php", huge, {**CLIENT, **ORIGIN})
check("sync PUT with a body over the cap is 413", status == 413, str(status))

status, _, raw = req("GET", "/admin/api/sync.php")
check("sync GET without a session is 401", status == 401, str(status))

status, _, _ = req("POST", "/admin/api/sync.php", b"{}", {**CLIENT, **ORIGIN})
check("sync refuses POST", status == 405, str(status))

# --------------------------------------------------------------------------- #
# 3. account.php / auth_logout.php without a session
# --------------------------------------------------------------------------- #
status, _, raw = req("DELETE", "/admin/api/account.php", headers={**CLIENT, **ORIGIN})
check("account DELETE without a session is 401", status == 401, f"{status} {raw[:60]!r}")

status, _, _ = req("DELETE", "/admin/api/account.php", headers=ORIGIN)
check("account DELETE without X-Lingo-Client is 403", status == 403, str(status))

status, _, _ = req("GET", "/admin/api/account.php")
check("account.php refuses GET", status == 405, str(status))

status, _, _ = req("POST", "/admin/api/auth_logout.php", b"", {**CLIENT, **ORIGIN})
check("logout without a session is 401", status == 401, str(status))

status, _, _ = req("GET", "/admin/api/auth_logout.php")
check("logout refuses GET", status == 405, str(status))

# --------------------------------------------------------------------------- #
# 4. auth_start.php
# --------------------------------------------------------------------------- #
status, headers, raw = req("GET", "/admin/api/auth_start.php")
location = headers.get("Location") or ""
target = urllib.parse.urlsplit(location)
query = dict(urllib.parse.parse_qsl(target.query))
check("auth_start redirects to Google", status == 302 and location.startswith("https://accounts.google.com/o/oauth2/v2/auth?"), f"{status} {location[:60]}")
check("auth_start uses PKCE S256", query.get("code_challenge_method") == "S256" and re.fullmatch(r"[A-Za-z0-9_-]{43}", query.get("code_challenge", "")) is not None, str(query.get("code_challenge_method")))
check("auth_start asks for code + openid email profile + account chooser",
      query.get("response_type") == "code" and query.get("scope") == "openid email profile" and query.get("prompt") == "select_account",
      str({k: query.get(k) for k in ("response_type", "scope", "prompt")}))
check("auth_start redirect_uri is the callback", query.get("redirect_uri", "").endswith("/admin/api/auth_callback.php"), query.get("redirect_uri", ""))
check("auth_start never puts the client secret in the URL", "client_secret" not in query and "GOCSPX" not in location, "")

oauth = set_cookies(headers).get("lingo_oauth", "")
attrs = oauth.lower()
check("state cookie is set", bool(oauth), "no lingo_oauth Set-Cookie")
check("state cookie is HttpOnly + Secure + SameSite=Lax + Path=/",
      "httponly" in attrs and "secure" in attrs and "samesite=lax" in attrs and "path=/" in attrs, oauth[-120:])
check("state cookie lives 10 minutes", "max-age=600" in attrs, oauth[-120:])
state, _, verifier = cookie_value(oauth).partition(":") if oauth else ("", "", "")
check("state is 32 random bytes in hex and matches the URL", re.fullmatch(r"[a-f0-9]{64}", state) is not None and query.get("state") == state, state[:12])
check("verifier is 43-128 chars", 43 <= len(verifier) <= 128, str(len(verifier)))
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
check("challenge = base64url(sha256(verifier))", challenge == query.get("code_challenge"), "")

status, headers2, _ = req("GET", "/admin/api/auth_start.php")
state2 = cookie_value(set_cookies(headers2).get("lingo_oauth", "x:y")).split(":")[0]
check("every start mints a new state", state2 != state, "")

# --------------------------------------------------------------------------- #
# 5. auth_callback.php
# --------------------------------------------------------------------------- #
bogus = "4/0Bogus" + secrets.token_urlsafe(20)

status, headers, _ = req("GET", f"/admin/api/auth_callback.php?code={bogus}&state={'a' * 64}")
check("callback without the state cookie fails to /?signin=error", status == 302 and is_signin_error(headers), f"{status} {headers.get('Location')}")
check("callback without the state cookie sets no session", "lingo_sess" not in set_cookies(headers), "")

status, headers, _ = req("GET", f"/admin/api/auth_callback.php?code={bogus}&state={'b' * 64}", cookies={"lingo_oauth": f"{state}:{verifier}"})
check("callback with a mismatched state fails", status == 302 and is_signin_error(headers) and "reason=state" in headers.get("Location", ""), headers.get("Location", ""))

status, headers, _ = req("GET", f"/admin/api/auth_callback.php?code={bogus}&state={state}", cookies={"lingo_oauth": f"{state}:{verifier}"})
cb_cookies = set_cookies(headers)
check("callback with a bogus code fails to /?signin=error", status == 302 and is_signin_error(headers), f"{status} {headers.get('Location')}")
check("callback with a bogus code sets no session cookie", "lingo_sess" not in cb_cookies, str(cb_cookies.keys()))
check("callback burns the state cookie", "lingo_oauth" in cb_cookies and cookie_value(cb_cookies["lingo_oauth"]) in ("", "deleted"), cb_cookies.get("lingo_oauth", "")[:60])

status, headers, _ = req("GET", "/admin/api/auth_callback.php?error=access_denied&state=" + state, cookies={"lingo_oauth": f"{state}:{verifier}"})
check("callback when the player cancels fails cleanly", status == 302 and is_signin_error(headers), headers.get("Location", ""))

status, headers, raw = req("GET", "/admin/api/auth_callback.php?code=%3Cscript%3Ealert(1)%3C/script%3E&state=%3Cimg%3E")
location = headers.get("Location", "")
check("callback never echoes input into the redirect", is_signin_error(headers) and "script" not in location.lower() and "img" not in location.lower() and raw.strip() == b"", location)
check("callback reason is a short code", re.fullmatch(r"/\?signin=error&reason=[a-z_]{2,20}", location) is not None, location)

# --------------------------------------------------------------------------- #
# 5b. Admin settings page (where the operator installs the Google keys)
# --------------------------------------------------------------------------- #
status, headers, _ = req("GET", "/admin/settings.php")
check("settings requires an admin session", status in (302, 303) and "/admin/index.php" in headers.get("Location", ""), f"{status} {headers.get('Location')}")
status, headers, _ = req("POST", "/admin/settings.php", b"google_client_id=x", {"Content-Type": "application/x-www-form-urlencoded"})
check("settings POST without a session redirects to login", status in (302, 303) and "/admin/index.php" in headers.get("Location", ""), str(status))

ADMIN_PASS = (open(sys.argv[3]).read().strip() if len(sys.argv) > 3 else "") or os.environ.get("ADMIN_PASS", "")
if not ADMIN_PASS:
    print("  SKIP  settings tests (pass an admin password file as the third argument)")
else:
    def form(fields: dict) -> bytes:
        return urllib.parse.urlencode(fields).encode()

    FORM = {"Content-Type": "application/x-www-form-urlencoded"}
    status, headers, raw = req("GET", "/admin/index.php")
    admin = {"lgcrm": cookie_value(set_cookies(headers)["lgcrm"])}
    token = re.search(r'name="csrf" value="([a-f0-9]{64})"', raw.decode()).group(1)
    status, headers, _ = req("POST", "/admin/login.php", form({"username": "admin", "password": ADMIN_PASS, "csrf": token}), FORM, admin)
    admin = {"lgcrm": cookie_value(set_cookies(headers).get("lgcrm", "lgcrm=" + admin["lgcrm"]))}
    check("admin login for the settings tests", "/admin/dashboard.php" in headers.get("Location", ""), headers.get("Location", ""))

    status, headers, raw = req("GET", "/admin/settings.php", cookies=admin)
    page = raw.decode("utf-8", "replace")
    token = (re.search(r'name="csrf" value="([a-f0-9]{64})"', page) or re.match("()", "")).group(1)
    check("settings page renders with a CSRF token", status == 200 and len(token) == 64 and "Google sign-in" in page, str(status))
    check("settings page has the strict CSP with Google as the only form-action",
          "form-action 'self' https://accounts.google.com" in headers.get("Content-Security-Policy", "")
          and "script-src 'self'" in headers.get("Content-Security-Policy", ""), headers.get("Content-Security-Policy", "")[:80])
    check("dashboard links to settings", b'href="/admin/settings.php"' in req("GET", "/admin/dashboard.php", cookies=admin)[2], "")

    new_id = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com"
    new_secret = "GOCSPX-" + secrets.token_urlsafe(21)
    status, headers, _ = req("POST", "/admin/settings.php", form({"csrf": "0" * 64, "google_client_id": new_id, "google_client_secret": new_secret}), FORM, admin)
    check("settings rejects a bad CSRF token", "e=csrf" in headers.get("Location", ""), headers.get("Location", ""))
    status, headers, _ = req("POST", "/admin/settings.php", form({"csrf": token, "google_client_id": "evil'];phpinfo();//", "google_client_secret": ""}), FORM, admin)
    check("settings rejects a malformed client id", "e=bad_id" in headers.get("Location", ""), headers.get("Location", ""))
    status, headers, _ = req("POST", "/admin/settings.php", form({"csrf": token, "google_client_id": new_id, "google_client_secret": new_secret}), FORM, admin)
    check("settings saves valid keys", status == 303 and "ok=1" in headers.get("Location", ""), headers.get("Location", ""))

    status, _, raw = req("GET", "/admin/settings.php?ok=1", cookies=admin)
    page = raw.decode("utf-8", "replace")
    check("settings never renders the secret", new_secret not in page and "GOCSPX" not in page.replace("GOCSPX-…", ""), "")
    check("settings shows only the id's last 12 distinguishing chars", "uvwxyz012345" in page and new_id not in page, "")
    check("settings shows the secret as set", re.search(r'data-testid="client-secret-status">set<', page) is not None, "")
    if STORAGE_DIR:
        cfg_path = os.path.join(STORAGE_DIR, "config.php")
        cfg = open(cfg_path).read()
        check("config.php is 0600 after the write", (os.stat(cfg_path).st_mode & 0o777) == 0o600, oct(os.stat(cfg_path).st_mode))
        check("config.php kept the other keys", "'app_secret'" in cfg and "'canonical_origin'" in cfg, "")
        check("config.php holds the new keys", new_id in cfg and new_secret in cfg, "")
        check("no temp config files are left", not [f for f in os.listdir(STORAGE_DIR) if f.endswith(".tmp")], "")

# --------------------------------------------------------------------------- #
# 6. Signed-in paths (local only: a session seeded straight into SQLite)
# --------------------------------------------------------------------------- #
if not STORAGE_DIR:
    print("  SKIP  signed-in tests (set STORAGE_DIR to the local target's storage/)")
else:
    db = sqlite3.connect(os.path.join(STORAGE_DIR, "crm.sqlite"), timeout=10)
    db.execute("PRAGMA foreign_keys = ON")

    def seed_player(created_ago: int = 0) -> tuple[int, str]:
        now = int(time.time())
        sub = "test-" + secrets.token_hex(8)
        cur = db.execute(
            "INSERT INTO players (google_sub, email, name, created_at, last_login) VALUES (?, ?, ?, ?, ?)",
            (sub, f"{sub}@example.com", "Test <b>Player</b>", now, now),
        )
        token = secrets.token_hex(32)
        db.execute(
            "INSERT INTO sessions (id, player_id, created_at, last_seen) VALUES (?, ?, ?, ?)",
            (hashlib.sha256(token.encode()).hexdigest(), cur.lastrowid, now - created_ago, now - created_ago),
        )
        db.commit()
        return cur.lastrowid, token

    pid, token = seed_player()
    sess = {"lingo_sess": token}
    write = {**CLIENT, **ORIGIN}

    status, _, raw = req("GET", "/admin/api/me.php", cookies=sess)
    me = as_json(raw) or {}
    check("me.php with a session is signed in", status == 200 and me.get("signed_in") is True and me.get("email", "").endswith("@example.com"), f"{status} {raw[:80]!r}")
    check("me.php hex-escapes the name", b"<b>" not in raw and "Test <b>Player</b>" == me.get("name"), raw[:120].decode("utf-8", "replace"))
    check("session rows store only a hash of the token", db.execute("SELECT COUNT(*) FROM sessions WHERE id = ?", (token,)).fetchone()[0] == 0, "")

    status, _, raw = req("GET", "/admin/api/sync.php", cookies=sess)
    check("sync GET for a new player is empty", status == 200 and as_json(raw) == {"data": None, "updated_at": 0}, f"{status} {raw[:80]!r}")

    blob = json.dumps({"v": 1, "archive": {"v": 2, "stamps": {}, "firstDate": ""}, "daily": None, "note": "<script>"})
    status, _, raw = put_json("/admin/api/sync.php", {"data": blob, "base_updated_at": 0}, write, sess)
    first = (as_json(raw) or {}).get("updated_at", 0)
    check("sync PUT stores and bumps updated_at", status == 200 and isinstance(first, int) and first > 0, f"{status} {raw[:80]!r}")

    status, _, raw = put_json("/admin/api/sync.php", {"data": blob, "base_updated_at": first}, write, sess)
    second = (as_json(raw) or {}).get("updated_at", 0)
    check("updated_at strictly increases, even within a second", status == 200 and second > first, f"{first} -> {second}")

    status, _, raw = put_json("/admin/api/sync.php", {"data": json.dumps({"v": 1, "stale": True}), "base_updated_at": first}, write, sess)
    conflict = as_json(raw) or {}
    check("a stale base_updated_at is 409 with the current copy", status == 409 and conflict.get("data") == blob and conflict.get("updated_at") == second, f"{status} {raw[:80]!r}")

    status, _, raw = req("GET", "/admin/api/sync.php", cookies=sess)
    got = as_json(raw) or {}
    check("sync GET returns the stored string as-is", got.get("data") == blob and got.get("updated_at") == second, raw[:80].decode("utf-8", "replace"))
    check("sync GET hex-escapes markup in the blob", b"<script>" not in raw, "")

    status, _, _ = put_json("/admin/api/sync.php", {"data": "{not json", "base_updated_at": second}, write, sess)
    check("sync PUT rejects data that is not JSON", status == 422, str(status))
    status, _, _ = put_json("/admin/api/sync.php", {"data": blob, "base_updated_at": str(second)}, write, sess)
    check("sync PUT rejects a non-integer base", status == 422, str(status))
    status, _, _ = put_json("/admin/api/sync.php", {"data": {"v": 1}, "base_updated_at": second}, write, sess)
    check("sync PUT rejects data that is not a string", status == 422, str(status))
    status, _, _ = put_json("/admin/api/sync.php", big, write, sess)
    check("sync PUT over 256 KB is 413 with a session too", status == 413, str(status))
    exact = {"data": json.dumps({"p": "x" * (262144 - 9)}), "base_updated_at": second}
    status, _, raw = put_json("/admin/api/sync.php", exact, write, sess)
    check("sync PUT of exactly 256 KB is accepted", status == 200 and len(exact["data"]) == 262144, f"{status} {len(exact['data'])}")

    status, _, _ = req("POST", "/admin/api/auth_logout.php", b"", ORIGIN, sess)
    check("logout without X-Lingo-Client is 403", status == 403, str(status))
    status, headers, _ = req("POST", "/admin/api/auth_logout.php", b"", write, sess)
    check("logout is 204 and clears the cookie", status == 204 and "lingo_sess" in set_cookies(headers), str(status))
    status, _, raw = req("GET", "/admin/api/me.php", cookies=sess)
    check("the session is dead after logout", as_json(raw) == {"signed_in": False}, raw[:60].decode())
    check("logout deleted the session row", db.execute("SELECT COUNT(*) FROM sessions WHERE player_id = ?", (pid,)).fetchone()[0] == 0, "")
    check("logout kept the player's data", db.execute("SELECT data_json IS NOT NULL FROM players WHERE id = ?", (pid,)).fetchone()[0] == 1, "")

    old_pid, old_token = seed_player(created_ago=91 * 86400)
    status, _, raw = req("GET", "/admin/api/me.php", cookies={"lingo_sess": old_token})
    check("a session older than 90 days is refused", as_json(raw) == {"signed_in": False}, raw[:60].decode())
    check("an expired session row is deleted on sight", db.execute("SELECT COUNT(*) FROM sessions WHERE player_id = ?", (old_pid,)).fetchone()[0] == 0, "")

    del_pid, del_token = seed_player()
    # Two sessions for the same player: both must go with the row.
    extra = secrets.token_hex(32)
    db.execute("INSERT INTO sessions (id, player_id, created_at, last_seen) VALUES (?, ?, ?, ?)",
               (hashlib.sha256(extra.encode()).hexdigest(), del_pid, int(time.time()), int(time.time())))
    db.commit()
    status, _, _ = req("DELETE", "/admin/api/account.php", headers=ORIGIN, cookies={"lingo_sess": del_token})
    check("account DELETE without X-Lingo-Client is 403 even signed in", status == 403, str(status))
    status, headers, _ = req("DELETE", "/admin/api/account.php", headers=write, cookies={"lingo_sess": del_token})
    check("account DELETE is 204 and clears the cookie", status == 204 and "lingo_sess" in set_cookies(headers), str(status))
    check("account DELETE hard-deletes the player row", db.execute("SELECT COUNT(*) FROM players WHERE id = ?", (del_pid,)).fetchone()[0] == 0, "")
    check("account DELETE cascades to every session", db.execute("SELECT COUNT(*) FROM sessions WHERE player_id = ?", (del_pid,)).fetchone()[0] == 0, "")
    status, _, raw = req("GET", "/admin/api/me.php", cookies={"lingo_sess": extra})
    check("the deleted player's other session is dead", as_json(raw) == {"signed_in": False}, raw[:60].decode())

    rl_pid, rl_token = seed_player()
    codes = [req("GET", "/admin/api/sync.php", cookies={"lingo_sess": rl_token})[0] for _ in range(125)]
    # 125 calls inside a minute put at least 61 into one fixed window.
    check("sync is rate-limited per player (60/min)", 429 in codes, str(sorted(set(codes))))

    db.close()

# --------------------------------------------------------------------------- #
# 7. Rate limits (last: they trip the throttles for this IP)
# --------------------------------------------------------------------------- #
# 25 calls inside a minute put at least 11 into one fixed window.
locations = [req("GET", "/admin/api/auth_start.php")[1].get("Location", "") for _ in range(25)]
check("auth_start is rate-limited (10/min/IP)", any("reason=rate_limited" in l for l in locations), str(sorted({l[:40] for l in locations})))

locations = [req("GET", f"/admin/api/auth_callback.php?code={bogus}&state={'c' * 64}")[1].get("Location", "") for _ in range(25)]
check("auth_callback is rate-limited (10/min/IP)", any("reason=rate_limited" in l for l in locations), str(sorted({l for l in locations})))

# --------------------------------------------------------------------------- #
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
if failed:
    print("FAILED:")
    for name, _, detail in failed:
        print("  -", name, detail)
sys.exit(1 if failed else 0)
