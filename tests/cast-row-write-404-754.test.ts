import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// cf#754: port of vivijure-local#351 to the HOSTED door.
//
// A FAILED cast-row write used to answer `HTTP 200 { cast: null }` on every upload path in
// src/cast-media.ts. A 200-with-data and a 200-with-null are two states rendering as one, and the
// panel assigns `state.cast[idx] = data.cast` BEFORE it reads anything, so the null landed in panel
// state and the next editor populate threw a JavaScript null-property error instead of reporting
// the write that failed.
//
// TWO claims are tested here and they are not the same claim:
//   1. the failed write answers 404, and
//   2. the failure body carries NO `cast` field at all -- `404 { cast: null }` would still put
//      null into panel state, so status alone does not close this issue.
//
// MEASURED DENOMINATOR on main at 4e2fe52:
//   grep -c "row ? toPublicCast(row) : null" src/cast-media.ts  ->  9
//   lines 189, 197, 211, 241, 249, 261, 303, 311, 323
// which is 3 doors (portrait / ref / source) x 3 entry paths (chat-artifact copy, staged JSON key,
// raw bytes). Six of the nine were live defects; the three staged-key sites had an `if (!row) throw
// 404` immediately above, so their null arm was already unreachable. The issue body's count of
// "handleCastPortraitUpload has two" was STALE: the file had grown to cover refs and sources.
//
// THE POSITIVE CONTROL IS THE POINT. Nine 404s are otherwise exactly as consistent with nine
// handlers that never ran, or nine requests rejected before the row write was ever attempted. Every
// case below runs TWICE against the same request: once with the row write succeeding, which must
// answer 200 AND prove by the recorded R2 ops and the key handed to the db call that THIS path (not
// a sibling path in the same handler) executed; and once with the row write producing nothing.

const SRC_KEY = "uploads/u1.png";
const OLD_PORTRAIT = "cast/7/portrait.jpg";

const setPortrait = vi.fn();
const addRef = vi.fn();
const addSource = vi.fn();

vi.mock("@skyphusion-labs/vivijure-core/cast-db", () => ({
  getCastById: async () => ({
    id: 7,
    public_id: "cast_pub_7",
    name: "Ada",
    portrait_key: OLD_PORTRAIT,
    ref_keys: [],
    source_keys: [],
  }),
  clearPortrait: async () => ({ id: 7 }),
  setPortrait,
  addRef,
  removeRef: async () => ({ row: { id: 7 }, removedKey: "k" }),
  addSource,
  removeSource: async () => ({ row: { id: 7 }, removedKey: "k" }),
  toPublicCast: (r: unknown) => r,
}));

const ROW = {
  id: 7,
  public_id: "cast_pub_7",
  name: "Ada",
  portrait_key: OLD_PORTRAIT,
  ref_keys: [],
  source_keys: [],
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** R2 stand-in that logs every access. The op log is what separates the three entry paths of one
 *  handler from each other: the copy path READS the source first, the raw-bytes path only PUTS,
 *  and the staged-key path touches R2 not at all. */
function makeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const ops: string[] = [];
  const binding = {
    put: async (
      key: string,
      bytes: ArrayBuffer | Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      ops.push(`put:${key}`);
      store.set(key, {
        bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
    get: async (key: string) => {
      ops.push(`get:${key}`);
      const hit = store.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () =>
          hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength),
        httpMetadata: { contentType: hit.contentType },
      };
    },
    head: async (key: string) => (store.has(key) ? { size: store.get(key)!.bytes.length } : null),
    delete: async (key: string) => {
      ops.push(`delete:${key}`);
      store.delete(key);
    },
  };
  return { store, ops, binding };
}

type Handler = (request: Request, env: unknown, id: number) => Promise<Response>;
type Door = "portrait" | "ref" | "source";
type Path = "copy" | "staged" | "bytes";

async function handlerFor(door: Door): Promise<Handler> {
  const m = await import("../src/cast-media.js");
  if (door === "portrait") return m.handleCastPortraitUpload as Handler;
  if (door === "ref") return m.handleCastRefAdd as Handler;
  return m.handleCastSourceAdd as Handler;
}

function mockFor(door: Door) {
  return door === "portrait" ? setPortrait : door === "ref" ? addRef : addSource;
}

/** The key the handler actually handed the db write. setPortrait takes it positionally; addRef and
 *  addSource take it on an object. This is half the proof that a given SITE ran. */
function keyHandedToDb(door: Door, args: unknown[]): string {
  if (door === "portrait") return args[2] as string;
  return (args[2] as { key: string }).key;
}

function stagedKeyFor(door: Door): string {
  return `cast/7/staged-${door}.png`;
}

function requestFor(door: Door, path: Path): Request {
  const url = `https://cf/api/cast/7/${door}`;
  if (path === "copy") {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_chat_artifact: SRC_KEY }),
    });
  }
  if (path === "staged") {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: stagedKeyFor(door), mime: "image/png" }),
    });
  }
  return new Request(url, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
}

/** The written key each door+path must produce, as a pattern. */
function expectedKey(door: Door, path: Path): RegExp {
  if (path === "staged") return new RegExp(`^cast/7/staged-${door}\\.png$`);
  if (door === "portrait") return /^cast\/7\/portrait\.png$/;
  if (door === "ref") return /^cast\/7\/refs\/[0-9a-f-]{36}\.png$/;
  return /^cast\/7\/sources\/[0-9a-f-]{36}\.png$/;
}

let r2: ReturnType<typeof makeR2>;
let env: { R2_RENDERS: ReturnType<typeof makeR2>["binding"]; DB: object };

beforeEach(async () => {
  r2 = makeR2();
  env = { R2_RENDERS: r2.binding, DB: {} };
  await r2.binding.put(OLD_PORTRAIT, PNG, { httpMetadata: { contentType: "image/png" } });
  await r2.binding.put(SRC_KEY, PNG, { httpMetadata: { contentType: "image/png" } });
  r2.ops.length = 0;
  setPortrait.mockReset().mockResolvedValue(ROW);
  addRef.mockReset().mockResolvedValue(ROW);
  addSource.mockReset().mockResolvedValue(ROW);
});

const DOORS: Door[] = ["portrait", "ref", "source"];
const PATHS: Path[] = ["copy", "staged", "bytes"];

const SITES: Array<{ door: Door; path: Path }> = DOORS.flatMap((door) =>
  PATHS.map((path) => ({ door, path })),
);

describe("cf#754 POSITIVE CONTROL: every one of the nine sites reaches handler code and CAN answer 200", () => {
  for (const { door, path } of SITES) {
    it(`${door} / ${path}: the row write is reached and a written row answers 200 with the cast`, async () => {
      const h = await handlerFor(door);
      const mock = mockFor(door);

      const res = await h(requestFor(door, path), env, 7);
      const raw = await res.text();
      const evidence = `${door}/${path} -> status=${res.status} ops=[${r2.ops.join(" ")}] body=${raw}`;

      expect(res.status, evidence).toBe(200);
      expect(mock, `${evidence}: the row write was never attempted`).toHaveBeenCalledTimes(1);

      // WHICH site ran, stated two ways. Without this a green control is equally consistent with
      // one path answering for all three.
      expect(keyHandedToDb(door, mock.mock.calls[0]), evidence).toMatch(expectedKey(door, path));
      if (path === "copy") {
        expect(r2.ops[0], `${evidence}: the copy path must READ the source artifact first`).toBe(
          `get:${SRC_KEY}`,
        );
        expect(r2.ops[1], evidence).toMatch(/^put:/);
      } else if (path === "bytes") {
        expect(r2.ops[0], `${evidence}: the raw-bytes path puts without reading a source`).toMatch(
          /^put:/,
        );
        expect(r2.ops.filter((o) => o.startsWith("get:")), evidence).toEqual([]);
      } else {
        expect(r2.ops, `${evidence}: the staged-key path must touch R2 not at all`).toEqual([]);
      }

      const body = JSON.parse(raw) as { cast?: { name?: string } };
      expect(body.cast, `${evidence}: a successful write must carry the cast`).toBeTruthy();
      expect(body.cast?.name, evidence).toBe("Ada");
    });
  }
});

describe("cf#754: a row write that produced NOTHING answers 404 with a diagnostic and no cast field", () => {
  for (const { door, path } of SITES) {
    it(`${door} / ${path}: 404, a diagnostic naming what failed, and NO cast key in the body`, async () => {
      const h = await handlerFor(door);
      const mock = mockFor(door);
      mock.mockResolvedValue(null);

      const res = await h(requestFor(door, path), env, 7);
      const raw = await res.text();
      const evidence = `${door}/${path} -> status=${res.status} ops=[${r2.ops.join(" ")}] body=${raw}`;

      // Same control as above, restated on THIS run: the 404 must come from the row write, not
      // from a request that was rejected before the write was ever attempted.
      expect(mock, `${evidence}: the row write was never attempted, so the 404 proves nothing`)
        .toHaveBeenCalledTimes(1);
      expect(keyHandedToDb(door, mock.mock.calls[0]), evidence).toMatch(expectedKey(door, path));

      expect(res.status, `${evidence}: a write that produced no row is NOT a success`).toBe(404);

      const body = JSON.parse(raw) as Record<string, unknown>;

      // Claim 2, and it is independent of the status. `404 { cast: null }` still lands null in
      // panel state, because the panel assigns data.cast before it inspects anything.
      expect(
        Object.prototype.hasOwnProperty.call(body, "cast"),
        `${evidence}: the failure body carries a cast field; null still reaches panel state`,
      ).toBe(false);
      expect(Object.keys(body), evidence).toEqual(["error"]);
      expect(raw, `${evidence}: the serialized body must not mention cast as a key`).not.toContain(
        '"cast"',
      );

      // The diagnostic has to name what failed, or the 404 is indistinguishable from the
      // "cast not found" 404 the handler already threw for a missing cast member.
      expect(typeof body.error, evidence).toBe("string");
      const message = body.error as string;
      expect(message.length, evidence).toBeGreaterThan(0);
      expect(message, `${evidence}: the diagnostic must name the door`).toContain(door);
      expect(message, `${evidence}: the diagnostic must name the cast`).toContain("cast 7");
      expect(message, `${evidence}: the diagnostic must say the row write returned nothing`)
        .toMatch(/returned no row/);
    });
  }
});

describe("cf#754 structural: the 200-with-null shape is gone from the CODE of the file", () => {
  const SRC_PATH = join(import.meta.dirname, "..", "src", "cast-media.ts");

  /** Strip block and line comments before matching. Without this the grep reads the PROSE that
   *  explains the defect and reports the defect: this file and cast-media.ts both quote
   *  `{ cast: null }` in their comments, and a check that cannot tell a comment from a response
   *  is a check that can never go green. */
  function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  const NULL_CAST_TERNARY = /toPublicCast\([^)]*\)\s*:\s*null/g;
  const LITERAL_NULL_CAST = /cast:\s*null/g;

  // CONTROL OF THE CONTROL. The two patterns below report "clean" on the fixed file. That reading
  // is worth nothing until each one is shown producing the opposite reading, so each is run here
  // against a snippet carrying the shape it gates, and both are run against prose that only
  // MENTIONS the shape.
  it("CONTROL: each matcher is shown finding its defect, and neither reads a comment as code", () => {
    const preFix = [
      "const row = await setPortrait(env, id, key, mime);",
      "return json({ cast: row ? toPublicCast(row) : null });",
      "const r2 = await removeRef(env, id, k);",
      "return json({ cast: result.row ? toPublicCast(result.row) : null });",
    ].join("\n");
    expect(code(preFix).match(NULL_CAST_TERNARY), "the matcher cannot see the defect it gates")
      .toHaveLength(2);
    // Stated plainly because it bounds the claim: the LITERAL matcher would have found NOTHING in
    // the pre-fix source, which spelled it `cast: row ? ... : null`. It is a forward guard against
    // a hand-written null body, not evidence about what this PR removed. The ternary matcher is
    // the one that gates the nine measured sites.
    expect(code(preFix).match(LITERAL_NULL_CAST), "the literal matcher gates a different shape")
      .toBeNull();

    const directNull = "return json({ cast: null }, 404);";
    expect(code(directNull).match(LITERAL_NULL_CAST), "the literal matcher cannot go red")
      .toHaveLength(1);
    expect(code(directNull).match(NULL_CAST_TERNARY), "the ternary matcher gates a different shape")
      .toBeNull();

    const commentOnly =
      "/* this door used to answer 200 { cast: null } */\n" +
      "// cast: row ? toPublicCast(row) : null was the bug\n" +
      "return json({ cast: toPublicCast(row) });";
    expect(code(commentOnly).match(NULL_CAST_TERNARY), "prose read as code").toBeNull();
    expect(code(commentOnly).match(LITERAL_NULL_CAST), "prose read as code").toBeNull();
  });

  it("no `row ? toPublicCast(row) : null` response remains (denominator on 4e2fe52 was 9)", () => {
    const src = code(readFileSync(SRC_PATH, "utf8"));
    const hits = src.match(/row \? toPublicCast\(row\) : null/g) ?? [];
    expect(hits.length, `still present ${hits.length} time(s) in src/cast-media.ts`).toBe(0);
  });

  it("no response in this file can serialize a null cast, by any spelling of the ternary", () => {
    const src = code(readFileSync(SRC_PATH, "utf8"));
    // Catches `result.row ? toPublicCast(result.row) : null` too, which the issue's grep string
    // missed and which is the same shape waiting to be copied into a new handler.
    expect(src.match(NULL_CAST_TERNARY), "a cast-bearing response can still produce null").toBeNull();
    expect(src.match(LITERAL_NULL_CAST), "a literal cast: null response body remains").toBeNull();
  });
});
