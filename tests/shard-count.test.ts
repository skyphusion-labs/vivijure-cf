import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARD_MAX,
  resolveShardCount,
  scatterViewAsFilmSummary,
  shardMaxFromEnv,
} from "../src/shard-count";

describe("resolveShardCount", () => {
  it("omitted uses min(shots, 20), not 2", () => {
    expect(resolveShardCount(undefined, 10)).toBe(10);
    expect(resolveShardCount(undefined, 30)).toBe(DEFAULT_SHARD_MAX);
    expect(resolveShardCount(undefined, 6, 4)).toBe(4);
  });
  it("explicit 1 is serial", () => {
    expect(resolveShardCount(1, 12)).toBe(1);
  });
  it("clamps to shot count", () => {
    expect(resolveShardCount(99, 3)).toBe(3);
  });
});

describe("shardMaxFromEnv", () => {
  it("falls back to 20", () => {
    expect(shardMaxFromEnv(undefined)).toBe(20);
    expect(shardMaxFromEnv("")).toBe(20);
    expect(shardMaxFromEnv("8")).toBe(8);
  });
});

describe("scatterViewAsFilmSummary", () => {
  it("maps COMPLETED to phase done and keeps film_id as the scatter id", () => {
    const s = scatterViewAsFilmSummary({
      jobId: "scatter-abc",
      status: "COMPLETED",
      statusRaw: "done",
      output: { output_key: "renders/scatter-abc/film.mp4", shards: 4 },
    });
    expect(s.film_id).toBe("scatter-abc");
    expect(s.phase).toBe("done");
    expect(s.film_key).toBe("renders/scatter-abc/film.mp4");
    expect(s.shards).toEqual({ total: 4 });
  });
});
