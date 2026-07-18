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
  console.log(`manifest sha256: ${manifestSha256}`);
}

main();
