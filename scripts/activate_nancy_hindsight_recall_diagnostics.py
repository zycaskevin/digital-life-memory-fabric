#!/usr/bin/env python3
"""Read-only Nancy DLMF/Hindsight rejection classifier deployment.

Only an exact reviewed compiled JS module is updated, with byte-preserving
rollback. Never edits canonical memory, PostgreSQL, other life scopes, Hindsight,
the host secret env or existing DLMF owning source modifications.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[1]
LIVE = Path("/srv/workspace/dlmf-qwen-ab")
MODULE = Path("dist/retrieval/hindsight-canonical-projection.js")
OWNER_SOURCE = Path("src/retrieval/hindsight-canonical-projection.ts")
BACKUPS = Path.home() / ".local/state/digital-life/nancy-resident/dlmf-recall-diagnostics-backups"
LIFE_DID = "did:arthurverse:nancy"
EXPECTED_HEAD = "2f663c715d1b5dd930b26f9997493b589cdbd37c"
EXPECTED_LIVE_MODULE_SHA256 = "31a28ebd14de5d89ab1d829d49f502b90a9bbc847cad9a365bdef60d36746c35"
EXPECTED_LIVE_SOURCE_SHA256 = "a2dee0dec914422fb491259c1c486268149efa8473a3d7d0f304333bcca0920b"
UNIT = "digital-life-dl-nancy-memory-dlmf.service"


def run(argv: list[str], timeout: int = 40) -> subprocess.CompletedProcess:
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=timeout)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def private_regular(path: Path, *, source: bool = False) -> tuple[bytes, int]:
    if path.is_symlink():
        raise RuntimeError("cannot_replace_symlink")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        mode = stat.S_IMODE(info.st_mode)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or info.st_nlink != 1
                or (source and (mode & 0o022))):
            raise RuntimeError("live_module_owner_or_type_invalid")
        return os.read(fd, max(300000, info.st_size + 1)), mode
    finally:
        os.close(fd)


def atomic(path: Path, raw: bytes, mode: int) -> None:
    fd, temp = tempfile.mkstemp(prefix=".dlmf-recall-diagnostic-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def http_json(port: int, path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
        if response.status != 200:
            raise RuntimeError("readiness_http_not_200")
        value = json.loads(response.read(25000))
        if not isinstance(value, dict):
            raise RuntimeError("readiness_non_object")
        return value


def verified_ready() -> None:
    ready = http_json(19006, "/ready")
    if (ready.get("ok") is not True or ready.get("schemaState") != "current-0009"
            or ready.get("scopeBound") is not True
            or (ready.get("scope") or {}).get("lifeDid") != LIFE_DID):
        raise RuntimeError("nancy_dlmf_ingress_not_scoped_and_ready")
    health = http_json(18888, "/health")
    if health.get("status") != "healthy":
        raise RuntimeError("hindsight_not_healthy")


def preflight() -> tuple[bytes, int, bytes, int, bytes]:
    if run(["git", "-C", str(LIVE), "rev-parse", "HEAD"]).stdout.strip() != EXPECTED_HEAD:
        raise RuntimeError("DLMF_owner_source_head_changed")
    owner_bytes, owner_mode = private_regular(LIVE / OWNER_SOURCE, source=True)
    if sha(owner_bytes) != EXPECTED_LIVE_SOURCE_SHA256:
        raise RuntimeError("DLMF_owning_source_changed")
    compiled, mode = private_regular(LIVE / MODULE)
    if sha(compiled) != EXPECTED_LIVE_MODULE_SHA256:
        raise RuntimeError("installed_dlmf_module_changed")
    candidate, _ = private_regular(REPO / MODULE)
    if candidate == compiled or b"DLMF_HINDSIGHT_RECALL_REJECTED" not in candidate:
        raise RuntimeError("reviewed_candidate_missing_or_uncompiled")
    run(["node", "--check", str(REPO / MODULE)], timeout=15)
    if run(["systemctl", "--user", "is-active", UNIT]).stdout.strip() != "active":
        raise RuntimeError("current_dlmf_unit_not_active")
    verified_ready()
    return compiled, mode, candidate, owner_mode, owner_bytes


def restart_and_verify() -> None:
    run(["systemctl", "--user", "restart", UNIT], timeout=65)
    last: Exception | None = None
    for _ in range(55):
        try:
            if run(["systemctl", "--user", "is-active", UNIT]).stdout.strip() != "active":
                raise RuntimeError("dlmf_unit_not_active")
            verified_ready()
            return
        except Exception as e:
            last = e
            time.sleep(0.5)
    raise RuntimeError("dlmf_diagnostics_restart_readiness_failed") from last


def main() -> None:
    p = argparse.ArgumentParser()
    group = p.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true")
    group.add_argument("--apply", action="store_true")
    args = p.parse_args()
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (BACKUPS.is_symlink()
            or BACKUPS.stat().st_uid != os.geteuid()
            or BACKUPS.stat().st_mode & 0o077):
        raise RuntimeError("private_backup_root_untrusted")
    with (BACKUPS / ".deploy.lock").open("a+b") as lock:
        os.chmod(BACKUPS / ".deploy.lock", 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        before, mode, candidate, _, original_source = preflight()
        if not args.apply:
            print(json.dumps({
                "status": "DLMF_HINDSIGHT_RECALL_DIAGNOSTICS_READY",
                "scope": LIFE_DID,
                "changedFiles": [str(MODULE)],
                "canonicalWrite": False,
                "servicesRestarted": False,
            }))
            return

        folder = BACKUPS / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        folder.mkdir(mode=0o700)
        atomic(folder / "original-module.bak", before, 0o600)
        atomic(folder / "manifest.json", json.dumps({
            "expectedDlmfHead": EXPECTED_HEAD,
            "originalJsSha256": sha(before),
            "originalSourceSha256": sha(original_source),
            "candidateJsSha256": sha(candidate),
        }, sort_keys=True).encode(), 0o600)
        deployed = False
        try:
            if (private_regular(LIVE / MODULE)[0] != before
                    or private_regular(LIVE / OWNER_SOURCE, source=True)[0] != original_source):
                raise RuntimeError("concurrent_dlmf_writer_detected")
            deployed = True
            atomic(LIVE / MODULE, candidate, mode)
            restart_and_verify()
            if private_regular(LIVE / MODULE)[0] != candidate:
                raise RuntimeError("compiled_module_activation_drift")
            print(json.dumps({
                "status": "DLMF_HINDSIGHT_RECALL_DIAGNOSTICS_ACTIVE",
                "scope": LIFE_DID,
                "rollbackBackup": str(folder),
                "canonicalWrite": False,
                "HindsightChanged": False,
                "dlmfReady": True,
            }))
        except Exception:
            if deployed:
                atomic(LIVE / MODULE, before, mode)
                restart_and_verify()
                print("DLMF_RECALL_DIAGNOSTICS_ROLLBACK=PASS")
            raise


if __name__ == "__main__":
    main()
