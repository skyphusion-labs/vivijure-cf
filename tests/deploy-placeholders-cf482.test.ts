/// <reference types="node" />
// cf#482: the module-toml placeholder fill, as a GUARD rather than a hope.
//
// WHY THIS FILE EXISTS. `scripts/deploy-module-workers.sh` runs in exactly one place -- a TAG
// deploy -- so every defect in it was invisible until a release, which is the worst possible
// moment to find one. The placeholder fill was split into `scripts/fill-module-placeholders.sh`
// (no network, no wrangler) precisely so it could be driven here, and these cases drive the
// SHIPPED script and the SHIPPED awk, never a re-implementation of them.
//
// THE DEFECT THAT PROMPTED IT. The old check was a bare `grep -q "REPLACE_WITH_"` followed by
// `exit 1`. That matches inside a `#` comment and aborts the whole module loop, so ONE commented-
// out example block in ONE module toml failed the deploy for EVERY module after it -- and the
// message said `store_id placeholder survived` while guarding five placeholder families, sending
// an operator to the Secrets Store for a VPC problem.
//
// THE HARDER HALF, and the reason this is not just a grep fix: an OPTIONAL binding has to be
// optional all the way down. A `[[vpc_services]]` block naming a service id that does not exist
// dangles the deploy, so if the block cannot be REMOVED when its id is unset, the module's unbound
// branch is unreachable in production and the compatibility guarantee it rests on is fiction.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/fill-module-placeholders.sh";

// Every case needs a scratch copy, because the script edits IN PLACE. Left behind, that is one
// directory per case per run, local and in CI, forever -- 234 had accumulated on the crew box
// before a close-out sweep found them. A suite that leaks debris also makes the NEXT person's
// debris audit lie about who owns what, so it is tracked and removed rather than left to /tmp.
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function run(toml: string, env: Record<string, string>): { status: number; out: string; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "vivijure-cf482-"));
  scratch.push(dir);
  const path = join(dir, "wrangler.toml");
  writeFileSync(path, toml);
  try {
    const out = execFileSync("sh", [SCRIPT, path], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { status: 0, out, text: readFileSync(path, "utf8") };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, text: readFileSync(path, "utf8") };
  }
}

/** Required ids present, so a case can isolate the ONE thing it is about. */
const REQ = {
  SECRETS_STORE_ID: "store_cf482",
  D1_DATABASE_ID: "d1_cf482",
  VPC_VIDEO_FINISH_ID: "vf_cf482",
  VPC_AUDIO_BEAT_SYNC_ID: "bs_cf482",
  VPC_AUDIO_MASTER_ID: "am_cf482",
  VPC_FINISH_UPSCALE_ID: "",
  VPC_SPEECH_UPSCALE_ID: "",
};

const OPTIONAL_TOML = `# header comment
name = "vivijure-module-probe"
main = "src/index.ts"

[observability]
enabled = true

[[d1_databases]]
binding = "TELEMETRY_DB"
database_id = "REPLACE_WITH_D1_DATABASE_ID"

[[vpc_services]]
# cf482-optional:VPC_FINISH_UPSCALE_ID
binding = "FINISH_UPSCALE_VPC"
service_id = "REPLACE_WITH_VPC_FINISH_UPSCALE_ID"
remote = true

[[secrets_store_secrets]]
# cf482-optional:VPC_FINISH_UPSCALE_ID
binding = "FINISH_DOOR_TOKEN"
store_id = "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID"
secret_name = "FINISH_DOOR_TOKEN"

[vars]
RUNPOD_WORKERS_MAX = "2"
`;

// ------------------------------------------------------------------------------------------- 1.
describe("an OPTIONAL binding is optional all the way down", () => {
  it("UNSET strips BOTH of its blocks and deploys", () => {
    const r = run(OPTIONAL_TOML, REQ);
    expect(r.status).toBe(0);
    expect(r.text).not.toContain("FINISH_UPSCALE_VPC");
    // The half a block-type-keyed stripper would have missed: the bearer's Secrets Store block.
    // Left behind, wrangler resolves a store entry that need not exist and the deploy fails.
    expect(r.text).not.toContain("FINISH_DOOR_TOKEN");
    expect(r.text).not.toContain("REPLACE_WITH_");
  });

  it("UNSET leaves everything else BYTE-IDENTICAL, so an operator with no door is unaffected", () => {
    const r = run(OPTIONAL_TOML, REQ);
    // The compatibility guarantee, asserted rather than assumed.
    expect(r.text).toContain('name = "vivijure-module-probe"');
    expect(r.text).toContain("[observability]");
    expect(r.text).toContain('database_id = "d1_cf482"');
    expect(r.text).toContain('RUNPOD_WORKERS_MAX = "2"');
    expect(r.text).toContain("# header comment");
  });

  it("SET keeps both blocks and fills the id", () => {
    const r = run(OPTIONAL_TOML, { ...REQ, VPC_FINISH_UPSCALE_ID: "vpc_door_cf482" });
    expect(r.status).toBe(0);
    expect(r.text).toContain('service_id = "vpc_door_cf482"');
    expect(r.text).toContain('binding = "FINISH_UPSCALE_VPC"');
    expect(r.text).toContain('binding = "FINISH_DOOR_TOKEN"');
    expect(r.text).not.toContain("REPLACE_WITH_");
  });

  it("logs the strip -- a degrade is never silent", () => {
    const r = run(OPTIONAL_TOML, REQ);
    expect(r.out).toMatch(/VPC_FINISH_UPSCALE_ID unset/);
  });

  it("REFUSES when the marker is present but no block carries it", () => {
    // A renamed or half-deleted binding. The stripper exits 3 rather than emitting its input
    // unchanged, because a filter that matches nothing is byte-identical to a successful no-op.
    // The marker sits in the PREAMBLE, which is never dropped, so no block carries it.
    const broken = `# cf482-optional:VPC_FINISH_UPSCALE_ID\nname = "x"\n\n[vars]\nA = "1"\n`;
    const r = run(broken, REQ);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("refusing rather than deploying a dangling binding");
  });

  it("never drops the PREAMBLE, even when the marker appears in a header comment", () => {
    // The first version of this case put the marker ONLY in the preamble, which made dropped=0, so
    // the script REFUSED and left the file untouched -- and the assertion passed because of the
    // refusal rather than because the preamble was preserved. It would have passed identically
    // with the preamble guard deleted. A real marked block is present here so the strip actually
    // runs and the preamble has a chance to be wrongly dropped.
    const t = `# see cf482-optional:VPC_FINISH_UPSCALE_ID for why\nname = "keepme"\n` + OPTIONAL_TOML.slice(OPTIONAL_TOML.indexOf("\n[observability]"));
    const r = run(t, REQ);
    expect(r.status).toBe(0);
    expect(r.text).toContain('name = "keepme"');
    expect(r.text).toContain("# see cf482-optional:VPC_FINISH_UPSCALE_ID for why");
    expect(r.text).not.toContain("FINISH_UPSCALE_VPC");   // the real block still went
  });
});

// ------------------------------------------------------------------------------------------- 2.
describe("the survivor check is COMMENT-AWARE (the headline defect)", () => {
  it("a COMMENTED placeholder does not fail the deploy", () => {
    const t = `name = "x"\n# example: service_id = "REPLACE_WITH_VPC_SOME_FUTURE_ID"\n\n[vars]\nA = "1"\n`;
    const r = run(t, REQ);
    expect(r.status).toBe(0);
  });

  it("CONTROL: an UNCOMMENTED one still fails, so the fix did not disarm the guard", () => {
    const t = `name = "x"\n\n[vars]\nservice_id = "REPLACE_WITH_VPC_SOME_FUTURE_ID"\n`;
    const r = run(t, REQ);
    expect(r.status).not.toBe(0);
  });

  it("indented comments count as comments too", () => {
    const t = `name = "x"\n\n[vars]\n   # REPLACE_WITH_VPC_SOME_FUTURE_ID\nA = "1"\n`;
    expect(run(t, REQ).status).toBe(0);
  });

  it("names WHAT survived and WHERE, instead of blaming store_id for a VPC problem", () => {
    const t = `name = "x"\n\n[vars]\nservice_id = "REPLACE_WITH_VPC_SOME_FUTURE_ID"\n`;
    const r = run(t, REQ);
    expect(r.out).toContain("REPLACE_WITH_VPC_SOME_FUTURE_ID");
    expect(r.out).toContain("wrangler.toml");
    // The old message. It named one of five families and sent operators to the wrong subsystem.
    expect(r.out).not.toContain("store_id placeholder survived");
  });
});

// ------------------------------------------------------------------------------------------- 3.
describe("REQUIRED bindings keep refusing -- the fix must not delete a working guard", () => {
  it("an unset REQUIRED VPC id still fails the deploy", () => {
    const t = `name = "x"\n\n[[vpc_services]]\nbinding = "AUDIO_MASTER_VPC"\nservice_id = "REPLACE_WITH_VPC_AUDIO_MASTER_ID"\n`;
    const r = run(t, { ...REQ, VPC_AUDIO_MASTER_ID: "" });
    // The script must REFUSE, not substitute an empty id: blanking the placeholder deletes the
    // evidence the survivor check looks for, and the module deploys with `service_id = ""`.
    // audio-master reaches its container ONLY over this binding; unbound it soft-degrades and the
    // film ships without the master phase. Making every VPC id optional would have shipped that
    // silently, which is a symptom-shaped fix deleting the control.
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("REPLACE_WITH_VPC_AUDIO_MASTER_ID");
  });
});

// ------------------------------------------------------------------------------------------- 4.
describe("DENOMINATOR: the shipped tomls and the script's optional list agree", () => {
  const script = readFileSync(SCRIPT, "utf8");

  it("POSITIVE CONTROL: the marker extractor finds a marker in a known file", () => {
    const t = readFileSync("modules/finish-upscale/wrangler.toml", "utf8");
    expect(t.match(/cf482-optional:[A-Z0-9_]+/g)?.length).toBeGreaterThan(0);
  });

  it("every marker declared in a module toml is handled by the script", () => {
    const declared = new Set<string>();
    for (const m of readdirSync("modules")) {
      let t: string;
      try { t = readFileSync(`modules/${m}/wrangler.toml`, "utf8"); } catch { continue; }
      for (const hit of t.match(/cf482-optional:([A-Z0-9_]+)/g) ?? []) declared.add(hit.split(":")[1]);
    }
    // A third optional binding cannot be added without either wiring it here or turning this red.
    // Without this, an unhandled marker leaves its placeholder unfilled and the deploy fails on a
    // tag, which is the failure this whole file exists to move earlier.
    const unhandled = [...declared].filter((v) => !script.includes(v));
    expect(unhandled, `optional markers no script branch handles: ${unhandled.join(", ")}`).toEqual([]);
    expect(declared.size).toBeGreaterThan(0);   // a zero here would make the assertion vacuous
  });

  it("each declared marker covers MORE THAN ONE block, or the multi-block strip is untested", () => {
    const t = readFileSync("modules/finish-upscale/wrangler.toml", "utf8");
    expect((t.match(/cf482-optional:VPC_FINISH_UPSCALE_ID/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------------------------------------- 5.
describe("the REAL shipped tomls render clean with no door configured (today's state)", () => {
  /** Every `binding = "X"` in a toml, in order. */
  const bindings = (s: string) => (s.match(/^binding = "([^"]+)"/gm) ?? []).map((l) => l.split('"')[1]);

  for (const m of ["finish-upscale", "speech-upscale"]) {
    it(`${m} fills with zero survivors and no door binding`, () => {
      const r = run(readFileSync(`modules/${m}/wrangler.toml`, "utf8"), REQ);
      expect(r.status).toBe(0);
      expect(r.text).not.toContain("REPLACE_WITH_");
      expect(r.text).not.toContain("_UPSCALE_VPC");
      expect(r.text).not.toContain("DOOR_TOKEN");
      expect(r.text).toContain(`name = "vivijure-module-${m}"`);
    });

    // cf#484. THE ASSERTION THAT WAS MISSING, and its absence let a real defect merge: the case
    // above checks the door bindings are GONE and the module NAME survives, which is what I was
    // thinking about -- it says nothing about the module's OTHER bindings. The stripper was
    // deleting RUNPOD_ENDPOINT_ID from finish-upscale (5 bindings -> 2 where 3 is correct),
    // because a sentence in the toml mentioning the marker sits ABOVE [[vpc_services]] and comment
    // lines preceding a header belong to the block BEFORE it. On a tag deploy that module ships
    // with no endpoint id and every upscale job soft-degrades to passthrough -- a silent
    // capability loss.
    //
    // DERIVED, not a hand-written expected list: read the bindings out of the source, subtract the
    // ones the marked blocks declare, and require exactly that. A hardcoded list would have to be
    // updated by the same person who broke this, at the same moment.
    it(`${m} loses EXACTLY its door bindings and nothing else`, () => {
      const src = readFileSync(`modules/${m}/wrangler.toml`, "utf8");
      const before = bindings(src);
      const r = run(src, REQ);
      const after = bindings(r.text);

      // The bindings declared inside a block that carries a whole-line marker.
      const doorBindings = new Set<string>();
      for (const block of src.split(/^(?=\[)/m)) {
        if (/^[ \t]*#[ \t]*cf482-optional:[A-Z0-9_]+[ \t]*$/m.test(block)) {
          for (const b of bindings(block)) doorBindings.add(b);
        }
      }
      expect(doorBindings.size, "no marked blocks found -- the derivation is vacuous").toBeGreaterThan(0);

      expect(after).toEqual(before.filter((b) => !doorBindings.has(b)));
      // Named explicitly too, because this is the one that was actually lost and a set comparison
      // reads past a single missing element easily.
      expect(after).toContain("RUNPOD_ENDPOINT_ID");
    });
  }

  it("PROSE mentioning a marker does not arm the strip (cf#484 root cause)", () => {
    // The exact shape that shipped: a sentence naming the marker, sitting above the marked block
    // and therefore inside the PRECEDING one. Before the fix this deleted the preceding block.
    const t = `name = "x"

[[secrets_store_secrets]]
binding = "KEEP_ME"
secret_name = "KEEP_ME"
# Both blocks carry the marker \`cf482-optional:VPC_FINISH_UPSCALE_ID\` so the stripper knows.

[[vpc_services]]
# cf482-optional:VPC_FINISH_UPSCALE_ID
binding = "GO_AWAY"
service_id = "REPLACE_WITH_VPC_FINISH_UPSCALE_ID"
`;
    const r = run(t, REQ);
    expect(r.status).toBe(0);
    expect(r.text).toContain('binding = "KEEP_ME"');   // the block the prose landed in
    expect(r.text).not.toContain('binding = "GO_AWAY"');
  });

  it("an indented whole-line marker still arms it, so the fix did not over-tighten", () => {
    const t = `name = "x"\n\n[[vpc_services]]\n   # cf482-optional:VPC_FINISH_UPSCALE_ID\nbinding = "GO_AWAY"\nservice_id = "REPLACE_WITH_VPC_FINISH_UPSCALE_ID"\n`;
    const r = run(t, REQ);
    expect(r.status).toBe(0);
    expect(r.text).not.toContain("GO_AWAY");
  });
});
