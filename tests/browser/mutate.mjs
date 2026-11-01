// Removes each fix and requires the browser test to go red. A guard that stays green is decoration.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const M = [
  ["planState export", "public/planner-state.js", 'if (typeof window !== "undefined") window.planState = planState;', ""],
  ["dock auto-open guard", "public/planner-init.js", 'if (!window.matchMedia("(max-width: 900px)").matches) setOpen(true);', "setOpen(true);"],
  ["dock top measured", "public/planner-init.js", "if (open) syncDockTop();", ""],
  ["look route", "public/planner-render-config.js", 'if (look && LOOK_DOORS[look] && installedKeyframeDoor(LOOK_DOORS[look])) return LOOK_DOORS[look];', ""],
  ["look style", "public/planner-render-config.js", "overrides.config[route] = { ...(overrides.config[route] || {}), style: look };", ""],
  ["confirm", "public/planner-render.js", "if (!keyframesOnly && !(await confirmFilmSpend(renderOverrides))) {", "if (false) {"],
  ["cancel honored", "public/planner-render.js", 'resolve(dlg.returnValue === "start")', "resolve(true)"],
  ["rate multiplied", "public/planner-render-config.js", "low: known ? rate[0] * seconds : null,", "low: known ? rate[0] : null,"],
  ["refusal is hard", "public/planner-render.js", 'showLoraPreflightWarning(unready);\n  setRenderStatus(', 'return true;\n  setRenderStatus('],
  ["anime skips the LoRA gate", "public/planner-render.js", ' || keyframeDoorForSubmit() === "cloud-keyframe"', ""],
  ["counters cleared", "public/planner-render.js", '$("#planner-render-scene").hidden = true;\n    $("#planner-render-phase").hidden = true;', ""],
  ["raw output hidden", "public/styles.css", ".filmmaker-surface #planner-render-output { display: none; }", ""],
];
const only = process.argv[2];
let survived = 0, ran = 0;
for (const [name, file, find, replace] of M) {
  if (only && !name.includes(only)) continue;
  const original = readFileSync(file, "utf8");
  if (original.split(find).length !== 2) { console.log(`HARNESS ${name}: matched ${original.split(find).length - 1}`); survived++; continue; }
  writeFileSync(file, original.replace(find, () => replace));
  ran++;
  try {
    const r = spawnSync("node", ["tests/browser/planner-phone.mjs"], { encoding: "utf8", timeout: 240000 });
    const fails = r.stdout.split("\n").filter((l) => /^(FAIL|HARNESS)/.test(l));
    const red = r.status !== 0 && fails.length > 0;
    console.log(`${red ? "RED     " : "SURVIVED"} ${name}: ${fails[0]?.slice(0, 90) ?? "no failure line, status " + r.status}`);
    if (!red) survived++;
  } finally {
    writeFileSync(file, original);
  }
}
console.log(`${ran} of ${M.length} ran, ${survived} survived`);
process.exit(survived || !ran ? 1 : 0);
