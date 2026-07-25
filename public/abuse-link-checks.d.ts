// Types for public/abuse-link-checks.js. Hand-authored (no build step) so the tests typecheck
// under the CI tsc gate. Runtime stays plain vanilla JS.

export interface AbuseLinkSpec {
  href: string;
  label: string;
}

/** The modules payload, narrowed to the one field this reads. */
export interface AbuseLinkPayload {
  host?: { abuse_report_url?: unknown } | null;
}

export function abuseLink(payload: AbuseLinkPayload | null | undefined): AbuseLinkSpec | null;
