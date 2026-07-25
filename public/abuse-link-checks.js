// Pure helper for the abuse-report link (control-plane#130). NO DOM: this unit-tests under plain
// Node (tests/abuse-link-checks.test.ts) and also loads as a classic <script> exposing
// window.abuseLinkChecks. Same UMD-ish shape as hook-availability-checks.js, no build step.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.abuseLinkChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Schemes a host-payload string may carry into an href. The server already refuses everything
  // else (src/abuse-contact.ts), and this refuses it again on the way into the DOM.
  //
  // NOT belt-and-braces for its own sake: the two checks defend different things. The server one is
  // about HONESTY (do not advertise a link that cannot work). This one is about the DOM (a string
  // from a payload becomes an href, and `javascript:` in an href is script execution). Either check
  // could be reached without the other -- a panel talking to an older core, a core talking to an
  // older panel -- so neither is redundant.
  var SAFE_SCHEMES = { "http:": 1, "https:": 1 };

  /**
   * The link this studio should show, or null for no link at all.
   *
   * NULL IS THE NORMAL ANSWER on a self-hosted studio, and it must stay cheap and silent: absent
   * field, no link, nothing rendered, no address in the bundle. The whole parity rule (we are not
   * the provider for a self-hosted studio, so we must not advertise ourselves inside it) is carried
   * by this one nullable field rather than by any branch on who is running the panel.
   */
  function abuseLink(payload) {
    var host = payload && payload.host;
    var raw = host && typeof host.abuse_report_url === "string" ? host.abuse_report_url.trim() : "";
    if (!raw) return null;
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return null;
    }
    if (!SAFE_SCHEMES[parsed.protocol]) return null;
    return { href: parsed.toString(), label: "Report abuse" };
  }

  return { abuseLink: abuseLink };
});
