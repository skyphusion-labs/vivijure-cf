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
