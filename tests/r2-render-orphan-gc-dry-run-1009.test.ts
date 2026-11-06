// cf#1009 (sprint sweep1106): the merged GC's DRY RUN is the report. It must give a reason per object,
// counts per rule and up to 10 sample keys per rule, and it must delete nothing. Run for real: the actual
// scripts/r2-render-orphan-gc.ts, against a fake `rclone` on PATH that serves `lsjson` and `cat` from a
// JSON bucket and records every call. Any other rclone command fails, so a delete would show in the log.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDryRunReport, buildRenderOwnerIndex, reconcileRenders, SAMPLE_PER_RULE } from "../src/r2-render-orphan-reconcile";

const GC = join(__dirname, "..", "scripts", "r2-render-orphan-gc.ts");
const u = (n: number) => `0000000${n}`.slice(-8) + "-0000-4000-8000-000000000000";
const LIVE = "film-" + u(1);
const OLD = "2026-10-01T00:00:00Z";

// 12 dead film trees, so the sample cap shows; one live film; a dead log; a project tree; a fresh dead tree.
const BUCKET: Record<string, { size: number; mtime: string; body?: unknown }> = {
  [`renders/${LIVE}/film-job.json`]: { size: 10, mtime: OLD, body: { film_id: LIVE, shots: [] } },
  [`renders/${LIVE}/film.mp4`]: { size: 100, mtime: OLD },
  [`renders/logs/film-${u(90)}.txt`]: { size: 3, mtime: OLD },
  [`renders/myproject/clips/shot_01_x.mp4`]: { size: 7, mtime: OLD },
  [`renders/film-${u(91)}/film.mp4`]: { size: 5, mtime: new Date(Date.now() - 3600_000).toISOString() },
};
for (let i = 0; i < 12; i++) BUCKET[`renders/film-${u(10 + i)}/film.mp4`] = { size: 1000 + i, mtime: OLD };
const OWNERS = {
  renderRows: [{ id: "r1", job_id: LIVE, project: "myproject", bundle_key: null, output_key: `renders/${LIVE}/film.mp4`, keyframes_json: null, output_json: null }],
  shotRows: [],
  projectNames: ["myproject"],
};

const FAKE_RCLONE = `#!/usr/bin/env node
const fs = require("fs");
const bucket = JSON.parse(fs.readFileSync(process.env.FAKE_BUCKET, "utf8"));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd, ...rest] = process.argv.slice(2);
const target = rest.filter((a) => !a.startsWith("--")).pop() || "";
const path = target.replace(/^[^:]+:[^/]+\\//, "");
if (cmd === "lsjson") {
  const out = Object.entries(bucket).filter(([k]) => k.startsWith(path))
    .map(([k, v]) => ({ Path: k.slice(path.length), Size: v.size, ModTime: v.mtime }));
  process.stdout.write(JSON.stringify(out));
} else if (cmd === "cat") {
  process.stdout.write(JSON.stringify(bucket[path].body ?? {}));
} else {
  process.stderr.write("fake rclone refuses " + cmd);
  process.exit(9);
}
`;

let dir = "";
let out = "";
let calls: string[][] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gc-dry-1009-"));
  writeFileSync(join(dir, "rclone"), FAKE_RCLONE);
  chmodSync(join(dir, "rclone"), 0o755);
  writeFileSync(join(dir, "bucket.json"), JSON.stringify(BUCKET));
  writeFileSync(join(dir, "owners.json"), JSON.stringify(OWNERS));
  writeFileSync(join(dir, "calls.log"), "");
  const r = spawnSync(process.execPath, [GC, "--owners", join(dir, "owners.json")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_BUCKET: join(dir, "bucket.json"), FAKE_LOG: join(dir, "calls.log") },
  });
  if (r.status !== 0) throw new Error(`gc dry run exited ${r.status}: ${r.stderr}`);
  out = r.stdout;
  calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("cf#1009 the GC dry run is the report", () => {
  it("deletes nothing: rclone was asked only to list and to read", () => {
    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls.map((c) => c[0]))].sort()).toEqual(["cat", "lsjson"]);
    expect(out).toContain("DRY RUN -- nothing deleted");
  });

  it("gives a reason per would-delete object, with its rule", () => {
    const lines = out.split("\n").filter((l) => l.startsWith("  DELETE "));
    expect(lines).toHaveLength(13); // 12 dead trees and the dead log
    for (const l of lines) expect(l).toMatch(/\[(job-dead|log-dead|clips-marked-dead): .+\]$/);
  });

  it("gives counts and bytes per rule, and at most 10 sample keys per rule", () => {
    expect(out).toContain(`first ${SAMPLE_PER_RULE} keys by key order`);
    const rows = out.split("\n").filter((l) => /^ {2}(would delete|keep|out-of-scope) {2}/.test(l));
    const byRule = Object.fromEntries(rows.map((l) => { const p = l.trim().split(/ {2}/); return [p[1], { count: Number(p[2]), bytes: Number(p[3]) }]; }));
    expect(byRule["job-dead"]).toEqual({ count: 12, bytes: Array.from({ length: 12 }, (_, i) => 1000 + i).reduce((a, b) => a + b) });
    expect(byRule["log-dead"]).toEqual({ count: 1, bytes: 3 });
    expect(byRule["named"]?.count).toBe(1);
    expect(byRule["grace"]?.count).toBe(1);
    expect(byRule["not-job-tree"]?.count).toBe(1);
    const block = out.slice(out.indexOf("would delete  job-dead"));
    const sample = block.split("\n").slice(1).filter((l) => l.startsWith("      ")).map((l) => l.trim());
    expect(sample.slice(0, SAMPLE_PER_RULE + 1).filter((k) => k.includes("film.mp4") && !k.includes(LIVE)).length).toBe(SAMPLE_PER_RULE);
    expect(sample[0]).toBe(`renders/film-${u(10)}/film.mp4`);
  });
});

describe("cf#1009 the summary, pure", () => {
  it("counts every object once, and caps samples at SAMPLE_PER_RULE in key order", async () => {
    const objs = Array.from({ length: 13 }, (_, i) => ({ key: `renders/film-${u(40 + i)}/x`, size: 2, mtimeMs: 0 }));
    const idx = await buildRenderOwnerIndex({ renderRows: [], shotRows: [], readDoc: async () => null });
    const rep = buildDryRunReport(reconcileRenders(objs, idx, Date.parse("2026-11-06T00:00:00Z")));
    expect(rep.rules).toEqual([{ rule: "job-dead", decision: "orphan", count: 13, bytes: 26, sample: objs.slice(0, 10).map((o) => o.key) }]);
    expect(rep.wouldDelete).toEqual({ count: 13, bytes: 26 });
    expect(rep.wouldDeleteObjects.every((o) => o.reason.length > 0 && o.rule === "job-dead")).toBe(true);
  });
});
