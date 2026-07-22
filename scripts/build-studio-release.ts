// build-studio-release: assemble the tenant-studio release artifact the hosted provisioner fetches
// by tag (#59 <-> #53, epic #40).
//
// WHY THIS EXISTS: "upload the published studio release" had no artifact to upload. The core ships
// `dist/` as multi-file compiled TS with relative imports; a WfP user-Worker upload takes ONE module
// part; and the control plane is a Worker, so it cannot bundle at provision time. This produces the
// single-file bundle + the asset manifest, per tag, once, in CI.
//
// THE BUNDLE IS NOT BUILT HERE. It comes from `wrangler deploy --dry-run --outdir`, i.e. wrangler's
// own bundler against the repo's real config. A parallel esbuild invocation would be a second build
// that can silently drift from the one that actually deploys; this way the artifact IS the deploy
// shape. This script only assembles + hashes what wrangler produced.
//
// Reproducible by anyone: it reads no secrets and no account state. A third party running their own
// hosted vivijure builds a byte-identical artifact from a clean checkout, which is what keeps the
// AGPL hosted door actually runnable rather than nominally open (the parity ruling).
//
// Usage:
//   node scripts/build-studio-release.ts \
//     --bundle <wrangler --outdir>/index.js --assets public --config wrangler.toml \
//     --migrations migrations --tag v1.2.3 --out dist-release

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, extname, join, posix, relative, sep } from "node:path";
import blake3 from "blake3-wasm";
import { ORCHESTRATOR_VAR_KEYS } from "../src/platform/orchestrator-vars.ts";

/**
 * Content types, pinned explicitly rather than pulled from a mime database.
 *
 * The provisioner sends this per file on the assets upload, so it decides how a tenant's UI is
 * served: get it wrong and the studio serves CSS as octet-stream. An explicit map is auditable and
 * cannot silently regress on a dependency bump; the tradeoff is that a NEW asset type fails the
 * release build until someone adds it here, which is the correct direction to fail.
 *
 * `charset=utf-8` on text/* mirrors wrangler's getContentType so a tenant studio serves byte-for-byte
 * what our own panel serves.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  map: "application/json",
  // .d.ts files in public/ are EDITOR type declarations for the verbatim-shared JS surface; nothing
  // fetches them at runtime. text/plain is the honest type (a standard mime db says video/mp2t for
  // ".ts", which is MPEG transport stream -- nonsense here). Flagged on #59: they arguably should not
  // ship as public assets at all.
  ts: "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type) {
    throw new Error(
      `No pinned content type for ".${ext}" (${path}). Add it to CONTENT_TYPES in ` +
        `scripts/build-studio-release.ts. Refusing to guess: a wrong type silently breaks how the ` +
        `tenant studio serves this file.`,
    );
  }
  return type;
}

/**
 * The asset hash Cloudflare's assets-upload-session expects.
 *
 * PLATFORM-PROVEN, and not what anyone would guess (#53): it is BLAKE3 -- not sha256 -- over the
 * BASE64 of the contents -- not the raw bytes -- concatenated with the extension WITHOUT its dot,
 * truncated to 32 hex. Verbatim from wrangler's `hashFile` (4.111.0) and confirmed live against CF:
 * a session opened with a hash computed this way returns EMPTY buckets (CF already holds the
 * content), while a truncated-sha256 hash makes CF demand the upload.
 *
 * Getting this wrong does not error. CF accepts the manifest, then re-uploads every asset for every
 * tenant forever, and the namespace dedupe the provisioner counts on silently never happens.
 */
function assetHash(filePath: string, contents: Buffer): string {
  const base64Contents = contents.toString("base64");
  const extension = extname(filePath).substring(1);
  return blake3.hash(base64Contents + extension).toString("hex").slice(0, 32);
}

/** wrangler's normalizeFilePath: a leading slash, posix separators. */
function manifestPath(assetsDir: string, filePath: string): string {
  return "/" + relative(assetsDir, filePath).split(sep).join(posix.sep);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function arg(name: string, required = true): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) throw new Error(`missing --${name}`);
    return "";
  }
  return process.argv[i + 1];
}

/**
 * compatibility_date / compatibility_flags come from the SAME config the bundle was built from, so
 * they cannot disagree with it (#53 requirement 3). Read from the rendered wrangler.toml rather than
 * passed in, because a value supplied independently is a value that can drift.
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
 * Asset handling flags, from the SAME config the bundle was built from (#77 follow-up).
 *
 * WHY THESE TRAVEL WITH THE ARTIFACT, exactly like compatibility_date: they are properties of the
 * release that was built and tested, and the tenant studio does not read a wrangler.toml -- the
 * provisioner hands them to the WfP upload as metadata.assets.config. If the provisioner supplied
 * them independently they could silently disagree with the studio the bundle expects, and the
 * failure would land on a tenant rather than on us.
 *
 * Both flags are load-bearing on the core and both were paid for in production incidents:
 *   run_worker_first = true -- else Workers Assets serves pages straight from the edge, bypassing
 *     the Worker, so pages ship with no security headers (the post-v0.7.4 finding). The control
 *     plane re-learned this class on 2026-07-17 (#77).
 *   html_handling = "none" -- else serveStudioAsset's ASSETS.fetch("/planner.html") 307-redirects to
 *     /planner -> redirect loop -> BLANK PAGE (#374 -> #375). The Worker maps pretty routes itself.
 * Neither is a Cloudflare default, so a tenant uploaded without them silently gets the broken shape
 * while a self-hoster running the same release is fine: the parity tripwire, stated exactly.
 *
 * ABSENT IS EMITTED AS ABSENT, deliberately. If a config does not set a flag, the self-hoster gets
 * Cloudflare's default too -- so carrying "nothing" preserves parity, while defaulting here would
 * invent a value this release was never built with.
 */
function readAssetsConfig(configPath: string): { html_handling?: string; run_worker_first?: boolean } {
  const toml = readFileSync(configPath, "utf8");
  const block = /^assets\s*=\s*\{([^}]*)\}/m.exec(toml)?.[1];
  if (!block) throw new Error(`no assets block in ${configPath}`);
  const config: { html_handling?: string; run_worker_first?: boolean } = {};
  const html = /html_handling\s*=\s*"([^"]+)"/.exec(block)?.[1];
  const rwf = /run_worker_first\s*=\s*(true|false)/.exec(block)?.[1];
  if (html !== undefined) config.html_handling = html;
  if (rwf !== undefined) config.run_worker_first = rwf === "true";
  return config;
}

function main(): void {
  const bundlePath = arg("bundle");
  const assetsDir = arg("assets");
  const configPath = arg("config");
  const migrationsDir = arg("migrations");
  const tag = arg("tag");
  const outDir = arg("out");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });
  mkdirSync(join(outDir, "migrations"), { recursive: true });

  // The worker: copied verbatim from wrangler's outdir. sha256 is OUR integrity check (#53 req 4) --
  // distinct from the CF asset hash above, and deliberately the full 64 hex.
  const workerBytes = readFileSync(bundlePath);
  const workerSha256 = createHash("sha256").update(workerBytes).digest("hex");
  writeFileSync(join(outDir, "worker.js"), workerBytes);

  const assets = walk(assetsDir).map((filePath) => {
    const contents = readFileSync(filePath);
    const hash = assetHash(filePath, contents);
    // Content-addressed by the SAME hash the manifest carries, so the provisioner never re-hashes.
    writeFileSync(join(outDir, "assets", hash), contents);
    return {
      path: manifestPath(assetsDir, filePath),
      hash,
      size: statSync(filePath).size,
      content_type: contentTypeFor(filePath),
    };
  });

  // The studio D1 schema rides the release (cf#85). Before this, the hosted control plane imported
  // these .sql files straight out of this repo at ITS build time, which meant a tenant could get its
  // SCHEMA from the control plane deploy commit and its WORKER from a pinned release tag -- two
  // different versions of the studio in one tenant. Shipping them here collapses that to ONE pinned
  // artifact, and closes the versioning caveat studio-migrations.ts documented against itself.
  //
  // TOP-LEVEL ONLY, matching the live-verified provision chain exactly: migrations/manual/ is
  // operator-run and migrations/demo/ is demo seed data; neither belongs in a tenant D1. `sort()` is
  // the apply order and the filename is the tracking key, so both must stay stable.
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const contents = readFileSync(join(migrationsDir, name));
      // Named, not content-addressed: the runner records each migration by FILENAME in the tenant
      // schema_migrations table, so the name is load-bearing state, not a label.
      writeFileSync(join(outDir, "migrations", name), contents);
      return {
        name,
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength,
      };
    });

  if (migrations.length === 0) {
    // An empty set would provision every new tenant with an EMPTY schema and report success. Refuse.
    throw new Error(`no .sql migrations found in ${migrationsDir}`);
  }

  const compat = readCompat(configPath);
  const assetsConfig = readAssetsConfig(configPath);
  const manifest = {
    tag,
    // The module part name the provisioner sends in the WfP upload metadata. It must match the part
    // it uploads; it is a name, not a path into this artifact.
    main_module: "worker.js",
    compatibility_date: compat.date,
    compatibility_flags: compat.flags,
    worker: { path: "worker.js", sha256: workerSha256, size: workerBytes.byteLength },
    // Handed to the WfP upload as metadata.assets.config by the provisioner (#53). Never hardcoded
    // downstream -- that is the drift this manifest exists to prevent.
    assets_config: assetsConfig,
    assets,
    // The tenant D1 schema, in apply order, each hashed so the consumer verifies bytes it did not
    // build. See the block above for why it lives in the artifact rather than in the control plane.
    migrations,
    // The studio env var contract, exported from the SINGLE source of truth
    // (src/platform/orchestrator-vars.ts) at build time. The hosted provisioner binds these onto a
    // tenant studio; it used to keep its own hand-maintained copy, the two drifted, and the drift
    // only surfaced at a tenant first render as an opaque 500. Publishing the contract in the
    // artifact means the provisioner derives its bind census from the release it actually pinned.
    required_vars: [...ORCHESTRATOR_VAR_KEYS],
  };
  // Stable key order + trailing newline: the manifest digest is the release pin, so the same inputs
  // must produce the same bytes.
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(outDir, "manifest.json"), manifestJson);

  // The pin (#53): {tag, manifest_sha256}. This digest covers the STUDIO artifact only (worker,
  // assets, migrations, required_vars) -- cf#147. Tenant module bundles under modules/<name>/ are
  // intentionally self-anchored (each modules/<name>/manifest.json declares worker.sha256; the
  // control plane re-checks that hash at provision). They are not chained into this top-level
  // digest because a tenant may pin studio and modules to different releases (cf#103). Pinning
  // THIS digest still makes same-tag-different-studio-bytes impossible rather than merely unlikely.
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  console.log(`tag:             ${tag}`);
  console.log(`worker:          ${basename(bundlePath)} -> worker.js (${workerBytes.byteLength} bytes)`);
  console.log(`worker sha256:   ${workerSha256}`);
  console.log(`assets:          ${assets.length}`);
  console.log(`migrations:      ${migrations.length} (${migrations.map((m) => m.name).join(", ")})`);
  console.log(`required_vars:   ${ORCHESTRATOR_VAR_KEYS.length}`);
  console.log(`compat:          ${compat.date} [${compat.flags.join(", ")}]`);
  console.log(`assets_config:   ${JSON.stringify(assetsConfig)}`);
  console.log(`manifest sha256: ${manifestSha256}`);
  console.log("");
  console.log("PIN THIS (the provisioner config):");
  console.log(`  { "tag": "${tag}", "manifest_sha256": "${manifestSha256}" }`);
  writeFileSync(join(outDir, "PIN.txt"), `{ "tag": "${tag}", "manifest_sha256": "${manifestSha256}" }\n`);
}

main();
