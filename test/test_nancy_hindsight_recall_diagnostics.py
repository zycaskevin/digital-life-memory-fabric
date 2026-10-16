"""Bounded read-only Nancy Hindsight diagnostic rollout contract tests."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import activate_nancy_hindsight_recall_diagnostics as deploy


def _fixture(tmp_path, monkeypatch):
    repo = tmp_path / "candidate"
    live = tmp_path / "installed"
    backup = tmp_path / "backups"
    for root in (repo, live):
        (root / deploy.MODULE).parent.mkdir(parents=True, exist_ok=True)
        (root / deploy.OWNER_SOURCE).parent.mkdir(parents=True, exist_ok=True)
    original = b"// original clean Hindsight JS module\n"
    candidate = b"// DLMF_HINDSIGHT_RECALL_REJECTED sanitized diagnostic only\n"
    owner_source = b"// immutable owner source code\n"
    (live / deploy.MODULE).write_bytes(original)
    (repo / deploy.MODULE).write_bytes(candidate)
    (live / deploy.OWNER_SOURCE).write_bytes(owner_source)
    for part in (live / deploy.MODULE, live / deploy.OWNER_SOURCE, repo / deploy.MODULE):
        part.chmod(0o600)
    monkeypatch.setattr(deploy, "LIVE", live)
    monkeypatch.setattr(deploy, "REPO", repo)
    monkeypatch.setattr(deploy, "BACKUPS", backup)
    monkeypatch.setattr(deploy, "EXPECTED_LIVE_MODULE_SHA256", deploy.sha(original))
    monkeypatch.setattr(deploy, "EXPECTED_LIVE_SOURCE_SHA256", deploy.sha(owner_source))

    def fake_run(argv, timeout=40):
        if argv[:3] == ["git", "-C", str(live)]:
            return subprocess.CompletedProcess(argv, 0, deploy.EXPECTED_HEAD + "\n", "")
        if argv[:3] == ["node", "--check", str(repo / deploy.MODULE)]:
            return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[:4] == ["systemctl", "--user", "is-active", deploy.UNIT]:
            return subprocess.CompletedProcess(argv, 0, "active\n", "")
        raise AssertionError(f"Unexpected system command: {argv[:3]}")

    monkeypatch.setattr(deploy, "run", fake_run)
    monkeypatch.setattr(deploy, "verified_ready", lambda: None)
    return repo, live, backup, original, candidate, owner_source


def test_preflight_cannot_write_or_restart(tmp_path, monkeypatch, capsys):
    _, live, backup, original, _, source = _fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(sys, "argv", ["activate_nancy_hindsight_recall_diagnostics.py", "--check"])
    monkeypatch.setattr(deploy, "restart_and_verify", lambda: pytest.fail("preflight restarted service"))
    deploy.main()
    value = json.loads(capsys.readouterr().out)
    assert value["status"] == "DLMF_HINDSIGHT_RECALL_DIAGNOSTICS_READY"
    assert value["canonicalWrite"] is False and value["servicesRestarted"] is False
    assert (live / deploy.MODULE).read_bytes() == original
    assert (live / deploy.OWNER_SOURCE).read_bytes() == source
    assert not list(backup.glob("*/original-module.bak"))


def test_scoped_activation_updates_only_one_compiled_module(tmp_path, monkeypatch, capsys):
    _, live, backup, _, candidate, source = _fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(sys, "argv", ["activate_nancy_hindsight_recall_diagnostics.py", "--apply"])
    runs = []
    monkeypatch.setattr(deploy, "restart_and_verify", lambda: runs.append("restart_and_verify"))
    deploy.main()
    value = json.loads(capsys.readouterr().out)
    assert value["status"] == "DLMF_HINDSIGHT_RECALL_DIAGNOSTICS_ACTIVE"
    assert value["canonicalWrite"] is False and value["HindsightChanged"] is False
    assert runs == ["restart_and_verify"]
    assert (live / deploy.MODULE).read_bytes() == candidate
    assert (live / deploy.OWNER_SOURCE).read_bytes() == source
    assert len(list(backup.glob("*/original-module.bak"))) == 1


def test_failed_activation_restores_original_byte_for_byte(tmp_path, monkeypatch):
    _, live, backup, original, _, source = _fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(sys, "argv", ["activate_nancy_hindsight_recall_diagnostics.py", "--apply"])
    counter = []

    def restart():
        counter.append("restart")
        if len(counter) == 1:
            raise RuntimeError("test_readiness_unavailable")

    monkeypatch.setattr(deploy, "restart_and_verify", restart)
    with pytest.raises(RuntimeError, match="test_readiness_unavailable"):
        deploy.main()
    assert len(counter) == 2
    assert (live / deploy.MODULE).read_bytes() == original
    assert (live / deploy.OWNER_SOURCE).read_bytes() == source
    assert len(list(backup.glob("*/original-module.bak"))) == 1


def test_preflight_refuses_concurrent_owner_source_mutation(tmp_path, monkeypatch):
    _, live, _, original, _, _ = _fixture(tmp_path, monkeypatch)
    (live / deploy.OWNER_SOURCE).write_bytes(b"another writer touched the owning file")
    with pytest.raises(RuntimeError, match="DLMF_owning_source_changed"):
        deploy.preflight()
    assert (live / deploy.MODULE).read_bytes() == original
