// cf#1246 panel half: prices at cost, read from each door's REAL manifest (its own worker serves
// module.json), so these tests read what the registry serves and not a copy. Conrad, 2026-11-05: show
// each module's price at cost with no markup until an end-user markup is set; "price unknown" when absent.
import { describe, expect, it } from "vitest";
import { clipPrice, doorSeconds, priceText, rateLine, resolutionFor, sceneSeconds, type Mod } from "../public/make-style.js";
import alibabaWan from "../modules/alibaba-wan/src/index";
import cfHailuo from "../modules/cf-hailuo/src/index";
import infinitetalk from "../modules/infinitetalk/src/index";
import cfSeedance from "../modules/cf-seedance/src/index";
import cfKlingV4 from "../modules/cf-kling-v4/src/index";

type Worker = { fetch(req: Request, env: never, ctx: never): Promise<Response> };
type Clip = { usd: number; resolution?: string; seconds?: number };
const manifest = async (w: unknown): Promise<Mod> =>
  (await (await (w as Worker).fetch(new Request("https://m/module.json"), {} as never, {} as never)).json()) as Mod;
const clipsOf = (m: Mod) => (m.ui as { cost_usd_per_clip: Clip[] }).cost_usd_per_clip;

describe("each scene is priced at the length the door really makes", () => {
  it("alibaba-wan rounds a shot up to 5, 10 or 15 seconds, so a 7 second scene costs 10 seconds", async () => {
    const m = await manifest(alibabaWan);
    expect(doorSeconds(m, 7)).toBe(10);
    expect(doorSeconds(m, 15)).toBe(15);
    expect(doorSeconds(m, 40)).toBe(15);
    const rate = (m.ui as { cost_usd_per_second: number[] }).cost_usd_per_second;
    expect(clipPrice(m, [7], "draft").usd).toBe(Number((rate[0] * 10).toFixed(2)));
  });

  it("cf-hailuo prices per clip on the picked resolution and the rounded length", async () => {
    const m = await manifest(cfHailuo);
    const res = resolutionFor(m, "draft")!.value;
    const at = (secs: number) => clipsOf(m).find((c) => c.resolution === res && c.seconds === secs)!.usd;
    expect(clipPrice(m, [6, 8], "draft")).toEqual({ usd: Number((at(6) + at(10)).toFixed(2)), kind: "about" });
  });

  it("no matching clip price is price unknown, never a guess", async () => {
    const m = await manifest(cfHailuo);
    const res = resolutionFor(m, "best")!.value;
    // Only meaningful if the manifest really lacks a 10 second clip at its top resolution.
    expect(clipsOf(m).some((c) => c.resolution === res && c.seconds === 10)).toBe(false);
    const p = clipPrice(m, [10], "best");
    expect(p.usd).toBeNull();
    expect(priceText(p)).toBe("price unknown");
  });

  it("a per-clip price with no length or resolution counts every scene once", async () => {
    const m = await manifest(infinitetalk);
    expect(clipPrice(m, [3, 9, 4], "good").usd).toBe(Number((clipsOf(m)[0].usd * 3).toFixed(2)));
  });

  it("cf-seedance states no price on purpose, so it stays unknown", async () => {
    const m = await manifest(cfSeedance);
    expect(clipPrice(m, [5], "good").usd).toBeNull();
    expect(rateLine(m)).toBe("Price unknown");
  });

  it("a board's scenes give their own seconds", () => {
    expect(sceneSeconds({ clip_seconds: 5, scenes: [{ prompt: "a", target_seconds: 7 }, { prompt: "b" }, { prompt: " " }] })).toEqual([7, 5]);
  });
});

describe("the door card's price line, at cost", () => {
  it("a per-second door shows its range", async () => {
    expect(rateLine(await manifest(cfKlingV4)).startsWith("$0.157 to $0.235 a second, at cost")).toBe(true);
  });
  it("a per-clip door shows its lowest clip", async () => {
    const m = await manifest(cfHailuo);
    const low = Math.min(...clipsOf(m).map((c) => c.usd));
    expect(rateLine(m).startsWith("from $" + low.toFixed(2) + " a clip, at cost")).toBe(true);
  });
  it("the day the price was read is shown when the door states it", () => {
    const m = { name: "x", ui: { cost_usd_per_second: [0.04, 0.07], cost_as_of: "2026-11-05" } } as Mod;
    expect(rateLine(m)).toBe("$0.04 to $0.07 a second, at cost (price as of Nov 5, 2026)");
  });
  it("a malformed day is left out, not shown wrong", () => {
    const m = { name: "x", ui: { cost_usd_per_second: [0.04, 0.04], cost_as_of: "Nov 5" } } as Mod;
    expect(rateLine(m)).toBe("$0.04 a second, at cost");
  });
});
