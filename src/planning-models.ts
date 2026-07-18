// The planning-model catalog, PROJECTED from installed plan.enhance modules (cf#62).
//
// Conrad's ruling (2026-07-17): "nothing should be providing model names but plan.enhance." The
// studio is a bare skeleton -- it holds no model names and no provider routing. GET
// /api/storyboard/models is built here by asking every installed module that serves the
// plan.enhance hook what it offers:
//
//   - a module declaring config_schema.model as an enum contributes ONE ROW PER ENUM VALUE;
//   - a module serving plan.enhance with NO model enum still appears, as one row under its own
//     name/label (it plans with whatever it plans with, and that is its business);
//   - resolvePlanningTarget routes a chosen id back to the module that declared it.
//
// There is deliberately NO special-casing of the "plan-enhance" module name anywhere in this file.
// A third-party plan.enhance module is discovered, listed, and dispatched to on exactly the same
// path as ours -- that is the module contract, and tests/planning-models.test.ts installs a
// third-party-shaped fixture to prove it.
import { servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import type { ModelEntry } from "./models";

/** A planning row: a ModelEntry plus the module that declared it, so the panel never has to parse
 *  the owning module back out of `group`. */
export interface PlanningModelEntry extends ModelEntry {
  module: string;
}

export interface PlanningTarget {
  moduleName: string;
  modelId: string;
  /** The value to hand back as config.model. Undefined when the module declared no model enum. */
  configModel?: string;
}

/** A module's display name: its first `provides` label when it has one, else the module name. */
function moduleLabel(mod: RegisteredModule): string {
  const label = mod.provides?.[0]?.label;
  return (typeof label === "string" && label.trim()) || mod.name;
}

/** The declared model enum values for a module, or [] when it declares none. */
function modelValues(mod: RegisteredModule): string[] {
  const field = mod.config_schema?.model;
  return field?.type === "enum" ? field.values.map(String) : [];
}

/** Build the GET /api/storyboard/models catalog from the installed plan.enhance modules. */
export function planningModelsFromModules(modules: RegisteredModule[]): PlanningModelEntry[] {
  const out: PlanningModelEntry[] = [];
  for (const mod of servingForHook(modules, "plan.enhance")) {
    const values = modelValues(mod);
    if (values.length > 0) {
      for (const id of values) {
        out.push({
          id,
          label: `${moduleLabel(mod)} · ${id}`,
          group: `Planning · ${mod.name}`,
          type: "chat",
          capabilities: [],
          module: mod.name,
        });
      }
      continue;
    }
    out.push({
      id: mod.name,
      label: moduleLabel(mod),
      group: `Planning · ${mod.name}`,
      type: "chat",
      capabilities: [],
      module: mod.name,
    });
  }
  return out;
}

/** Resolve a client-supplied model id to the module + config.model that should answer it.
 *
 *  Three ways an id resolves, in order:
 *    1. a module declared it in its config_schema.model enum (the normal path);
 *    2. the id IS a module name (the no-enum module case);
 *    3. exactly one plan.enhance module is installed, so it answers by default -- an unknown id
 *       still lands somewhere sensible rather than 400-ing a single-module deployment.
 *  With several modules installed and no match, this returns null: guessing which one owns an
 *  unknown id would be inventing an answer. */
export function resolvePlanningTarget(
  modules: RegisteredModule[],
  modelId: string,
): PlanningTarget | null {
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const serving = servingForHook(modules, "plan.enhance");

  for (const mod of serving) {
    if (modelValues(mod).includes(trimmed)) {
      return { moduleName: mod.name, modelId: trimmed, configModel: trimmed };
    }
  }

  const byName = serving.find((m) => m.name === trimmed);
  if (byName) return { moduleName: byName.name, modelId: trimmed };

  if (serving.length === 1) {
    const mod = serving[0]!;
    const values = modelValues(mod);
    const fallback = values[0] ?? mod.name;
    return { moduleName: mod.name, modelId: trimmed, configModel: fallback };
  }

  return null;
}

/** The catalog row for a model id, or undefined when nothing installed declares it. */
export function findPlanningModel(
  modules: RegisteredModule[],
  modelId: string,
): PlanningModelEntry | undefined {
  return planningModelsFromModules(modules).find((m) => m.id === modelId);
}
