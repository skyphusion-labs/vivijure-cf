// cf#926: preflight checks a shot's length against the door the caller named.
//
// A motion door publishes its bounds in `usage`. Preflight read only the global 60s cap, so a 20s
// shot passed clean against an 8s door and the door then clamped it with no word to the caller.
//
// The levels follow what the render does:
//   over the ceiling      error    the door cannot make a clip that long
//   under the floor       warning  the clip comes back LONGER than planned, nothing is lost
//   between two steps     warning  the clip is a step length, not the planned length
//
// A door that declares `duration_grid` is left to checkDurationGrid, which knows the tier and the
// #697 duration floor. Two checks on one ceiling would give two answers.

import type { PreflightIssue } from "@skyphusion-labs/vivijure-core/preflight";

interface DoorDurationShape {
  name: string;
  duration_grid?: unknown;
  usage?: {
    min_seconds?: number;
    max_seconds?: number;
    duration_steps?: number[];
  };
}

interface BoardShape {
  clip_seconds?: unknown;
  scenes?: { id?: string; target_seconds?: unknown }[];
}

export function checkDoorDurations(storyboard: BoardShape, door: DoorDurationShape): PreflightIssue[] {
  const usage = door.usage;
  if (!usage || door.duration_grid) return [];
  const steps = Array.isArray(usage.duration_steps) && usage.duration_steps.length
    ? [...usage.duration_steps].sort((a, b) => a - b)
    : null;
  const max = typeof usage.max_seconds === "number" ? usage.max_seconds : null;
  const min = typeof usage.min_seconds === "number" ? usage.min_seconds : null;
  const allowed = steps ? `${steps.join(", ")} seconds` : `${min ?? "?"} to ${max ?? "?"} seconds`;

  const issues: PreflightIssue[] = [];
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  scenes.forEach((scene, idx) => {
    const sid = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const planned = typeof scene.target_seconds === "number" ? scene.target_seconds
      : typeof storyboard.clip_seconds === "number" ? storyboard.clip_seconds
        : undefined;
    if (planned === undefined || !(planned > 0)) return;
    const scope = `scene[${sid}]`;
    if (max !== null && planned > max) {
      issues.push({
        level: "error",
        scope,
        message: `${sid} plans ${planned}s, and ${door.name} renders at most ${max}s (${allowed}). Shorten the shot, or pick another door.`,
      });
    } else if (min !== null && planned < min) {
      issues.push({
        level: "warning",
        scope,
        message: `${sid} plans ${planned}s, and ${door.name} renders at least ${min}s (${allowed}). The clip will run longer than planned.`,
      });
    } else if (steps && !steps.includes(planned)) {
      issues.push({
        level: "warning",
        scope,
        message: `${sid} plans ${planned}s, and ${door.name} renders only ${allowed}. The clip will not be ${planned}s long.`,
      });
    }
  });
  return issues;
}
