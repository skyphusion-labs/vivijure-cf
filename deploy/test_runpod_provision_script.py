"""scripts/runpod-provision.py on RunPod REST v2 (fleet-chezmoi#2085). No live calls: `call` is
replaced with a recorder, so these prove the request shape and the decision path only."""
import importlib.util
import pathlib
import sys

import pytest

_PATH = pathlib.Path(__file__).parent.parent / "scripts" / "runpod-provision.py"
_SPEC = importlib.util.spec_from_file_location("runpod_provision_script", _PATH)
rp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rp)

ENV = {"RUNPOD_API_KEY": "rp-key", "CLOUDFLARE_ACCOUNT_ID": "acct",
       "R2_S3_ACCESS_KEY_ID": "ak", "R2_S3_SECRET_ACCESS_KEY": "sk"}


def _run(monkeypatch, argv, pages, post_reply=(201, {"id": "ep-new"})):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    calls = []

    def fake(key, method, path, body=None):
        calls.append((method, path, body))
        if method == "GET":
            return 200, pages[sum(1 for m, _, _ in calls if m == "GET") - 1]
        return post_reply

    monkeypatch.setattr(rp, "call", fake)
    monkeypatch.setattr(sys, "argv", ["runpod-provision.py", *argv])
    rp.main()
    return calls


def test_fresh_backend_is_one_list_and_one_v2_create(monkeypatch, capsys):
    calls = _run(monkeypatch, [], [{"items": [], "pagination": {"hasNextPage": False}}])
    assert [(m, p) for m, p, _ in calls] == [("GET", "/serverless?limit=1000"), ("POST", "/serverless")]
    body = calls[1][2]
    assert body["type"] == "QUEUE"
    assert body["image"] == rp.DEFAULT_IMAGE
    assert body["gpu"] == {"pools": ["HOPPER_141", "BLACKWELL_180"], "count": 1}
    assert body["workers"] == {"min": 0, "max": 1, "idleTimeout": 5}
    assert body["scaling"] == {"type": "QUEUE_DELAY", "queueDelay": 4}
    assert body["timeout"] == 3600000 and body["disk"] == 20
    assert body["env"]["R2_ENDPOINT"] == "https://acct.r2.cloudflarestorage.com"
    assert "templateId" not in body
    assert capsys.readouterr().out.strip().endswith("RUNPOD_ENDPOINT_ID=ep-new")


def test_satellite_env_uses_the_satellite_names(monkeypatch):
    calls = _run(monkeypatch, ["--satellite", "upscale"], [[]])
    body = calls[-1][2]
    assert body["name"] == "vivijure-upscale"
    assert body["env"]["R2_ENDPOINT_URL"] == "https://acct.r2.cloudflarestorage.com"


def test_an_existing_endpoint_on_page_two_is_reused_with_no_write(monkeypatch, capsys):
    calls = _run(monkeypatch, [], [
        {"items": [{"name": "x", "id": "1"}], "pagination": {"hasNextPage": True, "nextCursor": "p2"}},
        {"items": [{"name": "vivijure-backend", "id": "ep-7"}], "pagination": {"hasNextPage": False}},
    ])
    assert [m for m, _, _ in calls] == ["GET", "GET"]
    assert calls[1][1] == "/serverless?limit=1000&cursor=p2"
    assert capsys.readouterr().out.strip().endswith("RUNPOD_ENDPOINT_ID=ep-7")


def test_more_pages_without_a_cursor_stops_before_any_write(monkeypatch):
    with pytest.raises(SystemExit):
        _run(monkeypatch, [], [{"items": [], "pagination": {"hasNextPage": True}}])


def test_gpu_pools_flag_wins_and_an_unmapped_type_stops_first(monkeypatch):
    calls = _run(monkeypatch, ["--gpu-pools", "BLACKWELL_96"], [[]])
    assert calls[-1][2]["gpu"]["pools"] == ["BLACKWELL_96"]
    with pytest.raises(SystemExit):
        _run(monkeypatch, ["--gpu-types", "NVIDIA Z9"], [[]])
