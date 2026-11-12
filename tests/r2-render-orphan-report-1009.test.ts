// cf#1009 dry-run report (sprint ruling 2026-11-06: DRY RUN ONLY, the lead runs the live pass). The report is a
// pure function of three local inputs: a listing, the D1 owner snapshot and the live job docs. Two kinds of
// test here:
//   1. NO DELETE, NO NETWORK, NO SUBPROCESS anywhere in scripts/r2-render-orphan-report.ts or anything it
//      imports. The scan has a POSITIVE CONTROL: the same scanner must flag scripts/r2-render-orphan-gc.ts,
//      which deletes with --apply, or a clean result means nothing.
//   2. The real script, run end to end on files, reports the right rules and leaves every input unchanged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseListingLines, buildDryRunReport, reconcileRenders, buildRenderOwnerIndex } from "../src/r2-render-orphan-reconcile";

const ROOT = join(__dirname, "..");
const REPORT = join(ROOT, "scripts", "r2-render-orphan-report.ts");
const GC = join(ROOT, "scripts", "r2-render-orphan-gc.ts");

// ---- 1. the scan ----------------------------------------------------------------------------------------

/** Code only: comments and string contents of comments removed, so prose about deleting does not count. */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
}
const BANNED: Array<[string, RegExp]> = [
  ["an R2 or Map delete call", /\.delete\s*\(/],
  ["rclone deletefile/delete/purge/rmdirs", /["'`](?:deletefile|delete|purge|rmdirs?|rmdir)["'`]/],
  ["an S3 DeleteObject(s)", /\bDeleteObjects?(?:Command)?\b/],
  ["wrangler r2 object delete", /object\s+delete/],
  ["a subprocess", /child_process|\bexecFileSync\b|\bexecSync\b|\bspawnSync\b|(?<![.\w])spawn\s*\(|(?<![.\w])exec\s*\(/],
  ["a network call", /\bfetch\s*\(|node:https?\b|["']https?["']/],
  ["a filesystem removal", /\b(?:unlinkSync|unlink|rmSync|rmdirSync|rm)\s*\(/],
];
/** Every relative module the file imports, transitively, as absolute paths. */
function importGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, "utf8");
  for (const m of src.matchAll(/(?:import|export)\s[^"']*?from\s+["'](\.[^"']+)["']/g)) {
    let p = resolve(dirname(entry), m[1]);
    if (!/\.ts$/.test(p)) p += ".ts";
    importGraph(p, seen);
  }
  return seen;
}
function violations(entry: string): string[] {
  const out: string[] = [];
  for (const file of importGraph(entry)) {
    const code = codeOf(readFileSync(file, "utf8"));
    for (const [what, re] of BANNED) if (re.test(code)) out.push(`${file.slice(ROOT.length + 1)}: ${what}`);
  }
  return out;
}

describe("cf#1009 the report cannot delete", () => {
  it("the report script and everything it imports: no delete, no network, no subprocess", () => {
    const graph = [...importGraph(REPORT)].map((f) => f.slice(ROOT.length + 1)).sort();
    expect(graph).toEqual(["scripts/r2-render-orphan-report.ts", "src/r2-render-orphan-reconcile.ts", "src/record-reclaim.ts"]);
    expect(violations(REPORT)).toEqual([]);
  });

  it("CONTROL: the same scan flags the --apply GC script, which deletes", () => {
    const v = violations(GC);
    expect(v.some((x) => x.includes("rclone deletefile"))).toBe(true);
    expect(v.some((x) => x.includes("a subprocess"))).toBe(true);
  });

  it("CONTROL: each banned form is seen in code and ignored in a comment", () => {
    for (const code of ['bucket.delete(k)', 'rclone(["deletefile", k])', 'new DeleteObjectCommand()', 'execFileSync("x")', 'exec("rm x")', 'await fetch(u)', 'rmSync(p)']) {
      expect(BANNED.some(([, re]) => re.test(codeOf(code))), code).toBe(true);
      expect(BANNED.some(([, re]) => re.test(codeOf("// " + code))), "// " + code).toBe(false);
    }
    // And the two shapes the core really holds are not mistaken for one: a regex exec, a field named for it.
    for (const code of ["const m = JOB_ID_RE.exec(seg);", "wouldDeleteObjects: [...r.orphans]"]) {
      expect(BANNED.some(([, re]) => re.test(codeOf(code))), code).toBe(false);
    }
  });
});

// ---- 2. end to end on files -------------------------------------------------------------------------------

const u = (n: number) => `0000000${n}`.slice(-8) + "-0000-4000-8000-000000000000";
const LIVE = "film-" + u(1);      // live renders row, its doc names clip job CLIPS
const CLIPS = "clips-" + u(2);    // live by its film doc
const DEAD = "film-" + u(3);      // no row: would delete
const DEADLOG = "film-" + u(4);   // no row, only a log: would delete
const MARKED = "clips-" + u(5);   // standalone, marker, no row: would delete
const UNMARKED = "clips-" + u(6); // no marker, no owner: out of scope
const NOW = Date.parse("2026-11-06T12:00:00Z");
const OLD = "2026-10-01T00:00:00Z";
const FRESH = "2026-11-06T06:00:00Z";

const LISTING = [
  { key: `renders/${LIVE}/film-job.json`, size: 10, uploaded: OLD },
  { key: `renders/${LIVE}/film.mp4`, size: 1000, uploaded: OLD },
  { key: `renders/${CLIPS}/clips-job.json`, size: 10, uploaded: OLD },
  { key: `renders/${CLIPS}/shot_01.mp4`, size: 500, uploaded: OLD },
  { key: `renders/${DEAD}/film-job.json`, size: 10, uploaded: OLD },
  { key: `renders/${DEAD}/film.mp4`, size: 2000, uploaded: OLD },
  { key: `renders/logs/${DEADLOG}.txt`, size: 5, uploaded: OLD },
  { key: `renders/${MARKED}/owner.json`, size: 2, uploaded: OLD },
  { key: `renders/${MARKED}/clips-job.json`, size: 10, uploaded: OLD },
  { key: `renders/${UNMARKED}/clips-job.json`, size: 10, uploaded: OLD },
  { key: `renders/myproject/clips/shot_01_x.mp4`, size: 300, uploaded: OLD },
  { key: `renders/film-${u(7)}/film.mp4`, size: 50, uploaded: FRESH },
  { key: `bundles/p-abc.tar.gz`, size: 40, uploaded: OLD },
];
const OWNERS = {
  renderRows: [{ id: "r1", job_id: LIVE, project: "myproject", bundle_key: null, output_key: `renders/${LIVE}/film.mp4`, keyframes_json: null, output_json: null }],
  shotRows: [],
  projectNames: ["myproject"],
};
const DOCS: Record<string, unknown> = {
  [`renders/${LIVE}/film-job.json`]: { film_id: LIVE, clip_job_id: CLIPS, shots: [] },
  [`renders/${CLIPS}/clips-job.json`]: { job_id: CLIPS, shots: [{ clip_key: `renders/${CLIPS}/shot_01.mp4` }] },
};

let dir = "";
const hashTree = (d: string): string => {
  const h = createHash("sha256");
  const walk = (p: string) => {
    for (const n of readdirSync(p).sort()) {
      const f = join(p, n);
      // Read the name once. EISDIR is a directory (walk it). ENOENT and other errors still throw.
      let body: Buffer;
      try {
        body = readFileSync(f);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EISDIR") {
          walk(f);
          continue;
        }
        throw err;
      }
      h.update(f.slice(d.length) + "\0" + body.toString("base64"));
    }
  };
  walk(d);
  return h.digest("hex");
};
const run = (...args: string[]) => spawnSync(process.execPath, [REPORT, ...args], { encoding: "utf8", cwd: ROOT });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "orphan-report-1009-"));
  writeFileSync(join(dir, "listing.jsonl"), LISTING.map((o) => JSON.stringify(o)).join("\n") + "\n");
  writeFileSync(join(dir, "owners.json"), JSON.stringify(OWNERS));
  mkdirSync(join(dir, "docs"));
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("cf#1009 the report, run end to end on files", () => {
  const base = () => ["--listing", join(dir, "listing.jsonl"), "--owners", join(dir, "owners.json"), "--docs", join(dir, "docs"), "--now", new Date(NOW).toISOString()];

  it("round 1: it names the live docs it needs, makes no report, and exits 3", () => {
    const r = run(...base());
    expect(r.status).toBe(3);
    expect(r.stdout.trim().split("\n")).toEqual([`renders/${LIVE}/film-job.json`]);
    expect(r.stdout).not.toContain("DRY RUN");
  });

  it("round 2: the film doc names its clip job, so that doc is needed next", () => {
    const file = join(dir, "docs", `renders/${LIVE}/film-job.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(DOCS[`renders/${LIVE}/film-job.json`]));
    const r = run(...base(), "--needed-docs");
    expect(r.status).toBe(3);
    expect(r.stdout.trim().split("\n")).toEqual([`renders/${CLIPS}/clips-job.json`]);
    const file2 = join(dir, "docs", `renders/${CLIPS}/clips-job.json`);
    mkdirSync(dirname(file2), { recursive: true });
    writeFileSync(file2, JSON.stringify(DOCS[`renders/${CLIPS}/clips-job.json`]));
    expect(run(...base(), "--needed-docs").status).toBe(0);
  });

  it("the report: counts and samples per rule, every would-delete with its reason, inputs unchanged", () => {
    const before = hashTree(dir);
    const out = join(tmpdir(), `orphan-report-1009-out-${process.pid}.json`);
    const r = run(...base(), "--out", out);
    expect(r.status, r.stderr).toBe(0);
    expect(hashTree(dir)).toBe(before); // the inputs are byte-identical after the run
    const rep = JSON.parse(readFileSync(out, "utf8"));
    rmSync(out);
    expect(rep.scanned).toBe(LISTING.length);
    expect(rep.wouldDeleteObjects.map((o: { key: string; rule: string }) => `${o.rule} ${o.key}`)).toEqual([
      `clips-marked-dead renders/${MARKED}/clips-job.json`,
      `clips-marked-dead renders/${MARKED}/owner.json`,
      `job-dead renders/${DEAD}/film-job.json`,
      `job-dead renders/${DEAD}/film.mp4`,
      `log-dead renders/logs/${DEADLOG}.txt`,
    ]);
    expect(rep.wouldDelete).toEqual({ count: 5, bytes: 2027 });
    expect(rep.wouldDeleteObjects.every((o: { reason: string }) => o.reason.length > 0)).toBe(true);
    const byRule = Object.fromEntries(rep.rules.map((s: { rule: string; count: number }) => [s.rule, s.count]));
    expect(byRule).toEqual({
      "clips-marked-dead": 2, "job-dead": 2, "log-dead": 1,
      named: 2, "clips-live": 1, "job-live": 1, grace: 1,
      "clips-unmarked": 1, "not-job-tree": 1, "not-renders": 1,
    });
    expect(r.stdout).toContain("DRY RUN, nothing deleted");
    expect(r.stdout).toContain("would delete 5 (2027 bytes)");
  });
});

describe("cf#1009 the listing input", () => {
  it("reads ISO and epoch-ms times, and an absent time as unreadable", () => {
    const objs = parseListingLines(['{"key":"renders/a","size":1,"uploaded":"2026-10-01T00:00:00Z"}', '{"key":"renders/b","size":2,"uploaded":1790000000000}', '', '{"key":"renders/c","size":3}'].join("\n"));
    expect(objs).toEqual([
      { key: "renders/a", size: 1, mtimeMs: Date.parse("2026-10-01T00:00:00Z") },
      { key: "renders/b", size: 2, mtimeMs: 1790000000000 },
      { key: "renders/c", size: 3, mtimeMs: null },
    ]);
  });
  it("refuses the whole listing on one bad line, rather than report on part of it", () => {
    expect(() => parseListingLines('{"key":"renders/a","size":1}\nnot json')).toThrow(/line 2/);
    expect(() => parseListingLines('{"key":"","size":1}')).toThrow(/line 1/);
    expect(() => parseListingLines('{"key":"renders/a"}')).toThrow(/line 1/);
  });
  it("samples are capped at 10 per rule, in key order", async () => {
    const objs = Array.from({ length: 13 }, (_, i) => ({ key: `bundles/b${String(i).padStart(2, "0")}`, size: 1, mtimeMs: 0 }));
    const idx = await buildRenderOwnerIndex({ renderRows: [], shotRows: [], readDoc: async () => null });
    const rep = buildDryRunReport(reconcileRenders(objs, idx, NOW));
    expect(rep.rules).toHaveLength(1);
    expect(rep.rules[0].count).toBe(13);
    expect(rep.rules[0].sample).toEqual(objs.slice(0, 10).map((o) => o.key));
  });
});
