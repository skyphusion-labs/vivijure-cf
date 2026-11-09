#!/usr/bin/env node
// cf#1382: a sorted, comparable snapshot of a live Worker's bindings.
//
// Usage:
//   node scripts/studio-bindings-snapshot.mjs <out-file>        snapshot the live script
//   node scripts/studio-bindings-snapshot.mjs --diff <a> <b>     exit 1 when the two differ
// Env (snapshot): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, STUDIO_SCRIPT_NAME (default vivijure-studio).
//
// The tag deploy snapshots BEFORE `wrangler deploy` and AFTER it, and fails on any difference. A
// release that renders a variable empty or defaulted (cf#1382) changes a binding, and this is the
// check that sees it on the live script rather than in the rendered file.
//
// One line per binding: type, name, detail, tab-separated, sorted. The detail is the plain_text
// text, nothing for a secret_text (the API returns no value, and none is wanted), and for every
// other type the remaining fields as sorted JSON, so a field this file has never heard of is still
// compared. STUDIO_GIT_SHA is masked to <stamped>, because every deploy changes it.
//
// A failed read EXITS 2 and writes nothing. A snapshot that could not be taken must never compare
// equal to one that could.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MASKED = { STUDIO_GIT_SHA: "<stamped>" };

function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Pure: the API's `bindings` array to sorted snapshot lines. */
export function normalizeBindings(bindings) {
  if (!Array.isArray(bindings)) throw new Error("bindings is not an array");
  const lines = bindings.map((b) => {
    const { type, name, ...rest } = b ?? {};
    if (typeof type !== "string" || typeof name !== "string") throw new Error("binding without type or name");
    let detail;
    if (Object.prototype.hasOwnProperty.call(MASKED, name)) detail = MASKED[name];
    else if (type === "plain_text") detail = String(rest.text ?? "");
    else if (type === "secret_text") detail = "";
    else detail = sortedJson(rest);
    return `${type}\t${name}\t${detail}`;
  });
  return lines.sort();
}

/** Pure: the lines only in a, and only in b. */
export function diffSnapshots(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return { removed: a.filter((l) => !sb.has(l)), added: b.filter((l) => !sa.has(l)) };
}

async function snapshot(out) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const script = process.env.STUDIO_SCRIPT_NAME || "vivijure-studio";
  if (!token || !account) {
    console.error("::error::studio-bindings-snapshot: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID unset, could not measure");
    return 2;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/settings`;
  let body;
  try {
    const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    body = await resp.json().catch(() => null);
    if (!resp.ok || !body?.success) {
      const codes = (body?.errors ?? []).map((e) => e?.code).join(",");
      console.error(`::error::studio-bindings-snapshot: GET settings for ${script} -> HTTP ${resp.status} (codes ${codes || "none"}), could not measure`);
      return 2;
    }
  } catch (e) {
    console.error(`::error::studio-bindings-snapshot: GET settings for ${script} failed: ${e?.message ?? e}, could not measure`);
    return 2;
  }
  let lines;
  try {
    lines = normalizeBindings(body.result?.bindings);
  } catch (e) {
    console.error(`::error::studio-bindings-snapshot: unreadable bindings for ${script}: ${e.message}, could not measure`);
    return 2;
  }
  if (lines.length === 0) {
    console.error(`::error::studio-bindings-snapshot: ${script} reports ZERO bindings, refusing to treat that as a snapshot`);
    return 2;
  }
  writeFileSync(out, lines.join("\n") + "\n");
  const types = {};
  for (const l of lines) types[l.split("\t")[0]] = (types[l.split("\t")[0]] ?? 0) + 1;
  console.log(`studio-bindings-snapshot: ${script}: ${lines.length} bindings ${sortedJson(types)}`);
  return 0;
}

function readLines(p) {
  return readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
}

function diff(aPath, bPath) {
  let a, b;
  try {
    a = readLines(aPath);
    b = readLines(bPath);
  } catch (e) {
    console.error(`::error::studio-bindings-snapshot --diff: ${e.message}, could not measure`);
    return 2;
  }
  if (a.length === 0 || b.length === 0) {
    console.error("::error::studio-bindings-snapshot --diff: an empty snapshot, could not measure");
    return 2;
  }
  const { removed, added } = diffSnapshots(a, b);
  if (removed.length === 0 && added.length === 0) {
    console.log(`studio-bindings-snapshot: bindings unchanged across the deploy (${a.length} compared, STUDIO_GIT_SHA masked)`);
    return 0;
  }
  console.error(`::error::live studio bindings CHANGED across the deploy (cf#1382): ${removed.length} before-only, ${added.length} after-only`);
  for (const l of removed) console.error(`- ${l}`);
  for (const l of added) console.error(`+ ${l}`);
  return 1;
}

async function main(argv) {
  if (argv[0] === "--diff" && argv.length === 3) return diff(argv[1], argv[2]);
  if (argv.length === 1 && !argv[0].startsWith("-")) return snapshot(argv[0]);
  console.error("usage: studio-bindings-snapshot.mjs <out> | --diff <before> <after>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
