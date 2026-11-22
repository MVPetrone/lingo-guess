#!/usr/bin/env python3
"""
Builds a throwaway local install for the live suites (test_admin.py, test_auth.py).

    python3 tests/security/local_site.py /tmp/lingo-local 8099
    php -S 127.0.0.1:8099 -t /tmp/lingo-local/public_html
    ADMIN_PASS_FILE=/tmp/lingo-local/admin-pass python3 tests/security/test_admin.py http://127.0.0.1:8099
    STORAGE_DIR=/tmp/lingo-local/storage python3 tests/security/test_auth.py http://127.0.0.1:8099

The Google keys written here are obvious placeholders, never real credentials:
enough for auth_start to build a redirect and for the callback to fail closed.
"""
from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

site = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/lingo-local")
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8099
webroot = os.path.join(site, "public_html")
storage = os.path.join(site, "storage")

shutil.rmtree(site, ignore_errors=True)
os.makedirs(webroot)
os.makedirs(storage, mode=0o700)
shutil.copytree(os.path.join(ROOT, "server", "admin"), os.path.join(webroot, "admin"))

config = {
    "app_secret": secrets.token_hex(32),
    "installed_at": 0,
    "installed_by": "admin",
    "canonical_origin": f"http://127.0.0.1:{port}",
    "google_client_id": "000000000000-localplaceholder000000.apps.googleusercontent.com",
    "google_client_secret": "LOCAL-PLACEHOLDER-NOT-A-SECRET",
}
with open(os.path.join(storage, "config.php"), "w") as fh:
    fh.write("<?php\n// Local test install. Placeholder keys only.\nreturn [\n")
    for key, value in config.items():
        fh.write(f"  {key!r} => {value!r},\n" if isinstance(value, str) else f"  {key!r} => {value},\n")
    fh.write("];\n")
os.chmod(os.path.join(storage, "config.php"), 0o600)

password = "Local-" + secrets.token_urlsafe(18)
pass_file = os.path.join(site, "admin-pass")
with open(pass_file, "w") as fh:
    fh.write(password)
os.chmod(pass_file, 0o600)

php = (
    '$_SERVER["SCRIPT_FILENAME"] = "cli";'
    f'require {os.path.join(webroot, "admin", "lib", "bootstrap.php")!r};'
    'db()->prepare("INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)")'
    '->execute(["admin", password_hash(getenv("LOCAL_ADMIN_PASS"), PASSWORD_BCRYPT, ["cost" => 12]), time()]);'
)
subprocess.run(["php", "-r", php], check=True, env={**os.environ, "LOCAL_ADMIN_PASS": password})

print(f"site     {webroot}")
print(f"storage  {storage}")
print(f"password {pass_file}")
print(f"serve    php -S 127.0.0.1:{port} -t {webroot}")
