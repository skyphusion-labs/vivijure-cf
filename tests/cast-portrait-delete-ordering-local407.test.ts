import { describe, it, expect, vi, beforeEach } from "vitest";

// Parity with vivijure-local#407, on the HOSTED door. Both portrait replacement paths deleted the
// OLD R2 object BEFORE the replacement existed, so any throw in between left `portrait_key` naming
// a deleted object: a row that is internally consistent, passes every check that reads the row, and
// points at nothing.
//
// WHY THIS IS AN ORDERING TEST AND NOT A RACE TEST: the window was never only a transient R2 fault.
// `copyChatArtifactToRenders` throws 404 on a missing source, 413 over 16 MB, and 400 on a rejected
// mime, all BEFORE it writes a byte. On the old ordering every one of those ORDINARY CLIENT ERRORS
// destroyed the portrait the row still pointed at. Each case below fails on the pre-fix ordering.

const OLD_KEY = "cast/7/portrait.jpg";
const NEW_PNG_KEY = "cast/7/portrait.png";
const SRC_KEY = "uploads/u1.png";
const ROW = { id: 7, name: "Ada" };

const setPortrait = vi.fn();

vi.mock("@skyphusion-labs/vivijure-core/cast-db", () => ({
  getCastById: async () => ({
    id: 7,
    public_id: "x",
    name: "Ada",
    portrait_key: OLD_KEY,
    ref_keys: [],
    source_keys: [],
  }),
  clearPortrait: async () => ({ id: 7 }),
  setPortrait,
  addRef: async () => ({ id: 7 }),
  removeRef: async () => ({ row: { id: 7 }, removedKey: "k" }),
  addSource: async () => ({ id: 7 }),
  removeSource: async () => ({ row: { id: 7 }, removedKey: "k" }),
  toPublicCast: (r: unknown) => r,
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** An R2 stand-in that records the ORDER of every mutation and can be made to fail one put. The
 *  order log is the evidence: the fix is not "delete less", it is "delete the superseded object
 *  only after the replacement is durable". */
function makeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const ops: string[] = [];
  const failPut = new Set<string>();
  const binding = {
    put: async (
      key: string,
      bytes: ArrayBuffer | Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      if (failPut.has(key)) {
        ops.push(`put-threw:${key}`);
        throw new Error("simulated R2 write failure");
      }
      ops.push(`put:${key}`);
      store.set(key, {
        bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
    get: async (key: string) => {
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
  return { store, ops, failPut, binding };
}

type Handler = (request: Request, env: unknown, id: number) => Promise<Response>;

let r2: ReturnType<typeof makeR2>;
let env: { R2_RENDERS: ReturnType<typeof makeR2>["binding"]; DB: object };

async function portraitHandler(): Promise<Handler> {
  const m = await import("../src/cast-media.js");
  return m.handleCastPortraitUpload as Handler;
}

function copyReq(srcKey: string): Request {
  return new Request("https://cf/api/cast/7/portrait", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from_chat_artifact: srcKey }),
  });
}

function bytesReq(mime: string, bytes: Uint8Array): Request {
  return new Request("https://cf/api/cast/7/portrait", {
    method: "POST",
    headers: { "content-type": mime },
    body: bytes,
  });
}

beforeEach(async () => {
  r2 = makeR2();
  env = { R2_RENDERS: r2.binding, DB: {} };
  // The existing portrait the row points at, and the chat artifact meant to replace it.
  await r2.binding.put(OLD_KEY, JPEG, { httpMetadata: { contentType: "image/jpeg" } });
  await r2.binding.put(SRC_KEY, PNG, { httpMetadata: { contentType: "image/png" } });
  r2.ops.length = 0;
  setPortrait.mockReset().mockResolvedValue(ROW);
});

describe("local#407 parity: the superseded portrait is deleted only after the replacement is durable", () => {
  // POSITIVE CONTROL. Runs first. Without it every "old object survives" assertion below is equally
  // consistent with a handler that never ran, or one that simply never deletes.
  it("CONTROL: on success the replacement is stored, the row is written, and only THEN is the old object deleted", async () => {
    const h = await portraitHandler();
    const res = await h(copyReq(SRC_KEY), env, 7);
    expect(res.status, `ops=${r2.ops.join(" ")}`).toBe(200);
    expect(setPortrait).toHaveBeenCalledTimes(1);
    expect(await r2.binding.head(NEW_PNG_KEY), "replacement not stored").not.toBeNull();
    expect(await r2.binding.head(OLD_KEY), "superseded object was not collected").toBeNull();
    // The ordering claim, stated as an ordering claim. Pre-fix produced the exact reverse.
    expect(r2.ops, "the delete of the old key must FOLLOW the put of the new key").toEqual([
      `put:${NEW_PNG_KEY}`,
      `delete:${OLD_KEY}`,
    ]);
  });

  it("CONTROL: a same-mime re-upload resolves to the same key, so there is nothing superseded to delete", async () => {
    const h = await portraitHandler();
    const res = await h(bytesReq("image/jpeg", JPEG), env, 7);
    expect(res.status, `ops=${r2.ops.join(" ")}`).toBe(200);
    // The guard on the FIX itself. Dropping the oldKey === newKey check turns this red: the handler
    // would delete the object its own put had just written in place.
    expect(r2.ops, "must not delete the key the put just overwrote").toEqual([`put:${OLD_KEY}`]);
    expect(await r2.binding.head(OLD_KEY), "the portrait the row points at is gone").not.toBeNull();
  });

  const DANGLING_CASES: Array<{
    name: string;
    arrange: () => void;
    req: () => Request;
    status: number;
    throws?: boolean;
  }> = [
    {
      name: "copy-register, source artifact missing (404 before any write)",
      arrange: () => {
        r2.store.delete(SRC_KEY);
      },
      req: () => copyReq(SRC_KEY),
      status: 404,
    },
    {
      name: "copy-register, source over the 16 MB cap (413 before any write)",
      arrange: () => {
        const big = new Uint8Array(16 * 1024 * 1024 + 1);
        big.set(PNG.subarray(0, 8), 0);
        r2.store.set(SRC_KEY, { bytes: big, contentType: "image/png" });
      },
      req: () => copyReq(SRC_KEY),
      status: 413,
    },
    {
      name: "copy-register, source mime not an allowed image (400 before any write)",
      arrange: () => {
        r2.store.set(SRC_KEY, { bytes: PNG, contentType: "text/html" });
      },
      req: () => copyReq(SRC_KEY),
      status: 400,
    },
    {
      name: "copy-register, the R2 write of the replacement throws",
      arrange: () => {
        r2.failPut.add(NEW_PNG_KEY);
      },
      req: () => copyReq(SRC_KEY),
      status: 0,
      throws: true,
    },
    {
      name: "copy-register, the row write produces no row (404 since cf#754; was 200 cast:null)",
      arrange: () => {
        setPortrait.mockResolvedValue(null);
      },
      req: () => copyReq(SRC_KEY),
      // cf#754 changed this STATUS and nothing else about this case. The claim below -- that the
      // superseded object survives a row write that produced nothing -- is the #753 claim and is
      // unchanged; only the expected literal moved, because a failed write now answers 404
      // instead of 200 { cast: null }. See tests/cast-row-write-404-754.test.ts.
      status: 404,
    },
    {
      name: "raw-bytes, the R2 write of the replacement throws",
      arrange: () => {
        r2.failPut.add(NEW_PNG_KEY);
      },
      req: () => bytesReq("image/png", PNG),
      status: 0,
      throws: true,
    },
    {
      name: "raw-bytes, the row write produces no row (404 since cf#754; was 200 cast:null)",
      arrange: () => {
        setPortrait.mockResolvedValue(null);
      },
      req: () => bytesReq("image/png", PNG),
      // Same as the copy-register case above: status literal only, claim untouched.
      status: 404,
    },
  ];

  for (const c of DANGLING_CASES) {
    it(`the row keeps pointing at a LIVE object: ${c.name}`, async () => {
      const h = await portraitHandler();
      c.arrange();

      let status = 0;
      let threw: unknown = null;
      try {
        status = (await h(c.req(), env, 7)).status;
      } catch (e) {
        threw = e;
      }

      const evidence = `${c.name} -> status=${status} threw=${String(threw)} ops=[${r2.ops.join(" ")}]`;

      if (c.throws) {
        expect(threw, `${evidence}: expected the R2 failure to surface`).not.toBeNull();
      } else {
        expect(status, evidence).toBe(c.status);
        expect(threw, evidence).toBeNull();
      }

      // THE CLAIM. `portrait_key` was never updated on any of these paths, so the object it names
      // must still exist. Pre-fix this object was already deleted.
      expect(
        await r2.binding.head(OLD_KEY),
        `${evidence}: portrait_key still names ${OLD_KEY} and the object is GONE -- ` +
          `a record that is internally consistent and points at nothing`,
      ).not.toBeNull();
      expect(
        r2.ops.filter((o) => o === `delete:${OLD_KEY}`),
        `${evidence}: nothing may delete the superseded object on a failed replacement`,
      ).toEqual([]);
    });
  }
});
