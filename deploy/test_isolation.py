"""Unit tests for the #244 installer live-fixes + isolation seam: DEPLOY_PREFIX name derivation, the
pure core/module toml renders (base-install, media-less), the no-silent-adopt guard, and the
partial-safe teardown delete. Pure/mocked -- NO live provider calls.

Run: python3 -m pytest deploy/test_isolation.py
"""
import importlib.util
import pathlib
import sys

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "vivijure_deploy", pathlib.Path(__file__).parent / "vivijure_deploy.py")
vd = importlib.util.module_from_spec(_SPEC)
sys.modules["vivijure_deploy"] = vd  # so dataclass module lookup resolves
_SPEC.loader.exec_module(vd)


@pytest.fixture(autouse=True)
def _reset():
    p, a = vd.DEPLOY_PREFIX, vd._ADOPT
    vd.DEPLOY_PREFIX, vd._ADOPT = "", False
    yield
    vd.DEPLOY_PREFIX, vd._ADOPT = p, a


# --- prefixed() + state_file_name() ----------------------------------------------------------------

def test_prefixed_empty_is_verbatim():
    assert vd.prefixed("vivijure-studio") == "vivijure-studio"


def test_prefixed_applies_when_set():
    vd.DEPLOY_PREFIX = "proving"
    assert vd.prefixed("vivijure-studio") == "proving-vivijure-studio"


def test_prefixed_whitespace_is_empty():
    vd.DEPLOY_PREFIX = "   "
    assert vd.prefixed("vivijure") == "vivijure"


def test_state_file_name():
    assert vd.state_file_name() == vd.STATE_FILE == ".vivijure-deploy.json"
    vd.DEPLOY_PREFIX = "proving"
    assert vd.state_file_name() == ".proving-vivijure-deploy.json"


# --- render_core_toml() + render_module_toml(): base-install (media-less) render (F1) --------------

SAMPLE = '''name = "vivijure-studio"
workers_dev = false
tail_consumers = [ { service = "vivijure-tail" } ]

[vars]
AUTH_MODE = "${AUTH_MODE}"
R2_S3_ENDPOINT = "${R2_S3_ENDPOINT}"
R2_S3_BUCKET = "${R2_S3_BUCKET}"

[[r2_buckets]]
binding = "R2_RENDERS"
bucket_name = "vivijure"

[[d1_databases]]
binding = "DB"
database_id = "${D1_DATABASE_ID}"

[[migrations]]
tag = "v2"
deleted_classes = ["VideoFinishContainer"]

[[vpc_services]]
binding = "VIDEO_FINISH_VPC"
service_id = "${VPC_VIDEO_FINISH_ID}"

[[secrets_store_secrets]]
binding = "RUNPOD_API_KEY"
store_id = "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID"

[[services]]
binding = "MODULE_KEYFRAME"
service = "vivijure-module-keyframe"

[[routes]]
pattern = "vivijure.skyphusion.org"
custom_domain = true
'''


def _render(prefix=""):
    return vd.render_core_toml(SAMPLE, account_id="acct123", d1_id="d1-abc", store_id="store-xyz",
                               primary_bucket="vivijure", prefix=prefix,
                               module_service_names=["vivijure-module-keyframe"])


def test_render_base_install_media_less():
    out = _render(prefix="")
    assert 'AUTH_MODE = "token"' in out
    assert 'R2_S3_ENDPOINT = "https://acct123.r2.cloudflarestorage.com"' in out
    assert 'R2_S3_BUCKET = "vivijure"' in out
    assert "${" not in out
    assert 'database_id = "d1-abc"' in out
    assert 'store_id = "store-xyz"' in out
    assert "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID" not in out
    assert "workers_dev = true" in out and "workers_dev = false" not in out
    for gone in ("[[routes]]", "[[vpc_services]]", "[[migrations]]", "tail_consumers"):
        assert gone not in out, gone
    # no prefixing when empty
    assert 'bucket_name = "vivijure"' in out
    assert 'service = "vivijure-module-keyframe"' in out


def test_render_isolated_adds_prefix():
    out = _render(prefix="proving")
    assert 'bucket_name = "proving-vivijure"' in out
    assert 'R2_S3_BUCKET = "proving-vivijure"' in out
    assert 'service = "proving-vivijure-module-keyframe"' in out
    assert "[[vpc_services]]" not in out and 'database_id = "d1-abc"' in out


def test_render_module_toml_strips_vpc():
    mod = '''name = "vivijure-module-audio-master"
[[vpc_services]]
binding = "AUDIO_MASTER_VPC"
service_id = "REPLACE_WITH_VPC_AUDIO_MASTER_ID"

[[services]]
binding = "X"
'''
    out = vd.render_module_toml(mod)
    assert "[[vpc_services]]" not in out
    assert 'name = "vivijure-module-audio-master"' in out
    assert "[[services]]" in out


def test_wrangler_delete_tolerant_skips_missing(monkeypatch):
    import subprocess as _sp
    class R:
        returncode = 1
        stdout = "This Worker does not exist on your account. [code: 10007]"
        stderr = ""
    monkeypatch.setattr(_sp, "run", lambda *a, **k: R())
    vd.wrangler_delete_tolerant(["delete", "-c", "x"], cwd=vd.Path("."), cf_env={}, label="worker x")


# --- no-silent-adopt guard -------------------------------------------------------------------------

def _fake_cf_api(items):
    def _f(method, path, token, body=None):
        if method == "GET":
            return items
        return {"id": "newly-created", "uuid": "newly-created"}
    return _f


def test_adopt_refused_for_foreign(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "foreign"}]))
    with pytest.raises(SystemExit):
        vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
            create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
            id_key="uuid", known_id=None)


def test_recorded_reconciles(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "ours"}]))
    assert vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
        id_key="uuid", known_id="ours").rid == "ours"


def test_adopt_flag_allows(monkeypatch):
    vd._ADOPT = True
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([{"name": "vivijure-studio", "uuid": "foreign"}]))
    assert vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
        id_key="uuid", known_id=None).rid == "foreign"


def test_absent_is_created(monkeypatch):
    monkeypatch.setattr(vd, "cf_api", _fake_cf_api([]))
    assert vd.create_if_absent(kind="D1", account="a", token="t", list_path="/x", create_path="/x",
        create_body={"name": "vivijure-studio"}, name="vivijure-studio", name_key="name",
        id_key="uuid", known_id=None).rid == "newly-created"


# --- cf#279: the module TELEMETRY_DB placeholder round-trip -----------------------------------


def _module_repo(tmp_path, body):
    d = tmp_path / "modules" / "finish-upscale"
    d.mkdir(parents=True)
    (d / "wrangler.toml").write_text(body)
    return tmp_path, d / "wrangler.toml"


TOML = ("name = \"vivijure-module-finish-upscale\"\n"
        "[[d1_databases]]\n"
        "binding = \"TELEMETRY_DB\"\n"
        "database_id = \"REPLACE_WITH_D1_DATABASE_ID\"\n")


def test_d1_placeholder_is_filled_then_restored(tmp_path):
    repo, toml = _module_repo(tmp_path, TOML)
    vd.replace_d1_id_placeholder(repo, "d1-abc-123")
    filled = toml.read_text()
    assert "d1-abc-123" in filled
    assert vd.D1_ID_PLACEHOLDER not in filled
    vd.restore_d1_id_placeholder(repo, "d1-abc-123")
    assert toml.read_text() == TOML   # working tree left exactly as checked out


GROK_TOML = (
    "name = \"vivijure-module-cf-grok-video\"\n"
    "[vars]\n"
    "R2_S3_ENDPOINT = \"REPLACE_WITH_R2_S3_ENDPOINT\"\n"
    "R2_S3_BUCKET = \"REPLACE_WITH_R2_S3_BUCKET\"\n"
)


def test_r2_s3_placeholders_fill_from_account_id(tmp_path):
    repo, toml = _module_repo(tmp_path, GROK_TOML)
    vd.replace_r2_s3_placeholders(repo, "acct123")
    filled = toml.read_text()
    assert 'R2_S3_ENDPOINT = "https://acct123.r2.cloudflarestorage.com"' in filled
    assert 'R2_S3_BUCKET = "vivijure"' in filled
    assert vd.R2_S3_ENDPOINT_PLACEHOLDER not in filled
    vd.restore_r2_s3_placeholders(repo, "acct123")
    assert toml.read_text() == GROK_TOML


def test_r2_s3_bucket_follows_deploy_prefix(tmp_path):
    repo, toml = _module_repo(tmp_path, GROK_TOML)
    prev = vd.DEPLOY_PREFIX
    vd.DEPLOY_PREFIX = "proving"
    try:
        vd.replace_r2_s3_placeholders(repo, "acct123")
        filled = toml.read_text()
        assert 'R2_S3_BUCKET = "proving-vivijure"' in filled
        vd.restore_r2_s3_placeholders(repo, "acct123")
        assert toml.read_text() == GROK_TOML
    finally:
        vd.DEPLOY_PREFIX = prev


def test_r2_s3_refuses_empty_account_when_needed(tmp_path):
    repo, toml = _module_repo(tmp_path, GROK_TOML)
    try:
        vd.replace_r2_s3_placeholders(repo, "")
        raised = False
    except SystemExit:
        raised = True
    assert raised
    assert vd.R2_S3_ENDPOINT_PLACEHOLDER in toml.read_text()


def test_d1_restore_is_a_no_op_without_an_id(tmp_path):
    # NEGATIVE CONTROL: an empty id must not blank-substitute every module toml. Without this, the
    # round-trip test above passes on a restore that simply deletes the id it was given.
    repo, toml = _module_repo(tmp_path, TOML.replace(vd.D1_ID_PLACEHOLDER, "d1-abc-123"))
    vd.restore_d1_id_placeholder(repo, "")
    assert "d1-abc-123" in toml.read_text()


# --- cf#281: the module render carries the isolation pass, and EVERY module goes through it -------


MOD_TOML = ("name = \"vivijure-module-dialogue-gen\"\n"
            "main = \"src/index.ts\"\n"
            "\n"
            "[[r2_buckets]]\n"
            "binding = \"R2_RENDERS\"\n"
            "bucket_name = \"vivijure\"\n"
            "\n"
            "[[workflows]]\n"
            "name = \"dialogue-gen\"\n"
            "binding = \"DIALOGUE_WORKFLOW\"\n"
            "class_name = \"DialogueGenWorkflow\"\n")


def test_render_module_toml_prefixes_the_bucket():
    out = vd.render_module_toml(MOD_TOML, prefix="proving")
    assert 'bucket_name = "proving-vivijure"' in out
    assert 'bucket_name = "vivijure"' not in out


def test_render_module_toml_without_a_prefix_leaves_the_bucket_alone():
    # CONTROL for the test above: without this, that assertion also passes on a render that prefixes
    # unconditionally, which would break every NON-isolated install (the default path).
    out = vd.render_module_toml(MOD_TOML)
    assert 'bucket_name = "vivijure"' in out
    assert "proving" not in out


def test_render_module_toml_prefixes_every_bucket_the_installer_creates():
    body = "".join(f'bucket_name = "{b}"\n' for b in vd.R2_BUCKETS)
    out = vd.render_module_toml(body, prefix="proving")
    for b in vd.R2_BUCKETS:
        assert f'bucket_name = "proving-{b}"' in out


def test_render_module_toml_prefixes_the_workflow_name_and_NOT_the_worker_name():
    # The precision case. A blanket name= substitution would pass the workflow assertion and
    # double-prefix the worker, which deploy_workers already renames via --name.
    out = vd.render_module_toml(MOD_TOML, prefix="proving")
    assert 'name = "proving-dialogue-gen"' in out
    assert 'name = "vivijure-module-dialogue-gen"' in out
    assert 'name = "proving-vivijure-module-dialogue-gen"' not in out


def test_every_tracked_module_bucket_is_one_the_render_knows_about():
    """Binds the render to REALITY rather than to a fixture. A module introducing a bucket name that
    is not in R2_BUCKETS would be silently left unprefixed by an isolated install -- exactly the cf#281
    shape, arriving through a new module instead of through a missing pass. This fails loudly instead."""
    repo = pathlib.Path(__file__).resolve().parent.parent
    found = set()
    for toml in sorted((repo / "modules").glob("*/wrangler.toml")):
        for line in toml.read_text().splitlines():
            if line.startswith("bucket_name = "):
                found.add(line.split("=", 1)[1].strip().strip(chr(34)))
    assert found, "no module declares a bucket: the scan broke, it did not prove absence"
    assert found <= set(vd.R2_BUCKETS), f"module buckets the render cannot prefix: {found - set(vd.R2_BUCKETS)}"


def test_deploy_workers_renders_EVERY_module_not_only_the_vpc_ones(tmp_path, monkeypatch):
    """The load-bearing half of cf#281. The render was only reached by modules carrying a
    [[vpc_services]] block, and no bucket-naming module carries one, so a perfect render would still
    have deployed those tomls verbatim. Asserts on the config file wrangler was actually HANDED."""
    (tmp_path / "wrangler.toml").write_text('name = "vivijure-studio"' + "\n")
    for name, body in (("dialogue-gen", MOD_TOML), ("audio-master", MOD_TOML.replace(
            "[[workflows]]", "[[vpc_services]]") )):
        d = tmp_path / "modules" / name
        d.mkdir(parents=True)
        (d / "wrangler.toml").write_text(body)

    seen = {}

    def fake_wrangler(args, *, cwd, cf_env=None, secret_stdin=None):
        if args[0] != "deploy" or "-c" not in args:
            return                                   # the core deploy carries no -c
        cfg = cwd / args[args.index("-c") + 1]
        seen[cfg.parent.name] = (args[args.index("-c") + 1], cfg.read_text())

    monkeypatch.setattr(vd, "wrangler", fake_wrangler)
    monkeypatch.setattr(vd, "DEPLOY_PREFIX", "proving")
    secrets = type("S", (), {"cf_account_id": "acct", "cf_api_token": "tok"})()
    state = type("St", (), {"resource_id": lambda self, k: ""})()
    vd.deploy_workers(tmp_path, secrets, state)

    assert set(seen) == {"dialogue-gen", "audio-master"}, "a module skipped the render entirely"
    for mod, (cfg_path, body) in seen.items():
        assert cfg_path.endswith(".wrangler-base.toml"), f"{mod} deployed its tracked toml verbatim"
        assert 'bucket_name = "proving-vivijure"' in body, f"{mod} was handed the BASE bucket"
    assert "[[vpc_services]]" not in seen["audio-master"][1]   # the original strip still happens


def test_deploy_workers_leaves_no_rendered_toml_behind(tmp_path, monkeypatch):
    # The render writes a temp config next to each module. It must not survive the deploy, or a
    # checkout ends up carrying 26 untracked tomls.
    (tmp_path / "wrangler.toml").write_text('name = "vivijure-studio"' + "\n")
    d = tmp_path / "modules" / "dialogue-gen"
    d.mkdir(parents=True)
    (d / "wrangler.toml").write_text(MOD_TOML)
    monkeypatch.setattr(vd, "wrangler", lambda *a, **k: None)
    vd.deploy_workers(tmp_path, type("S", (), {"cf_account_id": "a", "cf_api_token": "t"})(),
                      type("St", (), {"resource_id": lambda self, k: ""})())
    assert not list(d.glob(".wrangler-base.toml"))
