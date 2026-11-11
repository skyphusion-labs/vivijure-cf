"""Unit tests for the RunPod provisioning shape (#676/#677/#678). No live provider calls -- rp_reconcile
is monkeypatched to capture the create bodies."""
import importlib.util
import pathlib
import sys

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "vivijure_deploy", pathlib.Path(__file__).parent / "vivijure_deploy.py")
vd = importlib.util.module_from_spec(_SPEC)
sys.modules["vivijure_deploy"] = vd
_SPEC.loader.exec_module(vd)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _capture_reconcile(calls):
    def fake(*, kind, key, list_path, create_path, create_body, name,
             name_key="name", id_key="id", known_id=None):
        calls.append((kind, name, create_body))
        return vd.ReconcileResult(f"{name}-id", adopted=False)
    return fake


def test_runpod_images_cover_every_endpoint():
    imgs = vd.runpod_images()
    assert set(imgs) == set(vd.RUNPOD_ENDPOINTS)
    for ep, (image, tag) in imgs.items():
        assert image.startswith("ghcr.io/skyphusion-labs/"), ep
        assert tag and tag != "latest", ep
        assert tag[0].isdigit(), f"{ep}: tag must be bare semver, not a v-prefixed git tag ({tag!r})"


def test_provision_runpod_v2_endpoint_carries_image_env_and_pools_no_template(repo, monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", ["NVIDIA H100 80GB HBM3", "NVIDIA H200"])
    calls = []
    monkeypatch.setattr(vd, "rp_reconcile", _capture_reconcile(calls))
    st = vd.State.load(repo)
    s = vd.Secrets("acct", "cf-tok", "rp-key")
    cf = {"R2_S3_ACCESS_KEY_ID": "ak", "R2_S3_SECRET_ACCESS_KEY": "sk",
          "R2_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com"}

    eps = vd.provision_runpod(repo, s, st, cf)

    assert set(eps) == {"vivijure-backend", "vivijure-upscale"}
    # v2: no template and no network volume, only endpoints
    assert {kind for kind, _, _ in calls} == {"endpoint"}
    endpoints = {name: body for kind, name, body in calls}
    for ep, body in endpoints.items():
        assert body["type"] == "QUEUE", ep
        assert body["gpu"] == {"pools": ["ADA_80_PRO", "HOPPER_141"], "count": 1}, ep
        assert body["workers"]["min"] == 0, ep
        assert body["scaling"]["type"] == "QUEUE_DELAY", ep
        assert body["timeout"] == vd.EXECUTION_TIMEOUT_MS, ep
        assert body["env"]["R2_S3_ACCESS_KEY_ID"] == "ak", ep
        assert "templateId" not in body and "networkVolumeId" not in body, ep
        assert "registry" not in body, ep  # public GHCR image: the blank-auth gotcha
    # each satellite runs its OWN image (#678)
    assert endpoints["vivijure-upscale"]["image"].startswith("ghcr.io/skyphusion-labs/vivijure-upscale:")
    assert endpoints["vivijure-backend"]["image"].startswith("ghcr.io/skyphusion-labs/vivijure-backend:")
    assert st.resource_id("runpod_volume_vivijure-backend") is None
    assert st.resource_id("runpod_template_vivijure-backend") is None


def test_gpu_pools_wins_over_type_ids(monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", ["NVIDIA H200"])
    monkeypatch.setattr(vd, "GPU_POOLS", ["BLACKWELL_96"])
    assert vd.rp_gpu_pools() == ["BLACKWELL_96"]


def test_unmapped_gpu_type_dies(monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", ["NVIDIA Z9"])
    monkeypatch.setattr(vd, "GPU_POOLS", [])
    with pytest.raises(SystemExit):
        vd.rp_gpu_pools()


def _pages(pages, seen):
    def fake(method, path, key, body=None, *, raise_on_error=False):
        seen.append((method, path))
        return pages[len(seen) - 1]
    return fake


def test_rp_list_all_walks_every_page(monkeypatch):
    seen = []
    monkeypatch.setattr(vd, "rp_api", _pages([
        {"items": [{"id": "a"}], "pagination": {"hasNextPage": True, "nextCursor": "c/2"}},
        {"items": [{"id": "b"}], "pagination": {"hasNextPage": False}},
    ], seen))
    assert [i["id"] for i in vd.rp_list_all("/serverless", "k")] == ["a", "b"]
    assert seen == [("GET", "/serverless?limit=1000"), ("GET", "/serverless?limit=1000&cursor=c%2F2")]


def test_rp_list_all_refuses_more_pages_without_a_cursor(monkeypatch):
    monkeypatch.setattr(vd, "rp_api", _pages([{"items": [], "pagination": {"hasNextPage": True}}], []))
    with pytest.raises(SystemExit):
        vd.rp_list_all("/serverless", "k")


def test_reconcile_finds_a_same_name_endpoint_on_a_later_page(monkeypatch):
    seen = []
    monkeypatch.setattr(vd, "_ADOPT", False)
    monkeypatch.setattr(vd, "rp_api", _pages([
        {"items": [{"name": "other", "id": "x"}], "pagination": {"hasNextPage": True, "nextCursor": "p2"}},
        {"items": [{"name": "vivijure-backend", "id": "ep-9"}], "pagination": {"hasNextPage": False}},
    ], seen))
    res = vd.rp_reconcile(kind="endpoint", key="k", list_path="/serverless", create_path="/serverless",
                          create_body={"name": "vivijure-backend"}, name="vivijure-backend", known_id="ep-9")
    assert res.rid == "ep-9"
    assert not any(m == "POST" for m, _ in seen)


def test_down_uses_v2_paths_and_still_deletes_a_legacy_template(repo, monkeypatch):
    st = vd.State.load(repo)
    st.put_resource("runpod_endpoint_vivijure-backend", "ep-1", adopted=False)
    st.put_resource("runpod_volume_vivijure-backend", "vol-1", adopted=False)
    st.put_resource("runpod_template_vivijure-backend", "tpl-1", adopted=False)
    deleted = []
    monkeypatch.setattr(vd, "rp_api", lambda m, p, k, b=None, **kw: deleted.append((m, p)) or {})
    monkeypatch.setattr(vd, "module_dirs", lambda _r: [])
    monkeypatch.setattr(vd, "wrangler_delete_tolerant", lambda *a, **k: None)
    monkeypatch.setattr(vd, "collect_secrets", lambda **_: vd.Secrets("a", "c", "r"))
    monkeypatch.setattr(vd, "bind_state_to_account", lambda *a, **k: None)
    monkeypatch.setattr(vd, "cf_api", lambda *a, **k: [])
    try:
        vd.cmd_down(repo, delete_data=False, noninteractive=True)
    except SystemExit:
        pass  # the CF half is not under test here; the RunPod half runs first
    assert deleted[:3] == [("DELETE", "/serverless/ep-1"), ("DELETE", "/network-volumes/vol-1"),
                           ("DELETE", "/templates/tpl-1")]


def test_no_deploy_code_names_the_v1_host():
    host = "rest." + "runpod.io"
    root = pathlib.Path(__file__).parent.parent
    for f in [root / "deploy/vivijure_deploy.py", root / "scripts/runpod-provision.py"]:
        assert host not in f.read_text(), f


def test_provision_runpod_missing_gpu_dies(repo, monkeypatch):
    monkeypatch.setattr(vd, "GPU_TYPE_IDS", [])
    monkeypatch.setattr(vd, "GPU_POOLS", [])
    monkeypatch.setattr(vd, "rp_reconcile", _capture_reconcile([]))
    st = vd.State.load(repo)
    s = vd.Secrets("a", "c", "r")
    with pytest.raises(SystemExit):
        vd.provision_runpod(repo, s, st, {"R2_S3_ACCESS_KEY_ID": "ak"})


def test_provision_runpod_unpinned_tag_dies(repo, monkeypatch):
    monkeypatch.setattr(vd, "GPU_POOLS", ["ADA_24"])
    monkeypatch.setattr(vd, "UPSCALE_IMAGE_TAG", "latest")
    monkeypatch.setattr(vd, "rp_reconcile", _capture_reconcile([]))
    st = vd.State.load(repo)
    s = vd.Secrets("a", "c", "r")
    with pytest.raises(SystemExit):
        vd.provision_runpod(repo, s, st, {"R2_S3_ACCESS_KEY_ID": "ak"})
