// The media door Workers' bearer check (containers/<name>/cf-container/src/gate.ts).
//
// Two halves, the same shape as tests/container-bearer-gate.test.py for bearer.py: every door
// vendors the SAME gate and wires it, and the gate itself refuses what it must. The handler rows
// drive a real door Worker's default export, so they test the wiring, not only the helper.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerOk, equalDigests, presentedBearer, readyBody } from "../containers/image-prep/cf-container/src/gate";
// The door Worker entry is loaded by a runtime path, not a static import, so the root tsc does not
// typecheck the cf-container packages; each is its own wrangler project with its own types.
const IMAGE_PREP_ENTRY = "../containers/image-prep/cf-container/src/index";
type DoorWorker = { fetch(request: Request, env: unknown): Promise<Response> };
const imagePrep = async (): Promise<DoorWorker> => ((await import(/* @vite-ignore */ IMAGE_PREP_ENTRY)) as { default: DoorWorker }).default;

const CONTAINERS = join(__dirname, "..", "containers");
const doors = readdirSync(CONTAINERS).filter((d) => existsSync(join(CONTAINERS, d, "cf-container", "src", "index.ts")));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const TOKEN = "door-token-not-a-real-value";

afterEach(() => vi.restoreAllMocks());

describe("every door Worker vendors the same gate and uses it", () => {
  it("the derivation found the five doors (a zero here would pass everything below)", () => {
    expect(doors.sort()).toEqual(["audio-beat-sync", "audio-master", "audio-mix", "image-prep", "video-finish"]);
  });

  const ref = sha(join(CONTAINERS, "image-prep", "cf-container", "src", "gate.ts"));
  for (const d of doors) {
    it(`${d}: gate.ts is byte-identical, and index.ts gates with it`, () => {
      expect(sha(join(CONTAINERS, d, "cf-container", "src", "gate.ts"))).toBe(ref);
      const src = readFileSync(join(CONTAINERS, d, "cf-container", "src", "index.ts"), "utf8");
      expect(src).toMatch(/import \{ bearerOk, readyBody \} from "\.\/gate";/);
      expect(src).toMatch(/await bearerOk\(request\.headers\.get\("authorization"\), env\.LOCAL_FINISH_TOKEN\)/);
      expect(src).toMatch(/Response\.json\(readyBody\(env\.LOCAL_FINISH_TOKEN\)\)/);
      expect(src).not.toMatch(/token_len|expected !== got|function bearer\(/);
    });
  }
});

describe("the compare is over digests, never over the raw values", () => {
  // Constant time is not observable from a unit test's answers: a plain `===` gives the same
  // true/false. So this row holds the SHAPE that makes it constant time.
  it("bearerOk decides with equalDigests over two SHA-256 digests", () => {
    const src = readFileSync(join(CONTAINERS, "image-prep", "cf-container", "src", "gate.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function bearerOk"), src.indexOf("export function readyBody"));
    expect(body).toMatch(/return equalDigests\(await digest\(got\), await digest\(want\)\);/);
    expect(body).not.toMatch(/got\s*[!=]==?\s*want|want\s*[!=]==?\s*got/);
    expect(src).toMatch(/crypto\.subtle\.digest\("SHA-256"/);
  });
});

describe("bearerOk", () => {
  it("accepts exactly the configured token, with the scheme in any case", async () => {
    expect(await bearerOk("Bearer " + TOKEN, TOKEN)).toBe(true);
    expect(await bearerOk("bearer " + TOKEN, TOKEN)).toBe(true);
  });

  it("refuses a wrong token of the same length, and of a different length", async () => {
    const same = TOKEN.slice(0, -1) + (TOKEN.endsWith("e") ? "f" : "e");
    expect(same.length).toBe(TOKEN.length);
    expect(await bearerOk("Bearer " + same, TOKEN)).toBe(false);
    expect(await bearerOk("Bearer " + TOKEN + "x", TOKEN)).toBe(false);
    expect(await bearerOk("Bearer " + TOKEN.slice(0, 4), TOKEN)).toBe(false);
  });

  it("refuses no header, another scheme, and an empty bearer", async () => {
    expect(await bearerOk(null, TOKEN)).toBe(false);
    expect(await bearerOk(TOKEN, TOKEN)).toBe(false);
    expect(await bearerOk("Basic " + TOKEN, TOKEN)).toBe(false);
    // Seven characters, like "Bearer ": a check that only strips a prefix would accept this one.
    expect(await bearerOk("Tokenx " + TOKEN, TOKEN)).toBe(false);
    expect(await bearerOk("Bearer ", TOKEN)).toBe(false);
  });

  it("with NO token configured, nothing is accepted, not even an empty match", async () => {
    for (const expected of [undefined, ""]) {
      expect(await bearerOk("Bearer ", expected)).toBe(false);
      expect(await bearerOk("Bearer anything", expected)).toBe(false);
    }
  });

  it("presentedBearer keeps the value exactly as sent after the scheme", () => {
    expect(presentedBearer("Bearer a b")).toBe("a b");
    expect(presentedBearer(null)).toBe("");
  });
});

describe("equalDigests compares in constant time on both paths", () => {
  const a = new Uint8Array(32).fill(7);
  const b = new Uint8Array(32).fill(7);
  const c = new Uint8Array(32).fill(7);
  c[31] = 8;

  it("the fallback (no timingSafeEqual) is a full-length compare", () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
    expect(subtle.timingSafeEqual).toBeUndefined();
    expect(equalDigests(a, b)).toBe(true);
    expect(equalDigests(a, c)).toBe(false);
    expect(equalDigests(a, new Uint8Array(31))).toBe(false);
  });

  it("uses the runtime's timingSafeEqual when the runtime has one", () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
    const tse = vi.fn(() => true);
    subtle.timingSafeEqual = tse;
    try {
      expect(equalDigests(a, c)).toBe(true); // the stub's answer, so the stub was what decided
      expect(tse).toHaveBeenCalledWith(a, c);
    } finally {
      Reflect.deleteProperty(subtle, "timingSafeEqual");
    }
  });
});

describe("the real door Worker handler", () => {
  const env = { LOCAL_FINISH_TOKEN: TOKEN, PREP: {} } as never;
  const call = async (path: string, init?: RequestInit, e: unknown = env) =>
    (await imagePrep()).fetch(new Request("https://image-prep.example" + path, init), e);

  it("GET /ready reports readiness as booleans only, nothing derived from the token", async () => {
    const body = (await (await call("/ready")).json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, token_configured: true });
    expect(JSON.stringify(body)).not.toContain(String(TOKEN.length));
    expect(readyBody(undefined)).toEqual({ ok: true, token_configured: false });
  });

  it("a wrong token, no token, and a door with no token configured are all 401", async () => {
    expect((await call("/portrait/prep", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/portrait/prep", { method: "POST" })).status).toBe(401);
    const unconfigured = { LOCAL_FINISH_TOKEN: "", PREP: {} } as never;
    expect((await call("/portrait/prep", { method: "POST", headers: { authorization: "Bearer " } }, unconfigured)).status).toBe(401);
  });
});
