import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FINISH_QUEUE_SCHEMA } from "@skyphusion-labs/vivijure-core/finish-queue";

// The core writes SQL against this table, and the host owns the migration. They must not drift.
const norm = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

describe("migration 0023", () => {
  it("is the core's schema, exactly", () => {
    const sql = readFileSync(join(__dirname, "../migrations/0023_finish_queue.sql"), "utf8");
    expect(norm(sql)).toBe(norm(FINISH_QUEUE_SCHEMA));
  });
});
