// build-module-release: assemble ONE tenant module worker bundle into the release artifact the hosted
// provisioner fetches by (tag, module) (cf#99). Sibling of build-studio-release.ts, same contract, and
// for the same reason: the control plane is a Worker and cannot bundle at provision time, so each
// module worker must arrive as a single-file, integrity-checked, published artifact.
//
// THE BUNDLE IS NOT BUILT HERE. It comes from `wrangler deploy --dry-run --outdir` against the module's
// own wrangler.toml, i.e. wrangler's own bundler and config -- so the artifact IS the deploy shape, not
// a parallel esbuild that can drift. This script only assembles + hashes what wrangler produced, into
//   studio-releases/<tag>/modules/<module>/manifest.json
//   studio-releases/<tag>/modules/<module>/worker.js
// (the same release tree the studio bundle lives in: a tenant's studio and its modules ship as ONE tag).
//
// INTEGRITY ROOT (cf#147): each module's manifest.json `worker.sha256` is the intentional integrity
// anchor for that bundle. It is NOT chained into the top-level studio PIN digest -- the control
// plane re-verifies the per-module hash at provision, and tenants may pin modules to a different
// release than the studio (cf#103).
//
// Reproducible by anyone: it reads no secrets and no account state. Module workers hold NO static
// assets, so there is no asset leg -- just the worker + its compat config, read from the SAME config
// the bundle was built from so they cannot disagree.
//
// Usage:
//   node scripts/build-module-release.ts \
//     --bundle <wrangler --outdir>/index.js --config modules/keyframe/wrangler.toml \
//     --module keyframe --out dist-release/modules/keyframe

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name: string, required = true): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) throw new Error(`missing --${name}`);
    return "";
  }
  return process.argv[i + 1];
}

/**
 * compatibility_date / compatibility_flags come from the SAME wrangler.toml the bundle was built from,
 * so they cannot disagree with it. Read from the config rather than passed in, because a value supplied
 * independently is a value that can drift (the exact discipline build-studio-release.ts uses).
 */
function readCompat(configPath: string): { date: string; flags: string[] } {
  const toml = readFileSync(configPath, "utf8");
  const date = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const flagsRaw = /^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1] ?? "";
  if (!date) throw new Error(`no compatibility_date in ${configPath}`);
  const flags = flagsRaw
    .split(",")
    .map((f) => f.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return { date, flags };
}

/**
 * One Workflow a module declares in its own wrangler.toml, carried into the manifest so the plane
 * can BIND it without being told separately (cf#942 / vivijure-control-plane cp#526).
 *
 * WHY THE MODULE IS THE SOURCE. The module knows WHAT it needs -- that it has a Workflow, the
 * entrypoint class, and a logical identifier -- and its wrangler.toml is the only copy of that fact
 * which cannot drift from the code calling `env.X.create()`. The plane knows WHO it is for, and
 * composes the account-scoped workflow name from the tenant. Neither half is hand-maintained, which
 * is the whole point: a triple typed into the plane's catalog would be the third hand-maintained
 * list in a month, after the catalog count that was wrong across ten wrangler.toml files and
 * SHARED_RUNPOD_ENDPOINTS naming an endpoint deleted weeks earlier. Both rotted silently.
 *
 * `name` is the module's LOGICAL id, never the resource name a tenant gets. A Workflow is an
 * ACCOUNT-scoped resource and every tenant's copy of a module lives in one shared dispatch
 * namespace on one account, so two tenants using this name verbatim would share one Workflow. That
 * is not theoretical and Cloudflare will not warn: it was live-measured on cp#535 that a second
 * script may claim the same workflow_name with a different class and the API accepts it.
 */
export interface WorkflowRequirement {
  /** The env variable the module reads, e.g. DIALOGUE_WORKFLOW. */
  binding: string;
  /** The exported WorkflowEntrypoint class in this bundle. */
  class_name: string;
  /** The module's own logical name for the Workflow. The plane prefixes it per tenant. */
  name: string;
}

/**
 * Parse `[[workflows]]` out of the module's wrangler.toml.
 *
 * A LINE-ORIENTED TABLE READER, not a regex over the whole file, and the difference is the bug it
 * avoids: a pattern matching `name\s*=` anywhere would happily pick up the worker's own top-level
 * `name`, or a key from the `[[secrets_store_secrets]]` block that follows. This tracks the current
 * table header and reads keys ONLY while inside a `[[workflows]]` block, so any other header --
 * including the `[workflows.limits]` and `[workflows.default_retention]` sub-tables Cloudflare
 * documents -- ends it.
 *
 * REFUSES A PARTIAL BLOCK rather than emitting one. A requirement missing its class_name or binding
 * is not a smaller requirement, it is an unusable one, and the failure has to land HERE (at build)
 * rather than at provision, where the plane would bind something wrong, or at first invoke, where
 * the tenant has already paid for the keyframe pass.
 */
export function readWorkflows(configPath: string): WorkflowRequirement[] {
  const out: WorkflowRequirement[] = [];
  let current: Partial<WorkflowRequirement> | null = null;
  const flush = (): void => {
    if (!current) return;
    const missing = (["binding", "class_name", "name"] as const).filter((k) => !current![k]);
    if (missing.length) {
      throw new Error(
        `${configPath}: a [[workflows]] block is missing ${missing.join(", ")}; ` +
          "refusing to publish a manifest that declares a binding the plane cannot emit",
      );
    }
    // Rebuilt with a FIXED key order rather than pushed as parsed. The manifest digest is part of
    // the release pin, so its bytes must depend on the VALUES a module declares and not on the
    // order somebody happened to type the keys in its wrangler.toml.
    out.push({ binding: current.binding!, class_name: current.class_name!, name: current.name! });
    current = null;
  };
  for (const raw of readFileSync(configPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    if (line.startsWith("[")) {
      flush();
      if (line === "[[workflows]]") current = {};
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (kv[1] === "binding" || kv[1] === "class_name" || kv[1] === "name") {
      current[kv[1]] = kv[2];
    }
  }
  flush();
  // Same reason: a canonical ENTRY order for a module that declares more than one.
  return out.sort((a, b) => (a.binding < b.binding ? -1 : a.binding > b.binding ? 1 : 0));
}

function main(): void {
  const bundlePath = arg("bundle");
  const configPath = arg("config");
  const moduleName = arg("module");
  const outDir = arg("out");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // The worker: copied verbatim from wrangler's outdir. sha256 is OUR integrity check -- the full 64
  // hex, checked in r2ModuleBundleSource before the bytes ever reach a tenant.
  const workerBytes = readFileSync(bundlePath);
  const workerSha256 = createHash("sha256").update(workerBytes).digest("hex");
  writeFileSync(join(outDir, "worker.js"), workerBytes);

  const compat = readCompat(configPath);
  const manifest = {
    // The module NAME the provisioner asks for; r2ModuleBundleSource refuses a mismatch (wrong-worker
    // guard). It is the module's manifest name AND the release subpath, never a path into this artifact.
    module: moduleName,
    // The module part name the provisioner sends in the WfP upload metadata; must match the part it
    // uploads (worker.js). A name, not a path.
    main_module: "worker.js",
    compatibility_date: compat.date,
    compatibility_flags: compat.flags,
    worker: { path: "worker.js", sha256: workerSha256, size: workerBytes.byteLength },
    // cf#942 / cp#526: what this module needs BOUND, read from its own wrangler.toml.
    //
    // ALWAYS PRESENT, EVEN WHEN EMPTY, and that is load-bearing rather than tidy. A consumer must be
    // able to tell "this module declares no such binding" from "this manifest predates the contract
    // and cannot say" -- an absent field is the second, and only the second is a reason to refuse.
    // Collapsing them is how a module that NEEDS a binding provisions silently unbound, which is
    // measured to be accepted by the API (cp#535) and therefore invisible until the first invoke.
    //
    // A CONTAINER, not a bare `workflows` array, because `vpc_service` is the next one through this
    // door: four finishing modules are published-but-uncatalogued for exactly the same reason.
    bindings_required: { workflows: readWorkflows(configPath) },
  };
  // Stable key order + trailing newline: the manifest digest is part of the release pin, so the same
  // inputs must produce the same bytes.
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(outDir, "manifest.json"), manifestJson);
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  console.log(`module:          ${moduleName}`);
  console.log(`worker:          ${basename(bundlePath)} -> worker.js (${workerBytes.byteLength} bytes)`);
  console.log(`worker sha256:   ${workerSha256}`);
  console.log(`compat:          ${compat.date} [${compat.flags.join(", ")}]`);
  console.log(
    `workflows:       ${manifest.bindings_required.workflows.length}` +
      manifest.bindings_required.workflows.map((w) => ` ${w.binding}=${w.name}(${w.class_name})`).join(""),
  );
  console.log(`manifest sha256: ${manifestSha256}`);
}

// RUN ONLY AS THE ENTRY POINT. The parser above is the part a test has to be able to drive -- it is
// the piece that turns a module's own declaration into a published contract, and a parser proven
// only by the release that uses it is proven at the worst possible moment. Importing this file to
// reach it would otherwise execute main() and die on its own missing --bundle. Invoked exactly as
// before when node runs the script, which is what tests/release-builder-runs.test.ts checks.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
