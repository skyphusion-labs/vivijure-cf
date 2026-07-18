// The catalog projection: studio model rows derived from the modules that DECLARE them.
//
// Port of vivijure-local/src/module-catalog.ts, upstream-first per the shared-surface rule. One
// implementation for every hook that offers models. Before cf#129 phase 2 this logic existed once
// for plan.enhance while the image rows were a hardcoded list maintained by hand on each host --
// which is exactly how the two hosts drifted apart by a model (vivijure-local#106). A projection
// has one source of truth per model: the module that can actually run it.
//
// The emitted row shape is FROZEN and shared: { id, label, group, type, capabilities }. public/ is a
// verbatim-shared surface between this host and vivijure-local, and the panel renders any row
// generically and filters on `type`. Adding a field here is a shared-surface change: upstream in
// local first, and it goes to the panel lane before it goes to code.
//
// There is deliberately NO special-casing of any module NAME anywhere in this file.

import { servingForHook } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import type { HookName } from "@skyphusion-labs/vivijure-core/modules/types";
import type { ModelEntry, ModelType } from "./models";

export interface CatalogTarget {
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

/** Project the catalog rows offered by every module serving `hook`.
 *
 *  A module declaring config_schema.model as an enum contributes ONE ROW PER VALUE. A module serving
 *  the hook with NO model enum still appears, as a single row under its own name -- it does the job
 *  with whatever it uses, and that is its business, not the studio's. */
export function catalogFromModules(
  modules: RegisteredModule[],
  hook: HookName,
  type: ModelType,
  groupPrefix: string,
): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const mod of servingForHook(modules, hook)) {
    const group = `${groupPrefix} · ${mod.name}`;
    const values = modelValues(mod);
    if (values.length > 0) {
      for (const id of values) {
        out.push({ id, label: `${moduleLabel(mod)} · ${id}`, group, type, capabilities: [] });
      }
      continue;
    }
    out.push({ id: mod.name, label: moduleLabel(mod), group, type, capabilities: [] });
  }
  return out;
}

/** Resolve a client-supplied model id to the module + config.model that should answer it, for a
 *  given hook. Same three-way resolution as the planning catalog: declared enum value, module name,
 *  or sole-module default. With several modules installed and no match this returns null -- guessing
 *  which one owns an unknown id would be inventing an answer. */
export function resolveCatalogTarget(
  modules: RegisteredModule[],
  hook: HookName,
  modelId: string,
): CatalogTarget | null {
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const serving = servingForHook(modules, hook);

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
    return { moduleName: mod.name, modelId: trimmed, configModel: values[0] ?? mod.name };
  }

  return null;
}

/** The image rows: projected from installed image.generate modules. Replaces the hardcoded
 *  src/image-models.ts that both hosts maintained by hand (and drifted). */
export function imageModelsFromModules(modules: RegisteredModule[]): ModelEntry[] {
  return catalogFromModules(modules, "image.generate", "image", "Image Gen");
}
