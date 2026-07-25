// CONTENT-FREE-BY-CONSTRUCTION LOG LABELS (cf#223 stage 1).
//
// The rule this module exists to make cheap: a studio log line may carry IDS, never NAMES. Project
// names, cast names, voice labels, prompts and raw R2 keys are user content, and a log line is the
// one place content leaks without anybody deciding it should -- it reaches whatever sink the deploy
// has (Workers observability, a self-hoster's own `wrangler tail`, a Loki shipper) with no
// per-field filter available at that layer. The filter therefore has to be at the CALL SITE.
//
// WHY A LABEL RATHER THAN OMISSION. A dropped field makes a log line honest and useless: "an
// artifact went missing" with no way to tell WHICH, or whether two lines are about the same object.
// A label keeps the line joinable (the same key always produces the same label) while carrying no
// content. That is the same trade the tenant-telemetry audit settled on for the control plane.
//
// WHY FNV-1a AND NOT SHA-256. These call sites are synchronous (console.warn inside a loop);
// WebCrypto digest is async, and making a log line async would push a `await` into paths that must
// not yield. This is a LABEL, not a security primitive: it is not a secret commitment, it is not
// reversible-resistant in any meaningful sense for a short input, and nothing may treat it as one.
// What it must be is stable, cheap, and dependency-free.

/** FNV-1a 32-bit, hex, zero-padded. A stable label, NOT a security hash (see the header). */
export function shortId(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime 16777619, via shifts so this stays in 32-bit integer space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * An R2 key as a log label: its top-level PREFIX, plus a stable id for everything after it.
 *
 * The prefix is the only part of a key that is structural rather than user-derived (`bundles/`,
 * `renders/`, `cast/`, `out/` -- see the allow-list in index.ts), and keeping it is what makes a
 * line diagnosable at all: "an object under renders/ went missing" is actionable, "an object went
 * missing" is not. Everything after it can carry a project name (`bundles/<projectName>-<hash>
 * .tar.gz`, `renders/<project>/clips/...`), so it is replaced wholesale.
 *
 * `renders/my-divorce-film/clips/shot-1.mp4` -> `renders/#1a2b3c4d`
 */
export function keyLabel(key: string): string {
  const slash = key.indexOf("/");
  if (slash <= 0) return `#${shortId(key)}`;
  return `${key.slice(0, slash + 1)}#${shortId(key.slice(slash + 1))}`;
}

/**
 * A value that arrived from OUTSIDE and might be anything: a voice id from an imported bundle, an
 * id from a client body. Even a field that is an id BY CONTRACT is user content when an untrusted
 * document supplies it, so the log gets a label and the length, never the value.
 */
export function untrustedLabel(value: string): string {
  return `#${shortId(value)} (${value.length} chars)`;
}
