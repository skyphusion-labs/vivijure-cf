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
//     --tag v1.2.3 --out dist-release

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, extname, join, posix, relative, sep } from "node:path";
import blake3 from "blake3-wasm";

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

function main(): void {
  const bundlePath = arg("bundle");
  const assetsDir = arg("assets");
  const configPath = arg("config");
  const tag = arg("tag");
  const outDir = arg("out");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });

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

  const compat = readCompat(configPath);
  const manifest = {
    tag,
    // The module part name the provisioner sends in the WfP upload metadata. It must match the part
    // it uploads; it is a name, not a path into this artifact.
    main_module: "worker.js",
    compatibility_date: compat.date,
    compatibility_flags: compat.flags,
    worker: { path: "worker.js", sha256: workerSha256, size: workerBytes.byteLength },
    assets,
  };
  // Stable key order + trailing newline: the manifest digest is the release pin, so the same inputs
  // must produce the same bytes.
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(outDir, "manifest.json"), manifestJson);

  // The pin (#53): {tag, manifest_sha256}. The manifest carries worker.sha256 and every asset hash,
  // so pinning THIS digest transitively pins every byte of the release -- which makes
  // same-tag-different-bytes impossible rather than merely unlikely.
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  console.log(`tag:             ${tag}`);
  console.log(`worker:          ${basename(bundlePath)} -> worker.js (${workerBytes.byteLength} bytes)`);
  console.log(`worker sha256:   ${workerSha256}`);
  console.log(`assets:          ${assets.length}`);
  console.log(`compat:          ${compat.date} [${compat.flags.join(", ")}]`);
  console.log(`manifest sha256: ${manifestSha256}`);
  console.log("");
  console.log("PIN THIS (the provisioner config):");
  console.log(`  { "tag": "${tag}", "manifest_sha256": "${manifestSha256}" }`);
  writeFileSync(join(outDir, "PIN.txt"), `{ "tag": "${tag}", "manifest_sha256": "${manifestSha256}" }\n`);
}

main();
