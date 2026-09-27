// THE shared RunPod-reaching classifier. Four census tests used to carry their own copy of this
// predicate (cf#289, cf#398, cf#578, cf#604) and each copy said the others must not drift from it.
// A wish is not a mechanism; one function is. Import this rather than re-inlining the predicate.
//
// WHY IT STRIPS COMMENTS (cf#951). The predicate is a substring match, and cf#289's own comment
// states the assumption it rests on: the strings it matches "only ever live in index.ts" as
// RUNTIME CODE. Nothing enforced that. A module that merely CITES `_shared/runpod-route` in a
// comment -- normal, useful practice when you are following a precedent -- was classified as
// RunPod-reaching and then required to carry a plane-refusal guard for a plane it never calls.
// Found when modules/fal-wan-27 (a fal-only door, no RunPod import anywhere) was enrolled by one
// comment line. In CI that is a loud red; in the cf#289/cf#578/cf#604 CENSUSES it silently
// inflates a denominator published as fact. And it trains authors to delete accurate citations.
//
// THE STRIPPER IS STRING-AWARE ON PURPOSE, and this is the sharp edge: the host we match for is
// `https://api.runpod.ai/...`, which CONTAINS `//`. A naive line-comment stripper deletes the rest
// of that line and the host-half of the predicate silently goes to ZERO -- the exact failure this
// suite has already survived once (cf#394 moved the base URL into the shared helper and "THE
// HOST-ONLY PREDICATE WENT TO ZERO THE MOMENT THAT LANDED"). tests/runpod-census.test.ts asserts
// the stripper preserves a URL inside a string literal, and that assertion is not decorative.

/** Remove `//` line comments and block comments, leaving string and template literals intact. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    // string / template literal: copy verbatim to its close, honouring escapes
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** A module reaches RunPod iff its RUNTIME CODE names the RunPod API host or imports the shared
 *  route helper. Both halves are kept deliberately: a module may legitimately still name the host,
 *  and a matcher for only one shape has the identical blind spot pointed the other way (cf#289). */
export function reachesRunpod(src: string): boolean {
  const code = stripComments(src);
  return code.includes("api.runpod.ai") || code.includes("_shared/runpod-route");
}
