#!/usr/bin/env python3
"""Publish the SRxS website to the GoDaddy host over FTPS.

Run from any machine with Python 3.8+ and FTP access (no extra packages):

    python3 tools/deploy.py --dry-run              # show what would be uploaded
    python3 tools/deploy.py                        # upload every site file
    python3 tools/deploy.py --changed-since 4f0dd93  # only files changed since that commit
    python3 tools/deploy.py --only partners.html contact.php
    python3 tools/deploy.py --restore .deploy-backup/2026-10-11T010203Z

Credentials and settings come from environment variables, or from a file named
.env.deploy in the repository root (ignored by git; see .env.deploy.example):

    SRXS_FTP_HOST=ftp.simplifiedrxsolutions.com
    SRXS_FTP_USER=...
    SRXS_FTP_PASS=...

Optional:

    SRXS_FTP_PORT=21
    SRXS_FTP_TLS=1            0 for plain FTP if the host offers no FTPS
    SRXS_FTP_TLS_VERIFY=1     0 to accept the server certificate without checking it
    SRXS_FTP_CA_FILE=         extra CA bundle used to verify the server certificate
    SRXS_FTP_REMOTE_DIR=      site root on the server; auto-detected when empty
    SRXS_SITE_URL=https://www.simplifiedrxsolutions.com

Every run saves the server's current copy of each file it replaces under
.deploy-backup/<timestamp>/ so a bad publish can be rolled back with --restore.
After uploading, every file is downloaded again and compared byte for byte, and
each uploaded page is requested over HTTPS as a smoke test.
"""
from __future__ import annotations

import argparse
import ftplib
import hashlib
import io
import os
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKUP_ROOT = ROOT / ".deploy-backup"
ENV_FILE = ROOT / ".env.deploy"

# Tracked files that live in the repo but do not belong on the web server.
EXCLUDE_PREFIXES = ("tests/", "tools/", ".")
# Where cPanel and Plesk hosts keep the document root, relative to the FTP login directory.
DOCROOT_CANDIDATES = ("public_html", "httpdocs", "htdocs")

DEFAULTS = {
    "SRXS_FTP_HOST": "ftp.simplifiedrxsolutions.com",
    "SRXS_FTP_PORT": "21",
    "SRXS_FTP_TLS": "1",
    "SRXS_FTP_TLS_VERIFY": "1",
    "SRXS_SITE_URL": "https://www.simplifiedrxsolutions.com",
}


# ── settings ────────────────────────────────────────────────────────────────

def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines into the environment without overriding existing variables."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS.get(name, "")


def truthy(value: str) -> bool:
    return value.strip().lower() not in ("0", "false", "no", "off", "")


def refuse_if_env_file_is_tracked() -> None:
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", ENV_FILE.name],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode == 0:
        fail(f"{ENV_FILE.name} is tracked by git. Remove it from the repository before deploying; it holds credentials.")


# ── file selection ──────────────────────────────────────────────────────────

def git_lines(*args: str) -> list[str]:
    out = subprocess.run(["git", *args, "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def is_site_file(rel: str) -> bool:
    return not rel.startswith(EXCLUDE_PREFIXES)


def all_site_files() -> list[str]:
    return [p for p in git_lines("ls-files") if is_site_file(p)]


def changed_site_files(ref: str) -> list[str]:
    files = [p for p in git_lines("diff", "--name-only", ref, "HEAD") if is_site_file(p)]
    # Deleted files are reported too; nothing to upload for those.
    return [p for p in files if (ROOT / p).is_file()]


def files_under(folder: Path) -> list[str]:
    return sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file())


# ── FTP helpers ─────────────────────────────────────────────────────────────

def connect(host: str, port: int, use_tls: bool, verify: bool, ca_file: str, user: str, password: str) -> ftplib.FTP:
    if use_tls:
        context = ssl.create_default_context(cafile=ca_file or None)
        if not verify:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        ftp: ftplib.FTP = ftplib.FTP_TLS(context=context, timeout=30)
    else:
        ftp = ftplib.FTP(timeout=30)
    try:
        ftp.connect(host, port)
        ftp.login(user, password)  # FTP_TLS.login negotiates AUTH TLS first
        if use_tls:
            ftp.prot_p()  # encrypt the data channel as well
    except socket.gaierror:
        fail(f"Could not resolve FTP host {host!r}. Check SRXS_FTP_HOST; GoDaddy shows the FTP host in cPanel under FTP Accounts.")
    except ssl.SSLCertVerificationError as exc:
        fail(
            f"The server's TLS certificate did not verify: {str(exc.verify_message).rstrip('.')}.\n"
            "  Shared hosts often present a certificate for the server's own hostname rather than your domain.\n"
            "  Either set SRXS_FTP_HOST to the hostname shown in cPanel, provide its CA with SRXS_FTP_CA_FILE,\n"
            "  or set SRXS_FTP_TLS_VERIFY=0 to connect encrypted without checking the certificate name."
        )
    except ssl.SSLError as exc:
        fail(f"TLS handshake failed: {exc}. If this host offers no FTPS, set SRXS_FTP_TLS=0 to use plain FTP.")
    except ftplib.error_perm as exc:
        text = str(exc)
        if text.startswith("530"):
            fail("The FTP server rejected the username or password.")
        if use_tls and ("AUTH" in text or text.startswith("500") or text.startswith("502")):
            fail(f"The server does not accept AUTH TLS ({text}). Set SRXS_FTP_TLS=0 to use plain FTP.")
        fail(f"FTP error while connecting: {text}")
    except (ConnectionRefusedError, socket.timeout, OSError) as exc:
        fail(f"Could not connect to {host}:{port}: {exc}")
    ftp.set_pasv(True)
    return ftp


def choose_remote_dir(ftp: ftplib.FTP, configured: str) -> str:
    if configured:
        try:
            ftp.cwd(configured)
        except ftplib.error_perm:
            fail(f"SRXS_FTP_REMOTE_DIR={configured!r} does not exist on the server.")
        return ftp.pwd()
    for candidate in DOCROOT_CANDIDATES:
        try:
            ftp.cwd(candidate)
            return ftp.pwd()
        except ftplib.error_perm:
            continue
    return ftp.pwd()


def remote_join(base: str, rel: str) -> str:
    return base.rstrip("/") + "/" + rel


def ensure_remote_dirs(ftp: ftplib.FTP, base: str, rel_file: str, made: set) -> None:
    parts = rel_file.split("/")[:-1]
    path = ""
    for part in parts:
        path = f"{path}/{part}" if path else part
        if path in made:
            continue
        try:
            ftp.cwd(remote_join(base, path))
        except ftplib.error_perm:
            ftp.mkd(remote_join(base, path))
        made.add(path)
    ftp.cwd(base)


def download(ftp: ftplib.FTP, remote_path: str) -> bytes | None:
    buf = io.BytesIO()
    try:
        ftp.retrbinary(f"RETR {remote_path}", buf.write)
    except ftplib.error_perm as exc:
        if str(exc).startswith("550"):
            return None  # does not exist yet
        raise
    return buf.getvalue()


def upload(ftp: ftplib.FTP, local: Path, remote_path: str) -> None:
    with local.open("rb") as fh:
        ftp.storbinary(f"STOR {remote_path}", fh)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def human(n: int) -> str:
    return f"{n / 1024:.0f} KB" if n < 1024 * 1024 else f"{n / 1024 / 1024:.1f} MB"


# ── smoke test ──────────────────────────────────────────────────────────────

def smoke_test(site_url: str, pages: list[str]) -> list[str]:
    problems = []
    for rel in pages:
        url = site_url.rstrip("/") + "/" + rel
        req = urllib.request.Request(url, headers={"User-Agent": "srxs-deploy/1.0", "Cache-Control": "no-cache"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                status = resp.status
        except urllib.error.HTTPError as exc:
            status = exc.code
        except (urllib.error.URLError, socket.timeout) as exc:
            problems.append(f"{url}: {exc}")
            print(f"  smoke  {rel}: unreachable ({exc})")
            continue
        mark = "ok " if status == 200 else "!! "
        print(f"  smoke  {mark}{rel}: HTTP {status}")
        if status != 200:
            problems.append(f"{url}: HTTP {status}")
    return problems


# ── main ────────────────────────────────────────────────────────────────────

def fail(message: str, code: int = 1) -> None:
    print(f"\nerror: {message}", file=sys.stderr)
    sys.exit(code)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload the SRxS website to the GoDaddy host over FTPS.")
    what = parser.add_mutually_exclusive_group()
    what.add_argument("--changed-since", metavar="REF", help="upload only tracked files changed between REF and HEAD")
    what.add_argument("--only", nargs="+", metavar="PATH", help="upload only these repository paths")
    what.add_argument("--restore", metavar="DIR", help="re-upload every file saved under a .deploy-backup folder")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and exit without connecting")
    parser.add_argument("--no-backup", action="store_true", help="do not save the server's current copies first")
    parser.add_argument("--no-verify", action="store_true", help="skip downloading each file again to compare")
    parser.add_argument("--no-smoke", action="store_true", help="skip the HTTPS request for each uploaded page")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    load_env_file(ENV_FILE)

    # What to upload, and from where.
    source_root = ROOT
    if args.restore:
        source_root = Path(args.restore).resolve()
        if not source_root.is_dir():
            fail(f"{args.restore} is not a folder.")
        files = files_under(source_root)
        try:
            shown = source_root.relative_to(ROOT)
        except ValueError:  # backup folder kept somewhere outside the repo
            shown = source_root
        mode = f"restore from {shown}"
    elif args.only:
        files = []
        for rel in args.only:
            rel = Path(rel).as_posix()
            if not (ROOT / rel).is_file():
                fail(f"{rel} does not exist in the repository.")
            if not is_site_file(rel):
                fail(f"{rel} is not a site file (tests/, tools/ and dotfiles stay out of the upload).")
            files.append(rel)
        mode = "selected files"
    elif args.changed_since:
        files = changed_site_files(args.changed_since)
        mode = f"files changed since {args.changed_since}"
    else:
        files = all_site_files()
        mode = "every site file"
    if not files:
        print("Nothing to upload.")
        return

    host = setting("SRXS_FTP_HOST")
    port = int(setting("SRXS_FTP_PORT"))
    use_tls = truthy(setting("SRXS_FTP_TLS"))
    verify = truthy(setting("SRXS_FTP_TLS_VERIFY"))
    ca_file = setting("SRXS_FTP_CA_FILE")
    remote_dir_setting = setting("SRXS_FTP_REMOTE_DIR")
    site_url = setting("SRXS_SITE_URL")
    user = setting("SRXS_FTP_USER")
    password = setting("SRXS_FTP_PASS")

    total = sum((source_root / f).stat().st_size for f in files)
    print(f"Publishing {mode}: {len(files)} file(s), {human(total)}")
    print(f"  host     {host}:{port}  ({'FTPS' if use_tls else 'plain FTP'}{'' if verify or not use_tls else ', certificate not verified'})")
    print(f"  user     {user or '(not set)'}")
    print(f"  root     {remote_dir_setting or '(auto-detect)'}")
    for rel in files:
        print(f"    {rel}  ({human((source_root / rel).stat().st_size)})")
    if args.dry_run:
        print("\nDry run only; nothing was uploaded.")
        return

    refuse_if_env_file_is_tracked()
    if not user or not password:
        fail("SRXS_FTP_USER and SRXS_FTP_PASS are not set. Put them in .env.deploy (see .env.deploy.example) or export them.")
    if not use_tls:
        print("\n  note: plain FTP sends the password unencrypted. Prefer FTPS where the host supports it.")

    print(f"\nConnecting to {host} ...")
    ftp = connect(host, port, use_tls, verify, ca_file, user, password)
    base = choose_remote_dir(ftp, remote_dir_setting)
    print(f"  logged in; site root on server: {base}")

    # Back up what is about to be replaced.
    backup_dir = None
    if not args.no_backup:
        backup_dir = BACKUP_ROOT / time.strftime("%Y-%m-%dT%H%M%SZ", time.gmtime())
        saved = 0
        for rel in files:
            existing = download(ftp, remote_join(base, rel))
            if existing is None:
                continue
            target = backup_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(existing)
            saved += 1
        if saved:
            print(f"  saved {saved} current file(s) to {backup_dir.relative_to(ROOT)}")
        else:
            print("  nothing to back up (all files are new on the server)")

    # Upload.
    made: set = set()
    for i, rel in enumerate(files, 1):
        ensure_remote_dirs(ftp, base, rel, made)
        upload(ftp, source_root / rel, remote_join(base, rel))
        print(f"  upload {i:>2}/{len(files)}  {rel}")

    # Verify by reading every file back.
    mismatched: list[str] = []
    if not args.no_verify:
        for rel in files:
            remote = download(ftp, remote_join(base, rel))
            local = (source_root / rel).read_bytes()
            if remote is None or sha256(remote) != sha256(local):
                mismatched.append(rel)
        if mismatched:
            print("  verify !! these files do not match what was sent: " + ", ".join(mismatched))
        else:
            print(f"  verify ok  all {len(files)} file(s) read back identical")
    ftp.quit()

    # Smoke-test the pages over HTTPS.
    problems: list[str] = []
    if not args.no_smoke and not args.restore:
        pages = [f for f in files if f.endswith(".html")][:20]
        if pages:
            print(f"\nChecking pages at {site_url} ...")
            problems = smoke_test(site_url, pages)

    print()
    if mismatched:
        fail("Upload finished but verification failed for some files; re-run for those with --only.", code=2)
    if problems:
        print("Upload verified, but some pages did not return HTTP 200. A CDN or cache may lag a few minutes; "
              "if it persists, check the paths and the server's document root.")
        sys.exit(2)
    print("Done. " + (f"To roll back: python3 tools/deploy.py --restore {backup_dir.relative_to(ROOT)}" if backup_dir and backup_dir.exists() else ""))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        fail("Interrupted.", code=130)
    except BrokenPipeError:  # output piped into head or similar; nothing to report
        sys.exit(0)
    except subprocess.CalledProcessError as exc:
        fail(f"git command failed: {exc}")
