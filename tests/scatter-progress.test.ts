import { describe, it, expect } from "vitest";
import { scatterProgressFields } from "../src/scatter-progress";

describe("scatterProgressFields", () => {
  const ids = ["film-a", "film-b", "film-c"];
  const shots = [["s1", "s2"], ["s3"], ["s4", "s5", "s6", "s7"]];
  const expected = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

  it("counts completed shards as shots for the bar and the 3 of 7 line", () => {
    const out = scatterProgressFields(
      "shards",
      [
        { job_id: "film-a", status: "COMPLETED" },
        { job_id: "film-b", status: "IN_PROGRESS" },
        { job_id: "film-c", status: "IN_PROGRESS" },
      ],
      ids,
      shots,
      expected,
    );
    expect(out.shots_done).toBe(2);
    expect(out.shards_done).toBe(1);
    expect(out.scene_total).toBe(7);
    expect(out.scene_index).toBe(3);
    expect(out.progress).toBeCloseTo(2 / 7);
    expect(out.phase).toBe("shards");
  });

  it("is 0 of N when nothing has finished", () => {
    const out = scatterProgressFields("shards", [], ids, shots, expected);
    expect(out.shots_done).toBe(0);
    expect(out.progress).toBe(0);
    expect(out.scene_index).toBe(1);
  });

  it("sits near the end of the bar once gather/mux starts", () => {
    const kids = ids.map((job_id) => ({ job_id, status: "COMPLETED" }));
    expect(scatterProgressFields("gather", kids, ids, shots, expected).progress).toBe(0.9);
    expect(scatterProgressFields("mux", kids, ids, shots, expected).progress).toBe(0.97);
  });

  it("falls back to one shot per child when the scatter doc is missing", () => {
    const out = scatterProgressFields(
      "shards",
      [
        { job_id: "film-a", status: "COMPLETED" },
        { job_id: "film-b", status: "COMPLETED" },
        { job_id: "film-c", status: "IN_PROGRESS" },
      ],
      [],
      [],
      [],
    );
    expect(out.shards_done).toBe(2);
    expect(out.shots_done).toBe(2);
    expect(out.scene_total).toBe(3);
  });
});
