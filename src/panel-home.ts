// cf#1242: which page the studio opens on. A deployment setting, PANEL_HOME (a [vars] entry):
//
//   unset (or anything but "simple")  today's behaviour, exactly: "/" is the planner
//   "simple"                          "/" is the Make a video page (public/make.html); the planner
//                                     stays at /planner, and the nav calls it "Advanced"
//
// The page itself is always at /make, whatever this says. Only the landing page moves.
// The nav learns the setting from GET /api/whoami (panel_home), which carries the field only
// when the setting is "simple", so an unset deployment answers byte-for-byte as before.

export const PANEL_HOME_SIMPLE = "simple";

/** The ROOT paths whose page the setting decides. */
const ROOT_PATHS = new Set(["/", "/index.html"]);

export function panelHomeIsSimple(env: { PANEL_HOME?: string } | undefined): boolean {
  return typeof env?.PANEL_HOME === "string" && env.PANEL_HOME.trim().toLowerCase() === PANEL_HOME_SIMPLE;
}

/** The asset a pretty studio path serves, with the PANEL_HOME switch applied to the root.
 *  Returns undefined for a path that is not a studio page. */
export function studioPageAsset(
  pages: Record<string, string>,
  pathname: string,
  env: { PANEL_HOME?: string } | undefined,
): string | undefined {
  if (ROOT_PATHS.has(pathname) && panelHomeIsSimple(env)) return "/make.html";
  return pages[pathname];
}

/** GET /api/whoami. The field is added only when set, so unset keeps the old body exactly. */
export function whoamiBody(env: { PANEL_HOME?: string } | undefined): { user: string; panel_home?: string } {
  return panelHomeIsSimple(env) ? { user: "studio", panel_home: PANEL_HOME_SIMPLE } : { user: "studio" };
}
