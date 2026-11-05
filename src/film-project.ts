// cf#1241: every film start saves its board to a storyboard project.
//
// A film started through the API (POST /api/film) carried its master board only in the film doc,
// and the film doc keeps per-part slices. The panel reopens a storyboard only from
// `storyboard_projects.last_storyboard`, so an API film could never be reopened: the lead rebuilt
// two of them by hand from the part bundles (2026-11-05).
//
// THE RULE: never overwrite a different board. A project is reused only when the caller named it
// (`project_id`), or when it carries the film's name and either has no board yet or already holds
// this exact board. Any other name match keeps its own board and the film gets a new project. So a
// repeated request (the same idempotency key) finds its own project again and makes no copy, and a
// planner draft that happens to share the film's name is never replaced.
//
// It runs after the film doc is written and it never refuses the film: the film is already paid
// for in intent, and a lost project is recoverable while a lost film start is not. The answer says
// which happened, so a caller can see a project that did not save.

import {
  createProject,
  getProjectById,
  getProjectIdByPublicId,
  listProjects,
  setLastStoryboard,
  type StoryboardProject,
} from "@skyphusion-labs/vivijure-core/storyboard-projects-db";
import { isPublicId } from "@skyphusion-labs/vivijure-core/public-id";
import type { DbEnv } from "@skyphusion-labs/vivijure-core/db-env";

/** Key-order-independent JSON, so the same board compares equal however it was serialized. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export type FilmProjectChoice = { use: StoryboardProject; write: boolean } | { create: true };

/** Pure: which project a film board belongs in. `named` is the project the caller named, if found. */
export function chooseFilmProject(
  projects: StoryboardProject[],
  filmName: string,
  board: unknown,
  named: StoryboardProject | null,
): FilmProjectChoice {
  const want = stableJson(board);
  if (named) return { use: named, write: stableJson(named.last_storyboard) !== want };
  const same = projects.find((p) => p.name === filmName && p.last_storyboard != null && stableJson(p.last_storyboard) === want);
  if (same) return { use: same, write: false };
  const empty = projects.find((p) => p.name === filmName && p.last_storyboard == null);
  if (empty) return { use: empty, write: true };
  return { create: true };
}

export type FilmProjectResult =
  | { saved: true; id: string; name: string; created: boolean }
  | { saved: false; error: string };

export async function saveFilmProject(
  env: DbEnv,
  args: { filmName: string; board: unknown; projectRef?: unknown },
): Promise<FilmProjectResult> {
  try {
    let named: StoryboardProject | null = null;
    if (args.projectRef !== undefined && args.projectRef !== null && args.projectRef !== "") {
      const id = isPublicId(args.projectRef) ? await getProjectIdByPublicId(env, args.projectRef) : null;
      named = id === null ? null : await getProjectById(env, id);
      if (!named) return { saved: false, error: "project_id names no project" };
    }
    const choice = chooseFilmProject(named ? [] : await listProjects(env), args.filmName, args.board, named);
    if ("create" in choice) {
      const made = await createProject(env, { name: args.filmName });
      const row = await setLastStoryboard(env, made.id, args.board);
      if (!row) return { saved: false, error: "the new project could not take the board" };
      return { saved: true, id: row.public_id, name: row.name, created: true };
    }
    if (choice.write) {
      const row = await setLastStoryboard(env, choice.use.id, args.board);
      if (!row) return { saved: false, error: "the project could not take the board" };
    }
    return { saved: true, id: choice.use.public_id, name: choice.use.name, created: false };
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// cf#1251: the single-film door (POST /api/render/film, MCP submit_film) takes a bundle, not a board,
// and the bundle's storyboard.yaml is a lossy render snapshot. Rebuilding a board from it would save a
// DIFFERENT board from the one the caller wrote, so it is never done. Instead the bundle route, which
// does receive the whole board, keeps it losslessly beside the bundle, and the film door reads it.
//
// The name is `<bundleKey>.board.json` on purpose: the reclaim's sidecar sweep lists every key that
// starts with an artifact's key, so the board is freed with its bundle and is never an orphan.
//
// A bundle is content-addressed by its tar. Two boards that differ only in fields the YAML drops make
// the same tar, so the board kept is the last one bundled under that key.

type BoardBucket = {
  R2_RENDERS: {
    put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
};

export const boardKeyFor = (bundleKey: string): string => `${bundleKey}.board.json`;

export async function storeBundleBoard(env: BoardBucket, bundleKey: string, storyboard: unknown): Promise<void> {
  await env.R2_RENDERS.put(boardKeyFor(bundleKey), JSON.stringify({ version: 1, storyboard }), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** The board kept beside a bundle, or null when there is none (a bundle made before cf#1251). */
export async function readBundleBoard(env: BoardBucket, bundleKey: string): Promise<unknown | null> {
  const object = await env.R2_RENDERS.get(boardKeyFor(bundleKey));
  if (!object) return null;
  const parsed = JSON.parse(await object.text()) as { storyboard?: unknown };
  return parsed && typeof parsed.storyboard === "object" && parsed.storyboard !== null ? parsed.storyboard : null;
}

export const OLD_BUNDLE_NOT_SAVED =
  "this bundle was made before the studio kept boards beside bundles, so the storyboard was not saved to a project. "
  + "The film still started. Bundle the board again to keep it.";

/** The film door's project save: the kept board, never the YAML. */
export async function saveBundleFilmProject(
  env: DbEnv & BoardBucket,
  args: { bundleKey: string; filmName: string; projectRef?: unknown },
): Promise<FilmProjectResult> {
  let board: unknown | null;
  try {
    board = await readBundleBoard(env, args.bundleKey);
  } catch (e) {
    return { saved: false, error: `the kept board could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (board === null) return { saved: false, error: OLD_BUNDLE_NOT_SAVED };
  const named = (board as { projectName?: unknown }).projectName;
  const filmName = typeof named === "string" && named.trim() ? named.trim() : args.filmName;
  return saveFilmProject(env, { filmName, board, projectRef: args.projectRef });
}
