// Vivijure studio -- the abuse-report link (control-plane#130). A GATE, not a feature, in the same
// family as readonly-gate.js and hook-availability.js: no nav entry, no page of its own, and a pure
// PROJECTION of the registry. The sole signal is host.abuse_report_url on GET /api/modules, the
// core describing itself, sibling of host.dispatch / host.readonly / host.hooks_unavailable.
//
// WHY IT IS A PROJECTION AND NOT A LINK IN THE MARKUP: this bundle is what a self-hoster installs.
// Our abuse address must never ship inside it, because we are not the provider for a self-hosted
// studio and cannot act on its content; a reporter sent to us about it would be sent to someone who
// can do nothing. So the address is operator config, the panel renders whatever it is handed, and a
// studio whose host reports nothing renders nothing. There is deliberately NO fallback address and
// no "am I hosted" branch: either would be the hardcoding the parity rule forbids.
//
// A hosted tenant gets the link. A self-hoster gets it too if they publish their own contact, which
// is the right answer rather than a special case for us.
(function () {
  "use strict";

  var checks = window.abuseLinkChecks;
  var FOOTER_CLASS = "studio-foot";

  // cf#580: reads the SHARED per-page memo instead of issuing its own request. This file loads on
  // all four studio pages, which is what made it one of the six un-memoised callers.
  //
  // The catch is gone because load() never rejects: a failed read resolves the documented empty
  // shape, abuseLink() finds no host.abuse_report_url on it and returns null, and nothing renders.
  // Byte-identical to the old catch, and for the same reason: a failed registry read means we do not
  // KNOW of an address, and rendering a guessed one would be worse than rendering none. Silence is
  // honest here, and the front door still carries the path.
  moduleRegistry.load().then(function (d) {
    var spec = checks ? checks.abuseLink(d) : null;
    if (spec) render(spec);
  });

  function render(spec) {
    if (document.querySelector("." + FOOTER_CLASS)) return;
    var foot = document.createElement("footer");
    foot.className = FOOTER_CLASS;
    var link = document.createElement("a");
    // textContent, never innerHTML: the label is ours, but the href came off the wire and this
    // element is built from a payload. Keep the whole path free of markup interpolation.
    link.textContent = spec.label;
    link.href = spec.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    foot.appendChild(link);
    document.body.appendChild(foot);
  }
})();
