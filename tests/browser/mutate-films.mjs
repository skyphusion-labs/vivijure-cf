// Removes each film board guard and requires the browser test to go red.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const F = "public/films.js";
const M = [
  ["null actual stays unknown", '"Actual spend is not known per film."', '"Actual spend $0.00."'],
  ["retry asks first", 'retry.addEventListener("click", () => askRetry(part));', 'retry.addEventListener("click", () => retry(part.index));'],
  ["go back honoured", '$("film-retry-dialog").returnValue === "go" && action', "action"],
  ["retry body", "{ shots: \"failed\" }", "{}"],
  ["refusal surfaced", 'subject + " did not change: " + (out.error || "the studio answered " + res.status)', '""'],
  ["running parts keep polling", 'if ((film.parts || []).some((p) => p.status === "running")) return true;', ""],
  ["stops polling when nothing moves", "if (document.hidden || !stillMoving(film)) return;", "if (document.hidden) return;"],
  ["rows reused", "known && known.sig === sig ? known.row : buildPart(film, part)", "buildPart(film, part)"],
  ["no player until asked", 'row.append(actions, watchControl(part.output_key, "Watch this part"));', 'row.append(actions, watchControl(part.output_key, "Watch this part")); row.querySelector(".films-watch button").click();'],
  ["resume visible on a hold", 'resume.hidden = !rejoin && !(stopped && !failedParts && kind !== "spend_ceiling" && kind !== "gate_held");', "resume.hidden = !rejoin;"],
  ["no resume over a failed part", 'stopped && !failedParts && kind', "stopped && kind"],
  ["no resume at the ceiling", ' && kind !== "spend_ceiling" && kind !== "gate_held"', ""],
  ["ceiling by code", "if (film.stop_code) return film.stop_code;", ""],
  ["ceiling by text", '/spend ceiling/i.test(film.stop_reason || "") ? "spend_ceiling" : ""', '""'],
  ["ceiling while running", 'film.phase === "stopped" || kind === "spend_ceiling"', 'film.phase === "stopped"'],
  ["all films loaded", "      loadAllFilms();\n", ""],
  ["device list steps aside", '$("films-recent-wrap").hidden = true;', ""],
  ["rejoin needs every part done", 'film.phase === "failed" && allPartsDone(film)', 'film.phase === "failed"'],
  ["held reason shown", "stop.hidden = !stopped && !film.stop_reason;", "stop.hidden = !stopped;"],
  ["unknown submit warns", 'String(part.error || "").includes("submit outcome unknown")', "false"],
  ["ceiling closed on a finished film", 'film.phase !== "done" && film.phase !== "failed"', "true"],
  ["ceiling posts", '{ spend_ceiling_usd: value }', "{}"],
  ["shots wait until asked", "if (openParts.has(part.index)) paint(true);\n", "paint(true);\n"],
  ["open stays open", "if (openParts.has(part.index)) paint(true);\n", ""],
  ["no retake on a running part", 'if (part.status === "done") return true;\n    return part.status === "pending" && Array.isArray(part.retake_shots) && part.retake_shots.length > 0;', "return true;"],
  ["pending retake adds", 'return part.status === "pending" && Array.isArray(part.retake_shots) && part.retake_shots.length > 0;', "return false;"],
  ["cancel only when allowed", 'inRetake.length && (part.status === "pending" || part.status === "failed")', "inRetake.length"],
  ["retake asks first", 'retake.addEventListener("click", () => askRetake(shot));', 'retake.addEventListener("click", () => post("/shots/" + shot.shot_id + "/retake", {}, "x", "y"));'],
  ["retake go back", '$("film-retake-dialog").returnValue === "go" && shot', "shot"],
  ["retake sends only changes", 'if (prompt && prompt !== (shot.prompt || "").trim()) body.prompt = prompt;', "body.prompt = prompt;"],
  ["retake sends line", 'if (line !== (shot.line || "").trim()) body.line = line;', ""],
  ["retake sends voice", "if (voice) body.voice_id = voice;", ""],
  ["old film note", '$("film-retake-note").hidden = !(retaking && film.output_key);', '$("film-retake-note").hidden = true;'],
  ["not stuck note", 'part.status === "running" && part.shots_total > 0 && part.shots_done >= part.shots_total', "false"],
  ["timing note", '": saved."', '""'],
  ["retake keeps polling", ' || (p.status === "pending" && Array.isArray(p.retake_shots) && p.retake_shots.length)', ""],
  ["failed retake stops polling", '(p.status === "pending" && Array.isArray(p.retake_shots) && p.retake_shots.length)', "(Array.isArray(p.retake_shots) && p.retake_shots.length)"],
  ["minute needs a live cron", 'alive ? " It takes effect within about a minute." : ""', '" It takes effect within about a minute."'],
  ["server note shown", '+ (typeof out.note === "string" && out.note ? " " + out.note : "")', ""],
  ["go to shot finds the part", "index >= p.shot_from && index <= p.shot_to", "index >= p.shot_from"],
  ["go to shot marks it", 'card.classList.add("films-shot-found");', ""],
  ["clip waits for a tap", 'if (shot.clip_key) card.append(watchControl(shot.clip_key, "Watch clip"));', 'if (shot.clip_key) { const w = watchControl(shot.clip_key, "Watch clip"); w.querySelector("button").click(); card.append(w); }'],
  ["shot failure surfaced", 'box.textContent = "Could not load the shots of this part.";', ""],
  ["new still off by default", '$("film-retake-still").checked = false;', '$("film-retake-still").checked = true;'],
  ["new still sent", 'if ($("film-retake-still").checked) body.new_still = true;', ""],
  ["stale shown", '$("film-cron").hidden = !stale;', '$("film-cron").hidden = true;'],
  ["stale only while moving", "!!(film.cron && film.cron.stale) && stillMoving(film)", "!!(film.cron && film.cron.stale)"],
  ["basis shown", '$("film-basis").textContent = film.spend_ceiling_basis || "";', ""],
  ["stop reason shown", 'film.stop_reason || "No reason given."', '"Stopped."'],
  ["limit shown", "$(\"film-degraded\").hidden = !degraded;", "$(\"film-degraded\").hidden = true;"],
  ["part filter", 'parts.filter((p) => p.status === "failed" || p.status === "running")', "parts"],
  ["remembers films", "remember(film);", ""],
  ["unknown id", 'note.textContent = "No film with that id on this studio.";', ""],
];
let survived = 0, ran = 0;
const only = process.argv[2];
const original = readFileSync(F, "utf8");
for (const [name, find, replace] of M) {
  if (only && !name.includes(only)) continue;
  if (original.split(find).length !== 2) { console.log(`HARNESS ${name}: matched ${original.split(find).length - 1}`); survived++; continue; }
  writeFileSync(F, original.replace(find, () => replace));
  ran++;
  try {
    const r = spawnSync("node", ["tests/browser/film-board.mjs"], { encoding: "utf8", timeout: 200000 });
    const fails = r.stdout.split("\n").filter((l) => /^(FAIL|HARNESS)/.test(l));
    const red = r.status !== 0 && fails.length > 0;
    console.log(`${red ? "RED     " : "SURVIVED"} ${name}: ${fails[0]?.slice(0, 90) ?? "status " + r.status}`);
    if (!red) survived++;
  } finally {
    writeFileSync(F, original);
  }
}
console.log(`${ran} of ${M.length} ran, ${survived} survived`);
process.exit(survived || !ran ? 1 : 0);
