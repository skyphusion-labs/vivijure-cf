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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

/** Store / D1 fills, so a case can isolate the ONE thing it is about. */
const REQ = {
  SECRETS_STORE_ID: "store_cf482",
  D1_DATABASE_ID: "d1_cf482",
};

const VPC_LEFTOVER = `name = "vivijure-module-probe"
[[vpc_services]]
binding = "FINISH_UPSCALE_VPC"
service_id = "REPLACE_WITH_VPC_FINISH_UPSCALE_ID"
`;

// ------------------------------------------------------------------------------------------- 1.
describe("hosted no longer fills Workers VPC", () => {
  it("REFUSES a leftover [[vpc_services]] block", () => {
    const r = run(VPC_LEFTOVER, REQ);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/vpc_services/);
  });

  it("REFUSES a leftover REPLACE_WITH_VPC_* even without a vpc_services header", () => {
    const r = run(`name = "x"\n[vars]\nservice_id = "REPLACE_WITH_VPC_AUDIO_MASTER_ID"\n`, REQ);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("REPLACE_WITH_VPC_AUDIO_MASTER_ID");
  });

  it("REFUSES a leftover ${VPC_ interpolation", () => {
    const r = run(`name = "x"\n[vars]\nservice_id = "\${VPC_AUDIO_MASTER_ID}"\n`, REQ);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/VPC_AUDIO_MASTER_ID/);
  });

  it("fills a door-list / media URL from env, and empty when unset", () => {
    const t = `name = "x"\n[vars]\nFINISH_UPSCALE_DOORS = "\${FINISH_UPSCALE_DOORS}"\nVIDEO_FINISH_URL = "\${VIDEO_FINISH_URL}"\n`;
    const empty = run(t, REQ);
    expect(empty.status).toBe(0);
    expect(empty.text).toContain('FINISH_UPSCALE_DOORS = ""');
    expect(empty.text).toContain('VIDEO_FINISH_URL = ""');
    const set = run(t, { ...REQ, FINISH_UPSCALE_DOORS: "https://finish-upscale-fatmike.test", VIDEO_FINISH_URL: "https://video-finish.test" });
    expect(set.status).toBe(0);
    expect(set.text).toContain('FINISH_UPSCALE_DOORS = "https://finish-upscale-fatmike.test"');
    expect(set.text).toContain('VIDEO_FINISH_URL = "https://video-finish.test"');
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
describe("R2 S3 identifiers fill from the account id (cf-grok-video ZDR)", () => {
  const GROK_VARS = `[vars]
R2_S3_ENDPOINT = "REPLACE_WITH_R2_S3_ENDPOINT"
R2_S3_BUCKET = "REPLACE_WITH_R2_S3_BUCKET"
`;

  it("derives the endpoint from CLOUDFLARE_ACCOUNT_ID and defaults the bucket", () => {
    const r = run(`name = "vivijure-module-cf-grok-video"\n${GROK_VARS}`, {
      ...REQ,
      CLOUDFLARE_ACCOUNT_ID: "acct123",
    });
    expect(r.status).toBe(0);
    expect(r.text).toContain('R2_S3_ENDPOINT = "https://acct123.r2.cloudflarestorage.com"');
    expect(r.text).toContain('R2_S3_BUCKET = "vivijure"');
    expect(r.text).not.toContain("REPLACE_WITH_");
  });

  it("REFUSES when the endpoint cannot be derived", () => {
    const r = run(`name = "x"\n${GROK_VARS}`, {
      ...REQ,
      CLOUDFLARE_ACCOUNT_ID: "",
      R2_S3_ENDPOINT: "",
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("R2_S3_ENDPOINT");
    expect(r.text).toContain("REPLACE_WITH_R2_S3_ENDPOINT");
  });

  it("REFUSES a leftover wrangler ${R2_S3_ENDPOINT} interpolation (the v1.31.1 defect)", () => {
    const r = run(`name = "x"\n[vars]\nR2_S3_ENDPOINT = "\${R2_S3_ENDPOINT}"\n`, REQ);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("${R2_S3_ENDPOINT}");
  });

  it("the shipped cf-grok-video toml fills clean", () => {
    const r = run(readFileSync("modules/cf-grok-video/wrangler.toml", "utf8"), {
      ...REQ,
      CLOUDFLARE_ACCOUNT_ID: "acct123",
    });
    expect(r.status).toBe(0);
    expect(r.text.replace(/^\s*#.*$/gm, "")).not.toContain("REPLACE_WITH_");
    expect(r.text.replace(/^\s*#.*$/gm, "")).not.toContain("${R2_S3_");
    expect(r.text).toContain('R2_S3_ENDPOINT = "https://acct123.r2.cloudflarestorage.com"');
    expect(r.text).toContain('R2_S3_BUCKET = "vivijure"');
  });
});

describe("shipped door / media tomls fill clean with empty origins", () => {
  for (const m of ["finish-upscale", "speech-upscale", "finish-blender", "audio-master", "beat-sync", "film-titles", "subtitle"]) {
    it(`${m} fills with zero survivors and no vpc_services`, () => {
      const r = run(readFileSync(`modules/${m}/wrangler.toml`, "utf8"), REQ);
      expect(r.status).toBe(0);
      const live = r.text.replace(/^\s*#.*$/gm, "");
      expect(live).not.toContain("REPLACE_WITH_");
      expect(live).not.toContain("[[vpc_services]]");
      expect(live).not.toContain("${VPC_");
      expect(r.text).toContain(`name = "vivijure-module-${m}"`);
    });
  }

  it("finish-upscale keeps its RunPod + door-token bindings", () => {
    const r = run(readFileSync("modules/finish-upscale/wrangler.toml", "utf8"), REQ);
    expect(r.status).toBe(0);
    expect(r.text).toContain('binding = "RUNPOD_ENDPOINT_ID"');
    expect(r.text).toContain('binding = "FINISH_DOOR_TOKEN"');
    expect(r.text).toContain('FINISH_UPSCALE_DOORS = ""');
  });
});
