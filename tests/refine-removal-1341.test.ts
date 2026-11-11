/// <reference types="node" />
// cf#1341: on a board of more than 50 scenes, a shorter refine reply applies only when (a) the message asks to
// remove scenes, (b) the reply is a pure removal (in order, every kept scene unchanged) and (c) every removed
// scene is named in the message. The fixture is a REAL refine (2026-11-06, app.studio core 1.40.0,
// anthropic/claude-opus-4-8): 60 scenes sent with "Delete shots 10, 20 and 30. Keep every other scene exactly
// as it is.", 57 returned. The other cases are derived from that real reply.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

type Scene = Record<string, unknown> & { id: string; prompt: string };
type Removal = { ok: true; removed: Array<{ position: number; id: string }> } | { ok: false; reason: string };
const refineJs = readFileSync("public/planner-refine.js", "utf8");
const { refineRemovalAllowed, refineRemovalRequest } = new Function(
  refineJs + "\nreturn { refineRemovalAllowed, refineRemovalRequest };",
)() as {
  refineRemovalAllowed: (sent: Scene[], back: Scene[], message: string) => Removal;
  refineRemovalRequest: (message: string) => { numbers: Set<number>; ids: Set<string> } | null;
};
const live = JSON.parse(readFileSync("tests/fixtures/refine-1341/delete-10-20-30.json", "utf8")) as { sent: Scene[]; returned: Scene[] };
const SENT = live.sent;
const DELETE = "Delete shots 10, 20 and 30. Keep every other scene exactly as it is.";

describe("cf#1341 the live delete applies", () => {
  it("the fixture is what the issue recorded: 60 sent, 57 back, exactly shots 10, 20 and 30 gone", () => {
    expect(SENT).toHaveLength(60);
    expect(live.returned).toHaveLength(57);
    const back = new Set(live.returned.map((s) => s.id));
    expect(SENT.filter((s) => !back.has(s.id)).map((s) => s.id)).toEqual(["shot_10", "shot_20", "shot_30"]);
  });

  it("60 to 57 with \"delete shots 10, 20, 30\" applies, and names what it removed", () => {
    const r = refineRemovalAllowed(SENT, live.returned, DELETE);
    expect(r).toEqual({ ok: true, removed: [
      { position: 10, id: "shot_10" }, { position: 20, id: "shot_20" }, { position: 30, id: "shot_30" },
    ] });
  });
});

describe("cf#1341 every other shorter reply is refused", () => {
  it("(c) the same message with a 60 to 50 truncation: scenes 51 to 60 were never named", () => {
    expect(refineRemovalAllowed(SENT, SENT.slice(0, 50), DELETE)).toEqual({ ok: false, reason: "removed-unnamed" });
  });

  it("(c) a removal that also drops one unnamed scene", () => {
    const back = live.returned.filter((s) => s.id !== "shot_45");
    expect(refineRemovalAllowed(SENT, back, DELETE)).toEqual({ ok: false, reason: "removed-unnamed" });
  });

  it("(a) a pure removal with no removal message", () => {
    expect(refineRemovalAllowed(SENT, live.returned, "Make shots 10, 20 and 30 shorter.")).toEqual({ ok: false, reason: "not-asked" });
    expect(refineRemovalAllowed(SENT, live.returned, "tighten the pacing")).toEqual({ ok: false, reason: "not-asked" });
  });

  it("(b) a delete that also edits a kept scene", () => {
    const back = live.returned.map((s) => (s.id === "shot_11" ? { ...s, prompt: s.prompt + " At dusk." } : s));
    expect(refineRemovalAllowed(SENT, back, DELETE)).toEqual({ ok: false, reason: "not-pure-removal" });
  });

  it("(b) decides alone: the model edits a scene the user asked to delete, instead of deleting it", () => {
    // Every removed scene is named (10, 20, 30, 60) so (c) passes; only (b) sees that scene 60 came back edited.
    const back = live.returned.map((s) => (s.id === "shot_60" ? { ...s, prompt: s.prompt + " At dusk." } : s));
    expect(refineRemovalAllowed(SENT, back, "Delete shots 10, 20, 30 and 60.")).toEqual({ ok: false, reason: "not-pure-removal" });
  });

  it("(b) a delete that reorders the kept scenes", () => {
    const back = [...live.returned];
    [back[0], back[1]] = [back[1], back[0]];
    expect(refineRemovalAllowed(SENT, back, DELETE)).toEqual({ ok: false, reason: "not-pure-removal" });
  });

  it("(a) \"remove the rain from shot 5\" with a shorter reply", () => {
    expect(refineRemovalRequest("remove the rain from shot 5")).toBeNull();
    expect(refineRemovalAllowed(SENT, live.returned, "remove the rain from shot 5")).toEqual({ ok: false, reason: "not-asked" });
  });

  it("a removal by description is refused; the scene editor covers it", () => {
    expect(refineRemovalAllowed(SENT, live.returned, "remove all the scenes at the market")).toEqual({ ok: false, reason: "not-asked" });
  });
});

describe("cf#1341 what (a) reads as a removal request", () => {
  const req = (m: string) => {
    const r = refineRemovalRequest(m);
    return r && { numbers: [...r.numbers].sort((x, y) => x - y), ids: [...r.ids].sort() };
  };
  it("a removal verb with scene or shot references, in the forms people write", () => {
    expect(req(DELETE)).toEqual({ numbers: [10, 20, 30], ids: [] });
    expect(req("delete shot_04 and shot_09")).toEqual({ numbers: [], ids: ["shot_04", "shot_09"] });
    expect(req("Remove scene 3 & scene 7, and cut shots 12 or 14")).toEqual({ numbers: [3, 7, 12, 14], ids: [] });
    expect(req("drop shot #8")).toEqual({ numbers: [8], ids: [] });
  });
  it("a removal verb whose object is not a scene reference is not a request", () => {
    for (const m of ["cut the music in shot 9", "drop the second act", "remove all the night scenes", "make it tighter", "keep every scene"]) {
      expect(req(m), m).toBeNull();
    }
  });
  it("a board at or under 50, or a reply that is not shorter, is not refused by this rule", () => {
    expect(refineRemovalAllowed(SENT.slice(0, 50), SENT.slice(0, 40), "tighten")).toEqual({ ok: true, removed: [] });
    expect(refineRemovalAllowed(SENT, SENT, "tighten")).toEqual({ ok: true, removed: [] });
  });
});
