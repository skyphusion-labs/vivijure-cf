#!/usr/bin/env python3
"""Write the media-stack compose tunnel token (deploy.sh, #519 leftover).

HOSTED DOES NOT USE WORKERS VPC FOR MEDIA. The studio reaches video-finish /
image-prep / audio-beat-sync / audio-mix / audio-master over public HTTPS
origins (VIDEO_FINISH_URL / IMAGE_PREP_URL / AUDIO_*_URL) plus
MEDIA_FINISH_TOKEN. This script does NOT create those VPC services and it
does not print or mint their ids.

It only:

  1. reuse-or-create ONE cloudflared tunnel by name (default vivijure-media),
  2. write the tunnel connector token to a 0600 file (containers/compose.yaml),
     NEVER stdout,
  3. print a JSON map of the NON-secret tunnel id to stdout.

Idempotent: a re-run reuses a non-deleted tunnel of that name.

Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in env. Beyond the base
deploy scopes in docs/DEPLOYMENT.md 2a the token needs `Cloudflare Tunnel:
Write` (create the tunnel + read its connector token). Connectivity Directory
Admin is NOT required and must not be used to mint media VPC service ids.

stdout (ONLY on success): {"tunnel_id": "..."}
stderr: human-readable progress + any error reason. Exit non-zero on any failure.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

ACCT = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
TOK = os.environ["CLOUDFLARE_API_TOKEN"].strip()
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}"

UPGRADE_HINT = ("your token predates the media-stack tunnel scope; re-mint per "
                "docs/DEPLOYMENT.md section 2a (adds Cloudflare Tunnel: Write) "
                "and update deploy.env")


class ScopeError(RuntimeError):
    """A privileged call failed in a way that maps to a missing token scope (#528)."""


def req(url, method="GET", body=None):
    r = urllib.request.Request(
        url, method=method,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(r).read())


def err_codes(e):
    """Return (list_of_int_codes, raw_json_str) from an HTTPError body, best-effort."""
    try:
        body = json.loads(e.read())
        codes = [x.get("code") for x in (body.get("errors") or []) if isinstance(x, dict)]
        return codes, json.dumps(body.get("errors"))[:300]
    except Exception:  # noqa: BLE001
        return [], f"HTTP {getattr(e, 'code', '?')}"


def scoped(fn, scope, codes_that_mean_missing):
    """Run fn(); on an HTTPError whose code/status implies the missing scope, raise a ScopeError."""
    try:
        return fn()
    except urllib.error.HTTPError as e:
        codes, raw = err_codes(e)
        if e.code in (401, 403) or any(c in codes_that_mean_missing for c in codes):
            raise ScopeError(f"your token lacks '{scope}'\n  {UPGRADE_HINT}\n  (Cloudflare said: {raw})")
        raise


def fetch_token(tid):
    """Return the connector token for the tunnel. Tunnel:Write-gated (1001 if the token is read-only)."""
    out = scoped(lambda: req(f"{API}/cfd_tunnel/{tid}/token"),
                 "Cloudflare Tunnel: Write", {1001, 10000})
    if not out.get("success"):
        raise RuntimeError("tunnel token fetch failed: " + json.dumps(out.get("errors"))[:300])
    token = out.get("result")
    if not isinstance(token, str) or not token:
        raise RuntimeError("tunnel token response was empty")
    return token


def reuse_or_create_tunnel(name):
    """Reuse a non-deleted tunnel of this name, else create one. Tunnel list + create are Tunnel:Write-gated."""
    got = scoped(lambda: req(f"{API}/cfd_tunnel?name={name}&is_deleted=false").get("result") or [],
                 "Cloudflare Tunnel: Write", {1001, 10000})
    for t in got:
        if t.get("name") == name and not t.get("deleted_at"):
            print(f"reusing tunnel {name} ({t['id']})", file=sys.stderr)
            return t["id"]
    # config_src=cloudflare -> remotely-managed tunnel; CF generates the secret, the token endpoint
    # returns the connector token. Traefik / public HTTPS is how the studio reaches the containers,
    # so this tunnel needs no Workers VPC service definitions.
    out = scoped(lambda: req(f"{API}/cfd_tunnel", "POST", {"name": name, "config_src": "cloudflare"}),
                 "Cloudflare Tunnel: Write", {1001, 10000})
    if not out.get("success"):
        raise RuntimeError("tunnel create failed: " + json.dumps(out.get("errors"))[:300])
    tid = out["result"]["id"]
    print(f"created tunnel {name} ({tid})", file=sys.stderr)
    return tid


def write_token(token, token_file):
    """Write the connector token to a 0600 file as TUNNEL_TOKEN=... (never stdout)."""
    fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"TUNNEL_TOKEN={token}\n")
    print(f"wrote connector token -> {token_file} (0600)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tunnel-name", default="vivijure-media",
                    help="tunnel name to reuse or create")
    ap.add_argument("--token-file", required=True,
                    help="0600 file to write TUNNEL_TOKEN= into (for docker compose)")
    args = ap.parse_args()

    tid = reuse_or_create_tunnel(args.tunnel_name)
    write_token(fetch_token(tid), args.token_file)
    print(json.dumps({"tunnel_id": tid}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ScopeError as e:
        print("media-tunnel setup failed: " + str(e), file=sys.stderr)
        sys.exit(1)
    except urllib.error.HTTPError as e:
        _, raw = err_codes(e)
        print("Cloudflare API error: " + raw, file=sys.stderr)
        print("  (the deploy token needs Cloudflare Tunnel: Write; see docs/DEPLOYMENT.md 2a)",
              file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"media-tunnel setup failed: {e}", file=sys.stderr)
        sys.exit(1)
