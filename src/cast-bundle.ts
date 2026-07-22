// Cast import / export as portable `.vvcast` tar bundles (issue #324).

import {
  addRefs,
  addSource,
  createCast,
  getCastById,
  markLoraReady,
  setPortrait,
  toPublicCast,
  updateCast,
  type CastMember,
  type CastRefImage,
  type LoraStatus,
} from "@skyphusion-labs/vivijure-core/cast-db";
import { isValidVoiceId } from "@skyphusion-labs/vivijure-core/voices";
import { emitTar, readTar } from "@skyphusion-labs/vivijure-core/tar";
import type { Env } from "./env";
import { extFromMime } from "./utils";
import { resolveCastImageMime } from "./cast-media";

export const CAST_BUNDLE_FORMAT = "vivijure-cast-bundle";
export const CAST_BUNDLE_SCHEMA_VERSION = 1;
export const CAST_BUNDLE_MEDIA_TYPE = "application/x-tar";
export const CAST_BUNDLE_EXT = "vvcast";
export const CAST_BUNDLE_MAX_IMPORT_BYTES = 80 * 1024 * 1024;

const MANIFEST_NAME = "manifest.json";

export interface CastBundleAssetRef {
  path: string;
  mime: string;
}

export interface CastBundleManifest {
  format: typeof CAST_BUNDLE_FORMAT;
  schema_version: number;
  exported_at?: string;
  creator?: string | null;
  cast: {
    name: string;
    slug?: string;
    bible: string | null;
    voice_id: string | null;
    lora_status: LoraStatus;
    lora_trained_at: string | null;
  };
  assets: {
    portrait: CastBundleAssetRef | null;
    refs: CastBundleAssetRef[];
    sources: CastBundleAssetRef[];
    lora: CastBundleAssetRef | null;
  };
}

class BundleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface ExportEntry {
  path: string;
  r2Key: string;
  mime: string;
}

function planExport(cast: CastMember): ExportEntry[] {
  const entries: ExportEntry[] = [];
  if (cast.portrait_key) {
    const ext = extFromMime(cast.portrait_mime || "image/png");
    entries.push({
      path: `assets/portrait.${ext}`,
      r2Key: cast.portrait_key,
      mime: cast.portrait_mime || "image/png",
    });
  }
  cast.ref_keys.forEach((r, i) => {
    entries.push({
      path: `assets/refs/${i}.${extFromMime(r.mime)}`,
      r2Key: r.key,
      mime: r.mime,
    });
  });
  cast.source_keys.forEach((s, i) => {
    entries.push({
      path: `assets/sources/${i}.${extFromMime(s.mime)}`,
      r2Key: s.key,
      mime: s.mime,
    });
  });
  if (cast.lora_key) {
    entries.push({
      path: "assets/lora.safetensors",
      r2Key: cast.lora_key,
      mime: "application/octet-stream",
    });
  }
  return entries;
}

function buildManifest(cast: CastMember, present: ExportEntry[], exportedAt: string): CastBundleManifest {
  const find = (pred: (e: ExportEntry) => boolean) => present.find(pred) || null;
  const portrait = find((e) => e.path.startsWith("assets/portrait."));
  const lora = find((e) => e.path === "assets/lora.safetensors");
  const refs = present.filter((e) => e.path.startsWith("assets/refs/"));
  const sources = present.filter((e) => e.path.startsWith("assets/sources/"));
  const ref = (e: ExportEntry | null): CastBundleAssetRef | null =>
    e ? { path: e.path, mime: e.mime } : null;
  return {
    format: CAST_BUNDLE_FORMAT,
    schema_version: CAST_BUNDLE_SCHEMA_VERSION,
    exported_at: exportedAt,
    creator: null,
    cast: {
      name: cast.name,
      slug: cast.slug,
      bible: cast.bible,
      voice_id: cast.voice_id,
      lora_status: cast.lora_status,
      lora_trained_at: cast.lora_trained_at,
    },
    assets: {
      portrait: ref(portrait),
      refs: refs.map((e) => ({ path: e.path, mime: e.mime })),
      sources: sources.map((e) => ({ path: e.path, mime: e.mime })),
      lora: ref(lora),
    },
  };
}

async function r2ObjectBytes(obj: {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array>;
}): Promise<Uint8Array> {
  if (typeof obj.arrayBuffer === "function") {
    return new Uint8Array(await obj.arrayBuffer());
  }
  if (!obj.body) throw new Error("R2 object has no readable body");
  const reader = obj.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function exportCastBundle(env: Env, id: number): Promise<Response> {
  const cast = await getCastById(env, id);
  if (!cast) return json({ error: "cast not found" }, 404);

  const planned = planExport(cast);
  const present: ExportEntry[] = [];
  for (const e of planned) {
    const head = await env.R2_RENDERS.head(e.r2Key);
    if (!head) {
      console.warn(
        `cast ${id} export: artifact ${e.r2Key} (${e.path}) missing from R2 -- dropped from bundle`,
      );
      continue;
    }
    present.push(e);
  }

  const exportedAt = new Date().toISOString();
  const manifest = buildManifest(cast, present, exportedAt);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const tarFiles = [{ name: MANIFEST_NAME, content: manifestBytes }];
  for (const e of present) {
    const obj = await env.R2_RENDERS.get(e.r2Key);
    if (!obj) {
      console.warn(`cast ${id} export: artifact ${e.r2Key} vanished before read -- skipped`);
      continue;
    }
    const bytes = await r2ObjectBytes(obj);
    tarFiles.push({ name: e.path, content: bytes });
  }

  const tar = emitTar(tarFiles);
  const filename = `${cast.slug || "cast"}.${CAST_BUNDLE_EXT}`;
  return new Response(tar, {
    status: 200,
    headers: {
      "content-type": CAST_BUNDLE_MEDIA_TYPE,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

export function validateManifest(raw: unknown): CastBundleManifest {
  if (!raw || typeof raw !== "object") throw new BundleError(400, "bundle manifest is not an object");
  const m = raw as Record<string, unknown>;
  if (m.format !== CAST_BUNDLE_FORMAT) {
    throw new BundleError(400, `not a vivijure cast bundle (format=${JSON.stringify(m.format)})`);
  }
  if (typeof m.schema_version !== "number" || !Number.isInteger(m.schema_version)) {
    throw new BundleError(400, "bundle schema_version missing or not an integer");
  }
  if (m.schema_version > CAST_BUNDLE_SCHEMA_VERSION) {
    throw new BundleError(
      400,
      `bundle schema_version ${m.schema_version} is newer than this instance supports (${CAST_BUNDLE_SCHEMA_VERSION}); upgrade to import it`,
    );
  }
  const cast = m.cast as Record<string, unknown> | undefined;
  if (!cast || typeof cast.name !== "string" || !cast.name.trim()) {
    throw new BundleError(400, "bundle cast.name missing");
  }
  const assets = m.assets as Record<string, unknown> | undefined;
  if (!assets || typeof assets !== "object") throw new BundleError(400, "bundle assets missing");
  const refList = (v: unknown): CastBundleAssetRef[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new BundleError(400, "bundle asset list is not an array");
    return v.map((a) => {
      if (!a || typeof a !== "object" || typeof (a as { path?: unknown }).path !== "string") {
        throw new BundleError(400, "bundle asset entry missing path");
      }
      const ar = a as { path: string; mime?: unknown };
      return { path: ar.path, mime: typeof ar.mime === "string" ? ar.mime : "application/octet-stream" };
    });
  };
  const single = (v: unknown): CastBundleAssetRef | null => {
    if (v == null) return null;
    return refList([v])[0];
  };
  return {
    format: CAST_BUNDLE_FORMAT,
    schema_version: m.schema_version,
    exported_at: typeof m.exported_at === "string" ? m.exported_at : undefined,
    creator:
      typeof cast.creator === "string"
        ? (cast.creator as string)
        : typeof m.creator === "string"
          ? m.creator
          : null,
    cast: {
      name: cast.name,
      slug: typeof cast.slug === "string" ? cast.slug : undefined,
      bible: typeof cast.bible === "string" ? cast.bible : null,
      voice_id: typeof cast.voice_id === "string" ? cast.voice_id : null,
      lora_status: normalizeLoraStatus(cast.lora_status),
      lora_trained_at: typeof cast.lora_trained_at === "string" ? cast.lora_trained_at : null,
    },
    assets: {
      portrait: single(assets.portrait),
      refs: refList(assets.refs),
      sources: refList(assets.sources),
      lora: single(assets.lora),
    },
  };
}

function normalizeLoraStatus(raw: unknown): LoraStatus {
  return raw === "training" || raw === "ready" || raw === "failed" ? raw : "idle";
}

export async function importCastBundle(env: Env, body: Uint8Array): Promise<Response> {
  return importInner(env, body).catch((e) => {
    if (e instanceof BundleError) return json({ error: e.message }, e.status);
    throw e;
  });
}

async function importInner(env: Env, body: Uint8Array): Promise<Response> {
  if (body.length === 0) throw new BundleError(400, "empty bundle body");
  if (body.length > CAST_BUNDLE_MAX_IMPORT_BYTES) {
    throw new BundleError(
      413,
      `bundle too large (${body.length} bytes > ${CAST_BUNDLE_MAX_IMPORT_BYTES} cap)`,
    );
  }

  let files;
  try {
    files = readTar(body);
  } catch (e) {
    throw new BundleError(400, `not a readable tar bundle: ${(e as Error).message}`);
  }
  const byName = new Map(files.map((f) => [f.name, f.content]));
  const manifestRaw = byName.get(MANIFEST_NAME);
  if (!manifestRaw) throw new BundleError(400, `bundle missing ${MANIFEST_NAME}`);

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    throw new BundleError(400, `bundle ${MANIFEST_NAME} is not valid JSON`);
  }
  const manifest = validateManifest(manifestJson);

  const allRefs: CastBundleAssetRef[] = [
    ...(manifest.assets.portrait ? [manifest.assets.portrait] : []),
    ...manifest.assets.refs,
    ...manifest.assets.sources,
    ...(manifest.assets.lora ? [manifest.assets.lora] : []),
  ];
  for (const a of allRefs) {
    if (!byName.has(a.path)) {
      throw new BundleError(400, `bundle manifest references ${a.path} but the tar has no such entry`);
    }
  }

  const resolve = (a: CastBundleAssetRef): Uint8Array => {
    const data = byName.get(a.path);
    if (!data) {
      throw new BundleError(400, `bundle manifest references ${a.path} but the tar has no such entry`);
    }
    return data;
  };

  // Pre-validate image asset MIME + magic bytes BEFORE createCast so a hostile
  // text/html (or polyglot) .vvcast never leaves an orphan cast row.
  const resolveImage = (a: CastBundleAssetRef, label: string): { bytes: Uint8Array; mime: string } => {
    const bytes = resolve(a);
    try {
      return { bytes, mime: resolveCastImageMime(a.mime, bytes) };
    } catch (e) {
      throw new BundleError(400, `${label}: ${(e as Error).message}`);
    }
  };
  const portrait = manifest.assets.portrait
    ? resolveImage(manifest.assets.portrait, "bundle portrait")
    : null;
  const refsIn = manifest.assets.refs.map((a) => resolveImage(a, `bundle ref ${a.path}`));
  const sourcesIn = manifest.assets.sources.map((a) => resolveImage(a, `bundle source ${a.path}`));

  const created = await createCast(env, { name: manifest.cast.name, bible: manifest.cast.bible });
  const id = created.id;

  if (portrait) {
    const key = `cast/${id}/portrait.${extFromMime(portrait.mime)}`;
    await env.R2_RENDERS.put(key, portrait.bytes, { httpMetadata: { contentType: portrait.mime } });
    await setPortrait(env, id, key, portrait.mime);
  }

  if (refsIn.length) {
    const refs: CastRefImage[] = [];
    for (const img of refsIn) {
      const key = `cast/${id}/refs/${crypto.randomUUID()}.${extFromMime(img.mime)}`;
      await env.R2_RENDERS.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
      refs.push({ key, mime: img.mime });
    }
    await addRefs(env, id, refs);
  }

  for (const img of sourcesIn) {
    const key = `cast/${id}/sources/${crypto.randomUUID()}.${extFromMime(img.mime)}`;
    await env.R2_RENDERS.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    await addSource(env, id, { key, mime: img.mime });
  }

  if (manifest.assets.lora) {
    const bytes = resolve(manifest.assets.lora);
    const key = `loras/cast-${id}-${crypto.randomUUID()}.safetensors`;
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    await markLoraReady(env, id, key);
  }

  if (manifest.cast.voice_id && isValidVoiceId(manifest.cast.voice_id)) {
    await updateCast(env, id, { voice_id: manifest.cast.voice_id });
  } else if (manifest.cast.voice_id) {
    console.warn(
      `cast import ${id}: bundle voice_id "${manifest.cast.voice_id}" unknown on this instance -- dropped`,
    );
  }

  const row = await getCastById(env, id);
  return json(
    { cast: row ? toPublicCast(row) : null, imported_from_schema: manifest.schema_version },
    201,
  );
}
