// cf#515: the REMAINING unjittered client poll loops.
//
// PR #563 fixed the render poll and shipped public/poll-schedule.js as the shared
// policy. It did not fix the rest of the herd. Measured at cf 4d73292, identical at
// tag v1.27.0, so this was never a main-vs-tag artifact:
//
//   demo-steer.js            POLL_MS 8000   -> GET /api/demo/render/<jobId>
//   cast.js                  LORA 5000      -> GET /api/cast/<id>/lora-status
//   planner-audio.js         MUSIC 5000     -> GET /api/job/<id>            (2 arm sites)
//   planner-history-row.js   flat 4000      -> GET /api/storyboard/render/<jobId>  (2 arm sites)
//   planner-history-list.js  30000          -> GET /api/storyboard/history
//
// planner-history-row.js is the one that matters most and was in nobody's count: it
// polls the SAME route as the main render poll, the one that drives advanceFilmJob
// and closes the film's DB row, at a HARDER 4s cadence, and it can run CONCURRENTLY
// with the render poll while a board is polling.
//
// These are STRUCTURAL guards. The policy's arithmetic is already covered by
// tests/poll-schedule-515.test.ts; what is asserted here is that each loop actually
// ROUTES through it, which is the thing a future edit silently undoes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const readPublic = (name: string) => readFileSync(process.cwd() + "/public/" + name, "utf8");

// Strip whole-line comments before matching. Every one of these files now carries a
// comment QUOTING the flat pattern it used to use, so a naive matcher counts its own
// tombstones and reports survivors against a clean file. #563 hit exactly this.
const codeLines = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("cf#515: every remaining poll loop arms through the shared policy", () => {
  it("demo-steer.js no longer arms at a flat POLL_MS", () => {
    const code = codeLines(readPublic("demo-steer.js"));
    // POSITIVE CONTROL FIRST: plant the old pattern and prove the matcher sees it,
    // or the null below is a statement about the regex and not about the file.
    expect((code + "\n    }, POLL_MS);").match(/\}, POLL_MS\);/g)?.length).toBe(1);
    expect(code.match(/\}, POLL_MS\);/g)).toBe(null);
    expect(code).toContain("nextPollDelayMs({ baseMs: POLL_MS })");
  });

  it("cast.js arms the LoRA poll through the policy and backs off on error", () => {
    const code = codeLines(readPublic("cast.js"));
    expect((code + "\n    loraPollTimer = setTimeout(() => pollLoraStatus(id), LORA_POLL_MS);")
      .match(/setTimeout\(\(\) => pollLoraStatus\(id\), LORA_POLL_MS\)/g)?.length).toBe(1);
    expect(code.match(/setTimeout\(\(\) => pollLoraStatus\(id\), LORA_POLL_MS\)/g)).toBe(null);
    expect(code).toContain("baseMs: LORA_POLL_MS");
    // Backoff is a SEPARATE property from jitter: assert both directions of the
    // streak, because an increment with no reset backs off forever.
    expect(code).toContain("loraPollErrorStreak += 1");
    // Negative lookbehind on `let `: the DECLARATION is `let loraPollErrorStreak = 0;`,
    // so a bare toContain here is satisfied by the declaration and stays green when the
    // RESET is deleted. The mutation pass caught that; reading the assertion did not.
    expect(code.match(/(?<!let )loraPollErrorStreak = 0/g)?.length).toBe(1);
  });

  it("planner-audio.js routes BOTH arms through one scheduler and backs off", () => {
    const code = codeLines(readPublic("planner-audio.js"));
    expect((code + "\n    musicPollTimer = setTimeout(pollScoreBedJob, MUSIC_POLL_MS);")
      .match(/setTimeout\(pollScoreBedJob, MUSIC_POLL_MS\)/g)?.length).toBe(1);
    expect(code.match(/setTimeout\(pollScoreBedJob, MUSIC_POLL_MS\)/g)).toBe(null);
    // TWO call sites, so this is the shared path and not a helper sitting beside a
    // surviving inline re-arm. The error arm was the flat one #563 fixed for render.
    // Negative lookbehind excludes the function DECLARATION: a definition is not a
    // call site, and counting it inflated this to 3 on correct code. Chased rather
    // than absorbed into the expectation.
    expect((code.match(/(?<!function )scheduleScoreBedPoll\(\)/g) || []).length).toBe(2);
    expect(code).toContain("musicPollErrorStreak += 1");
    // Same declaration-satisfies-the-assertion trap as cast.js above.
    expect(code.match(/(?<!let )musicPollErrorStreak = 0/g)?.length).toBe(1);
  });

  it("planner-history-row.js routes BOTH arms through one scheduler and backs off", () => {
    const code = codeLines(readPublic("planner-history-row.js"));
    expect((code + "\n        setTimeout(() => pollRegenJob(regenKey), 4000);")
      .match(/setTimeout\(\(\) => pollRegenJob\(regenKey\), 4000\)/g)?.length).toBe(1);
    expect(code.match(/setTimeout\(\(\) => pollRegenJob\(regenKey\), 4000\)/g)).toBe(null);
    expect((code.match(/(?<!function )scheduleRegenPoll\(regenKey\)/g) || []).length).toBe(2);
    expect(code).toContain("baseMs: REGEN_POLL_MS");
    expect(code).toContain("regenPollErrorStreaks.set(");
    // TWO deletes: one clears the backoff on a good poll, one drops the job state when
    // the job goes terminal. Counting them means removing either one reddens; a bare
    // toContain is satisfied by whichever survives.
    expect((code.match(/regenPollErrorStreaks\.delete\(/g) || []).length).toBe(2);
  });

  it("planner-history-list.js jitters its auto-refresh and KEEPS its hidden guard", () => {
    const code = codeLines(readPublic("planner-history-list.js"));
    expect((code + "\n  historyRefreshTimer = setTimeout(loadHistory, HISTORY_AUTO_REFRESH_MS);")
      .match(/setTimeout\(loadHistory, HISTORY_AUTO_REFRESH_MS\)/g)?.length).toBe(1);
    expect(code.match(/setTimeout\(loadHistory, HISTORY_AUTO_REFRESH_MS\)/g)).toBe(null);
    expect(code).toContain("baseMs: HISTORY_AUTO_REFRESH_MS");
    // This file ALREADY shed load correctly. Assert the guard survived the edit --
    // a jitter change that quietly dropped it would be a net regression.
    expect(code).toContain("if (document.hidden) return;");
  });

  it("the policy is actually LOADED on every page that arms a poll", () => {
    // A jittered call site on a page that never loads poll-schedule.js throws at
    // poll time. planner.html already had it; cast.html and modules.html did not.
    for (const page of ["planner.html", "cast.html", "modules.html"]) {
      expect(readPublic(page)).toContain('<script src="poll-schedule.js">');
    }
    // Control: settings.html arms no poll and is deliberately NOT given the script,
    // so this pair fails if someone "fixes" it by adding the tag everywhere.
    expect(readPublic("settings.html")).not.toContain('<script src="poll-schedule.js">');
  });

  it("DECLARED EXCLUSION: cast.js's bounded refs-job loop is still flat, on purpose", () => {
    // cast.js:~1030 is a BOUNDED for-loop with an inline await-sleep, not a
    // self-rescheduling timer, and it is capped by maxPolls. Different shape, ruled
    // out of scope. Asserted rather than omitted so the exclusion is visible and a
    // later reader does not read its absence as an oversight.
    const code = codeLines(readPublic("cast.js"));
    expect(code).toContain("await new Promise((r) => setTimeout(r, 1500));");
  });
});
