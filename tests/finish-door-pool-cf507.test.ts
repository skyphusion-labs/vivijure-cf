/// <reference types="node" />
// cf#507: TWO always-on upscale doors (propagandhi + fatmike), both bound, both served.
//
// WHY THIS FILE EXISTS AT ALL. cf#480 shipped ONE binding and a poll token that recorded WHICH
// ROUTE ("vpc") rather than WHICH BOX. With two doors that label is no longer sufficient: job
// state on these doors is per-process RAM (`JobRegistry._jobs` in runpod_http_serve.py), and a
// poll for an id the process does not hold returns 404, which `runpodJobGone` / `classifyGoneState`
// read as TERMINAL "job gone". So a poll landing on the WRONG BOX does not error -- it reports a
// running job as finished-and-vanished while the other box is still burning GPU on it.
//
// THE LOAD-BEARING ASSERTION IS THEREFORE AFFINITY, and it is tested as a CROSS-DOOR REFUSAL: a
// token minted against door A must never resolve to door B. Transport-level affinity (a cookie, a
// sticky source IP) cannot do this job -- the poll is a separate Worker invocation with no cookie
// jar and no stable source address -- which is why it is application-level and lives in the token.
//
// NON-DEFAULT PROBE VALUES throughout (cf#480 rule 4): distinct bearers per door, so "the
// propagandhi bearer went on the wire" is distinguishable from "a bearer went on the wire".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOOR_ROUTE_NAME,
  DOOR_ROUTE_PREFIX,
  LEGACY_DOOR_ROUTE_NAME,
  doorName,
  doorPool,
  usableDoors,
  pickDoor,
  resolveDoor,
  doorBound,
  doorProblem,
  tokenTookDoor,
  doorsFromEnv,
  hostnameLabel,
  parseDoorOrigins,
} from "../modules/_shared/finish-door";

/** Values that appear nowhere else in this repo, so a match cannot be a coincidence. */
const TOKEN_FATMIKE = "lft_cf507_fatmike_probe_3e71";
const TOKEN_PROPAGANDHI = "lft_cf507_propagandhi_probe_8b4d";

const FATMIKE = doorName("fatmike");
const PROPAGANDHI = doorName("propagandhi");

/** The shape both upscale modules declare: the LEGACY door first and explicitly marked. */
function candidates(opts: { fatmikeToken?: string; propagandhiToken?: string; dropPropagandhi?: boolean } = {}) {
  return [
    { name: FATMIKE, baseUrl: "https://finish-upscale-fatmike.test", token: opts.fatmikeToken ?? TOKEN_FATMIKE, legacy: true },
    { name: PROPAGANDHI, baseUrl: opts.dropPropagandhi ? "" : "https://finish-upscale-propagandhi.test", token: opts.propagandhiToken ?? TOKEN_PROPAGANDHI },
  ];
}

// ------------------------------------------------------------------------------------------- 1.
describe("cf507 pool: bound-ness still decides door-vs-RunPod, never failure", () => {
  it("no binding at all -> empty pool, which is the RunPod path", () => {
    const pool = doorPool([
      { name: FATMIKE, baseUrl: "", token: "", legacy: true },
      { name: PROPAGANDHI, baseUrl: "", token: "" },
    ]);
    expect(pool).toHaveLength(0);
  });

  it("both bound -> both in the pool, in declaration order", () => {
    const pool = doorPool(candidates());
    expect(pool.map((d) => d.name)).toEqual([FATMIKE, PROPAGANDHI]);
    expect(pool.every(doorBound)).toBe(true);
  });

  it("one bound, one not -> the pool is the bound one ONLY", () => {
    const pool = doorPool(candidates({ dropPropagandhi: true }));
    expect(pool.map((d) => d.name)).toEqual([FATMIKE]);
  });

  it("a bound door with no readable token stays BOUND and is excluded only from USABLE", () => {
    // The cf#480 rule, unchanged and load-bearing: a tokenless door must never read as unbound,
    // or a module mid-propagation would silently start renting RunPod again. It drops out of the
    // pick set, but the pool is still non-empty, so the caller still takes the door branch.
    const pool = doorPool(candidates({ propagandhiToken: "" }));
    expect(pool).toHaveLength(2);
    expect(doorProblem(pool[1])).toBe("door-token-not-yet-visible");
    expect(usableDoors(pool).map((d) => d.name)).toEqual([FATMIKE]);
  });

  it("EVERY bound door tokenless -> pool non-empty, usable empty (degrade, NOT a RunPod failover)", () => {
    const pool = doorPool(candidates({ fatmikeToken: "", propagandhiToken: "" }));
    expect(pool).toHaveLength(2);
    expect(usableDoors(pool)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------- 2.
describe("cf507 pick: round-robin over the usable doors", () => {
  it("rotates across both doors and repeats with period = pool size", () => {
    const pool = usableDoors(doorPool(candidates()));
    expect(pickDoor(pool, 0)!.name).toBe(FATMIKE);
    expect(pickDoor(pool, 1)!.name).toBe(PROPAGANDHI);
    expect(pickDoor(pool, 2)!.name).toBe(FATMIKE);
    expect(pickDoor(pool, 3)!.name).toBe(PROPAGANDHI);
  });

  it("BOTH doors are actually reachable -- the second box is not decorative (cf#507's whole point)", () => {
    const pool = usableDoors(doorPool(candidates()));
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(pickDoor(pool, i)!.name);
    expect([...seen].sort()).toEqual([FATMIKE, PROPAGANDHI].sort());
  });

  it("a single-door pool degenerates to the cf#480 behaviour exactly", () => {
    const pool = usableDoors(doorPool(candidates({ dropPropagandhi: true })));
    expect(pickDoor(pool, 0)!.name).toBe(FATMIKE);
    expect(pickDoor(pool, 7)!.name).toBe(FATMIKE);
  });

  it("an empty pool picks nothing rather than throwing", () => {
    expect(pickDoor([], 0)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- 3.
describe("cf507 AFFINITY: a token minted against door A never resolves to door B", () => {
  it("resolves each door to ITSELF", () => {
    const pool = doorPool(candidates());
    expect(resolveDoor(pool, FATMIKE)!.name).toBe(FATMIKE);
    expect(resolveDoor(pool, PROPAGANDHI)!.name).toBe(PROPAGANDHI);
  });

  it("THE LOAD-BEARING ONE: it never crosses, in either direction", () => {
    const pool = doorPool(candidates());
    // Stated as a refusal rather than a preference. If this ever crossed, the poll would 404 on a
    // job id the other box's registry has never held, runpodJobGone would read that as a GC'd job,
    // and past the grace window the shot FAILS -- destroyed work wearing a legitimate verdict.
    expect(resolveDoor(pool, FATMIKE)!.name).not.toBe(PROPAGANDHI);
    expect(resolveDoor(pool, PROPAGANDHI)!.name).not.toBe(FATMIKE);
    expect(resolveDoor(pool, PROPAGANDHI)!.token).toBe(TOKEN_PROPAGANDHI);
    expect(resolveDoor(pool, FATMIKE)!.token).toBe(TOKEN_FATMIKE);
  });

  it("a door named by the token but NOT bound by this deploy resolves to nothing", () => {
    // The binding was removed while the job was in flight. Refusing is the only honest answer;
    // the caller turns this into a named error rather than guessing a sibling door.
    const pool = doorPool(candidates({ dropPropagandhi: true }));
    expect(resolveDoor(pool, PROPAGANDHI)).toBeNull();
  });

  it("never re-picks: resolve is a lookup, so it is stable across repeated calls", () => {
    const pool = doorPool(candidates());
    const names = new Set<string>();
    for (let i = 0; i < 16; i++) names.add(resolveDoor(pool, PROPAGANDHI)!.name);
    expect([...names]).toEqual([PROPAGANDHI]);
  });
});

// ------------------------------------------------------------------------------------------- 4.
describe("cf507 BACK-COMPAT: a bare 'vpc' token predates the pool and is still in flight", () => {
  it("new mints use door; in-flight vpc still resolves to the LEGACY door", () => {
    // Load-bearing. Tokens minted before the prefix change carry `vpc` and are in flight RIGHT
    // NOW. Resolving one to the wrong box is the same destroyed-work failure as a crossed poll.
    const pool = doorPool(candidates());
    expect(DOOR_ROUTE_NAME).toBe("door");
    expect(LEGACY_DOOR_ROUTE_NAME).toBe("vpc");
    expect(resolveDoor(pool, DOOR_ROUTE_NAME)!.name).toBe(FATMIKE);
    expect(resolveDoor(pool, LEGACY_DOOR_ROUTE_NAME)!.name).toBe(FATMIKE);
    expect(resolveDoor(pool, DOOR_ROUTE_NAME)!.legacy).toBe(true);
  });

  it("bare door and bare vpc both count as a door token", () => {
    expect(tokenTookDoor(DOOR_ROUTE_NAME)).toBe(true);
    expect(tokenTookDoor(LEGACY_DOOR_ROUTE_NAME)).toBe(true);
    expect(tokenTookDoor("vpc-fatmike")).toBe(true);
    expect(tokenTookDoor("door-fatmike")).toBe(true);
  });

  it("a per-door label counts as a door token", () => {
    expect(tokenTookDoor(FATMIKE)).toBe(true);
    expect(tokenTookDoor(PROPAGANDHI)).toBe(true);
  });

  it("a token with NO route label is RunPod, unchanged", () => {
    expect(tokenTookDoor(undefined)).toBe(false);   // every pre-cf480 token
    expect(tokenTookDoor("")).toBe(false);
    expect(tokenTookDoor("runpod")).toBe(false);
  });

  it("the prefix match is exact-with-separator, not a loose startsWith", () => {
    // A door name is `vpc-<host>`. `vpcfoo` shares the prefix and is NOT a door; asserting this
    // keeps the matcher from drifting into the suffix/prefix trap that has bitten this crew.
    expect(tokenTookDoor(DOOR_ROUTE_PREFIX + "foo")).toBe(false);
    expect(tokenTookDoor(DOOR_ROUTE_PREFIX + "-")).toBe(true);
  });

  it("bare 'vpc' resolves to NOTHING when no door is marked legacy", () => {
    // A deploy that binds only a NEW door cannot honestly claim an old token belongs to it.
    const pool = doorPool([{ name: PROPAGANDHI, baseUrl: "https://finish-upscale-propagandhi.test", token: TOKEN_PROPAGANDHI }]);
    expect(resolveDoor(pool, DOOR_ROUTE_NAME)).toBeNull();
    expect(resolveDoor(pool, LEGACY_DOOR_ROUTE_NAME)).toBeNull();
  });

  it("an in-flight vpc-<host> label resolves to the door whose hostname is that host", () => {
    const pool = doorPool(candidates());
    expect(resolveDoor(pool, "vpc-propagandhi")!.name).toBe(PROPAGANDHI);
    expect(resolveDoor(pool, "vpc-fatmike")!.name).toBe(FATMIKE);
  });
});

describe("doorsFromEnv: origins are config, never code", () => {
  const DOORS = "https://finish-upscale-fatmike.test,https://finish-upscale-propagandhi.test";

  it("empty / missing var is an empty candidate list (the RunPod path)", () => {
    expect(doorsFromEnv({}, "FINISH_UPSCALE_DOORS", TOKEN_FATMIKE)).toEqual([]);
    expect(doorsFromEnv({ FINISH_UPSCALE_DOORS: "" }, "FINISH_UPSCALE_DOORS", TOKEN_FATMIKE)).toEqual([]);
    expect(doorsFromEnv({ FINISH_UPSCALE_DOORS: "   " }, "FINISH_UPSCALE_DOORS", TOKEN_FATMIKE)).toEqual([]);
  });

  it("first URL is the legacy door; later URLs take door-<hostnameLabel>", () => {
    const list = doorsFromEnv({ FINISH_UPSCALE_DOORS: DOORS }, "FINISH_UPSCALE_DOORS", {
      legacy: TOKEN_FATMIKE,
      byName: { propagandhi: TOKEN_PROPAGANDHI },
    });
    expect(list.map((c) => c.name)).toEqual([DOOR_ROUTE_NAME, PROPAGANDHI]);
    expect(list[0].legacy).toBe(true);
    expect(list[1].legacy).toBe(false);
    expect(list[0].token).toBe(TOKEN_FATMIKE);
    expect(list[1].token).toBe(TOKEN_PROPAGANDHI);
    expect(list[0].baseUrl).toBe("https://finish-upscale-fatmike.test");
  });

  it("a single token string applies to every door", () => {
    const list = doorsFromEnv({ FINISH_UPSCALE_DOORS: DOORS }, "FINISH_UPSCALE_DOORS", TOKEN_FATMIKE);
    expect(list.every((c) => c.token === TOKEN_FATMIKE)).toBe(true);
  });

  it("hostnameLabel reads the last hyphen-separated label", () => {
    expect(hostnameLabel("https://finish-upscale-fatmike.test")).toBe("fatmike");
    expect(hostnameLabel("https://finish-blender-descendents.example")).toBe("descendents");
  });

  it("parseDoorOrigins drops non-HTTPS and junk", () => {
    expect(parseDoorOrigins("http://insecure.test,not-a-url,https://ok.test/path")).toEqual(["https://ok.test"]);
  });
});

describe("finish-door.ts must not bake a production hostname", () => {
  it("fails if someone re-adds a skyphusion.org origin, DOOR_ORIGIN, or VIDEO_FINISH_SUBMIT", () => {
    const src = readFileSync(join(__dirname, "../modules/_shared/finish-door.ts"), "utf8");
    expect(src).not.toMatch(/skyphusion\.org/);
    expect(src).not.toMatch(/\bDOOR_ORIGIN\b/);
    expect(src).not.toMatch(/\bVIDEO_FINISH_SUBMIT\b/);
  });
});
