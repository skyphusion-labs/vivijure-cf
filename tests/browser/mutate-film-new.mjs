// Removes each start form guard and requires the browser test to go red.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const F = "public/films-new.js";
const M = [
  ["confirm first", 'if ($("new-confirm").returnValue === "go") start();', "start();"],
  ["asks before start", '$("new-start").addEventListener("click", askStart);', '$("new-start").addEventListener("click", start);'],
  ["one key per form", 'idempotency_key: idempotencyKey,', 'idempotency_key: "form-" + crypto.randomUUID(),'],
  ["cast slot required", 'if (!sel.value) out.push("Choose a cast member for slot " + sel.dataset.slot + ".");', ""],
  ["part cap", 'if (render.max_scenes_per_part && largest > render.max_scenes_per_part) out.push(', 'if (false) out.push('],
  ["parts cap", 'if (render.max_parts && count > render.max_parts) out.push(', 'if (false) out.push('],
  ["spoken hides silent", "b && hasSpokenLines(b) ? doors.filter(canSpeak) : doors", "doors"],
  ["shot ids", 'if (ids.some((i) => !i) || new Set(ids).size !== ids.length) out.push("Every shot needs its own id.");', ""],
  ["seconds", 'if (b.scenes.some((s) => seconds(s) <= 0)) out.push("Every shot needs seconds above 0.");', ""],
  ["estimate multiplied", 'Number($("new-per-shot").value) * b.scenes.length', 'Number($("new-per-shot").value)'],
  ["hold honest", "? \"It stops after the first part, so you can watch it before the rest run.\"", "? \"Every part runs.\""],
  ["refusal shown", '"Not started: " + (out.error || "the studio answered " + res.status)', '""'],
  ["refusal stays on form", "if (!res.ok || !out.film_id) {", "if (false) {"],
  ["breaks win", "if (breaks) req.breaks = breaks.split(\",\").map(Number);\n    else req.part_size", "req.part_size"],
  ["project with no board", '.filter((p) => p.last_storyboard)', ""],
  ["safe project name", '.replace(/[^A-Za-z0-9_-]+/g, "_")', ""],
  ["refs carry every key", ".concat(c.ref_keys || [], c.source_keys || [])", ""],
  ["bad overrides stopped", "if (!overridesOk) {", "if (false) {"],
];
let survived = 0, ran = 0;
const original = readFileSync(F, "utf8");
for (const [name, find, replace] of M) {
  if (original.split(find).length !== 2) { console.log(`HARNESS ${name}: matched ${original.split(find).length - 1}`); survived++; continue; }
  writeFileSync(F, original.replace(find, () => replace));
  ran++;
  try {
    const r = spawnSync("node", ["tests/browser/film-new.mjs"], { encoding: "utf8", timeout: 100000 });
    const fails = r.stdout.split("\n").filter((l) => /^(FAIL|HARNESS)/.test(l));
    const red = r.status !== 0 && fails.length > 0;
    console.log(`${red ? "RED     " : "SURVIVED"} ${name}: ${fails[0]?.slice(0, 80) ?? "status " + r.status}`);
    if (!red) survived++;
  } finally {
    writeFileSync(F, original);
  }
}
console.log(`${ran} of ${M.length} ran, ${survived} survived`);
process.exit(survived || !ran ? 1 : 0);
