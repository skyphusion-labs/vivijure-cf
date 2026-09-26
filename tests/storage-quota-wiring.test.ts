import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { studioEnv } from "../src/orchestrator-env";
import { API_ROUTES } from "../src/index";
import type { Env } from "../src/env";
import {
  STORAGE_USAGE_DDL,
  isMeteredStore,
  storageSubmitPatterns,
  storageUsedBytes,
} from "@skyphusion-labs/vivijure-core/storage-quota";
import type { Database } from "@skyphusion-labs/vivijure-core/platform";

// core#52 WIRING tests. The core unit suite proves the accounting logic against fakes; these prove the
// PRODUCTION wiring of this Worker, which a fake can never speak for: that the real studioEnv seam meters
// the real binding, that this repo's migration still carries core's schema, and that the gated route list
// still matches routes this Worker actually serves.

// ---------------------------------------------------------------- a D1-shaped ledger fake

function ledgerDb(): Database & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  const make = (sql: string, bound: unknown[]) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => make(sql, values),
      async first<T>() {
        let total = 0;
        for (const v of rows.values()) total += v;
        return { total, objects: rows.size } as T;
      },
      async run() {
        // Table-boundary matchers: "INSERT INTO storage_usage (" must not also match
        // storage_usage_meta (cf#555). Unknown SQL throws rather than wiping.
        if (norm.startsWith("INSERT INTO storage_usage (")) rows.set(String(bound[0]), Number(bound[1]));
        else if (norm.startsWith("DELETE FROM storage_usage WHERE object_key = ?")) rows.delete(String(bound[0]));
        else throw new Error(`ledgerDb does not understand: ${norm}`);
        return { success: true };
      },
      async all<T>() {
        return { results: [] as T[] };
      },
    };
  };
  return { rows, prepare: (sql: string) => make(sql, []) } as unknown as Database & { rows: Map<string, number> };
}

/** The minimum of the real Env the seam touches: a bucket and a DB. Everything else stays undefined,
 *  which is the point -- the seam must not need the rest of the deploy to be present. */
function rawEnv(): Env & { R2_RENDERS: { puts: string[]; deletes: string[] } } {
  const puts: string[] = [];
  const deletes: string[] = [];
  const bucket = {
    puts,
    deletes,
    async put(key: string) {
      puts.push(key);
    },
    async delete(key: string) {
      deletes.push(key);
    },
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
  return { R2_RENDERS: bucket, DB: ledgerDb() } as unknown as Env & {
    R2_RENDERS: { puts: string[]; deletes: string[] };
  };
}

describe("ledgerDb fake itself (cf#555)", () => {
  it("unknown SQL throws instead of wiping the ledger", async () => {
    const db = ledgerDb();
    await db.prepare(
      "INSERT INTO storage_usage (object_key, bytes, updated_at) VALUES (?, ?, ?)",
    ).bind("renders/a.mp4", 1024, 1).run();
    expect(db.rows.size).toBe(1);
    await expect(
      db.prepare("CREATE TABLE IF NOT EXISTS storage_usage_meta (key TEXT, value TEXT)").run(),
    ).rejects.toThrow(/does not understand/);
    expect(db.rows.size, "catch-all must not wipe").toBe(1);
  });

  it("INSERT INTO storage_usage_meta is not routed as an object row", async () => {
    const db = ledgerDb();
    await expect(
      db.prepare("INSERT INTO storage_usage_meta (key, value) VALUES (?, ?)").bind("ledger_true_since", "1786000000000").run(),
    ).rejects.toThrow(/does not understand/);
    expect(db.rows.size).toBe(0);
  });
});

describe("the studioEnv write seam (production wiring, core#52)", () => {
  it("METERS the real R2 binding every request env is built from", async () => {
    const raw = rawEnv();
    // Negative control FIRST: the raw binding is not metered until the seam runs. If this ever passes
    // trivially, the assertion below proves nothing.
    expect(isMeteredStore(raw.R2_RENDERS)).toBe(false);

    const env = studioEnv(raw);
    expect(isMeteredStore(env.R2_RENDERS)).toBe(true);

    await env.R2_RENDERS.put("renders/a.mp4", new Uint8Array(1024));
    expect(await storageUsedBytes(env.DB)).toBe(1024);
    // The write still reached the real bucket: metering wraps, it does not replace.
    expect(raw.R2_RENDERS.puts).toEqual(["renders/a.mp4"]);

    await env.R2_RENDERS.delete("renders/a.mp4");
    expect(await storageUsedBytes(env.DB)).toBe(0);
    expect(raw.R2_RENDERS.deletes).toEqual(["renders/a.mp4"]);
  });

  it("does NOT double count when studioEnv runs again on the same isolate env", async () => {
    // studioEnv runs per request against the SAME env object, and it mutates that object. A wrapper that
    // stacked would count every byte once per request served by the isolate.
    const raw = rawEnv();
    const first = studioEnv(raw);
    const second = studioEnv(raw);
    const third = studioEnv(raw);
    await third.R2_RENDERS.put("renders/b.mp4", new Uint8Array(500));
    expect(await storageUsedBytes(first.DB)).toBe(500);
    expect(raw.R2_RENDERS.puts).toEqual(["renders/b.mp4"]);
    expect(second.R2_RENDERS).toBe(third.R2_RENDERS);
  });

  it("survives an env with no DB (the seam must not throw a deploy down)", () => {
    const raw = { R2_RENDERS: rawEnv().R2_RENDERS } as unknown as Env;
    expect(() => studioEnv(raw)).not.toThrow();
  });
});

describe("migration 0013 carries core's schema verbatim", () => {
  it("matches STORAGE_USAGE_DDL", () => {
    const sql = readFileSync(join(__dirname, "..", "migrations", "0013_storage_usage.sql"), "utf8");
    const statement = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim()
      .replace(/;$/, "")
      .trim();
    // Byte-identical to the constant core exports, so the two hosts cannot drift to different schemas.
    expect(statement).toBe(STORAGE_USAGE_DDL);
  });
});

describe("the gated submit surface still matches this Worker's routes", () => {
  it("every core storage-submit pattern hits a route this Worker serves", () => {
    const samples = API_ROUTES.filter((r) => r.method === "POST").map((r) =>
      // ":id" -> a sample segment, so a route template can be tested against core's path regex.
      r.pattern.replace(/:[A-Za-z_]+/g, "sample-id"),
    );
    const retired = ["^\\/api\\/storyboard\\/render\\/scatter$"];
    for (const pattern of storageSubmitPatterns()) {
      if (retired.includes(pattern.source)) continue;
      const hit = samples.find((path) => pattern.test(path));
      // A gated pattern with no route is a gate protecting nothing: either a route was renamed and the
      // ceiling silently stopped covering it, or the pattern was wrong from the start.
      expect(hit, `no POST route matches ${pattern}`).toBeDefined();
    }
  });

  it("the operator surface is registered", () => {
    expect(API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/storage/usage")).toBeDefined();
    expect(API_ROUTES.find((r) => r.method === "POST" && r.pattern === "/api/storage/reconcile")).toBeDefined();
  });
});
