import json, os, subprocess, sys

def api(path, method="GET", body=None):
    tok = os.environ["CLOUDFLARE_API_TOKEN"]; acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}{path}"
    cmd = ["curl", "-sS", "-H", f"Authorization: Bearer {tok}", "-X", method, url]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)

d = api("/d1/database?name=vivijure-studio")
dbid = (d.get("result") or [{}])[0].get("uuid")
if not dbid:
    print("D1 LOOKUP FAILED -- state UNKNOWN"); sys.exit(1)

sql = sys.argv[1] if len(sys.argv) > 1 else "SELECT * FROM runpod_job_log ORDER BY submitted_at"
r = api(f"/d1/database/{dbid}/query", "POST", {"sql": sql})
if not r.get("success"):
    print("QUERY FAILED -- state UNKNOWN, NOT assumed empty:", r.get("errors")); sys.exit(1)
rows = r["result"][0]["results"]
print(f"ROW COUNT: {len(rows)}")
for row in rows:
    row = dict(row)
    if row.get("detail"): row["detail"] = row["detail"][:70]
    print(" ", row)
