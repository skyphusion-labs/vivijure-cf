var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/@skyphusion-labs/vivijure-core/dist/modules/types.js
var MODULE_API = "vivijure-module/2";
var SUPPORTED_MODULE_APIS = /* @__PURE__ */ new Set(["vivijure-module/2"]);
var HOOK_NAMES = [
  "keyframe",
  "motion.backend",
  "finish",
  "score",
  "dialogue",
  "speech",
  "plan.enhance",
  "image.generate",
  "cast.image",
  "notify",
  "master",
  "film.finish"
];
var HOOK_CARDINALITY = {
  keyframe: "pick_one",
  "motion.backend": "pick_one",
  finish: "chain",
  score: "chain",
  dialogue: "pick_one",
  speech: "chain",
  "plan.enhance": "chain",
  "image.generate": "pick_one",
  "cast.image": "pick_one",
  notify: "chain",
  master: "chain",
  "film.finish": "chain"
};
var HOOK_BLURBS = {
  keyframe: "storyboard -> start keyframes (SDXL)",
  "motion.backend": "keyframe -> shot clip (GPU or cloud)",
  finish: "interpolation / upscale / face restore",
  score: "music / narration / beat-sync",
  dialogue: "spoken lines -> per-character voice (TTS)",
  speech: "clean / enhance dialogue audio",
  "plan.enhance": "LLM auto-direction",
  "image.generate": "prompt -> a generated image",
  "cast.image": "character refs from a portrait + bible",
  notify: "render-complete notification (email / webhook)",
  master: "film-level audio mastering: music upscale + loudness",
  "film.finish": "title / credit cards on the finished film"
};
var HOOK_DISPLAY_ORDER = {
  "plan.enhance": 10,
  "cast.image": 20,
  "image.generate": 30,
  keyframe: 40,
  "motion.backend": 50,
  dialogue: 60,
  speech: 70,
  finish: 80,
  score: 90,
  master: 100,
  "film.finish": 110,
  notify: 120
};

// node_modules/@skyphusion-labs/vivijure-core/dist/modules/manifest-validate.js
function validateManifest(raw) {
  if (!raw || typeof raw !== "object")
    return "manifest is not an object";
  const m = raw;
  if (!SUPPORTED_MODULE_APIS.has(String(m.api)))
    return `unsupported api ${String(m.api)} (core speaks ${MODULE_API}, accepts ${[...SUPPORTED_MODULE_APIS].join(", ")})`;
  if (typeof m.name !== "string" || !m.name)
    return "manifest missing name";
  if (typeof m.version !== "string" || !m.version)
    return "manifest missing version";
  if (!Array.isArray(m.hooks) || m.hooks.length === 0)
    return "manifest declares no hooks";
  const known = new Set(HOOK_NAMES);
  const bad2 = m.hooks.filter((h) => !known.has(h));
  if (bad2.length)
    return `manifest declares unknown hooks: ${bad2.join(", ")}`;
  if (m.finish_artifacts !== void 0) {
    const fa = m.finish_artifacts;
    if (!fa || typeof fa !== "object")
      return "finish_artifacts is not an object";
    const ok2 = fa.output_key;
    if (!ok2 || typeof ok2 !== "object")
      return "finish_artifacts.output_key missing";
    if (ok2.kind === "shot_named") {
      if (typeof ok2.filename !== "string" || !ok2.filename)
        return "finish_artifacts.output_key.filename missing";
    } else if (ok2.kind === "append_suffix") {
      if (typeof ok2.suffix !== "string" || !ok2.suffix)
        return "finish_artifacts.output_key.suffix missing";
    } else {
      return `finish_artifacts.output_key.kind ${JSON.stringify(ok2.kind)} unknown (shot_named | append_suffix)`;
    }
    if (fa.applied !== void 0) {
      if (!Array.isArray(fa.applied))
        return "finish_artifacts.applied is not an array";
      for (const r of fa.applied) {
        const rule = r;
        if (!rule || typeof rule !== "object" || typeof rule.tag !== "string" || !rule.tag)
          return "finish_artifacts.applied rule missing tag";
        if (rule.when !== void 0) {
          const w = rule.when;
          if (!w || typeof w !== "object" || typeof w.knob !== "string" || !w.knob || w.equals === void 0)
            return "finish_artifacts.applied rule has a malformed when clause";
        }
      }
    }
  }
  if (m.keyframe_label !== void 0) {
    if (typeof m.keyframe_label !== "string" || !m.keyframe_label.trim())
      return "keyframe_label must be a non-empty string";
  }
  return m;
}
__name(validateManifest, "validateManifest");

// node_modules/@skyphusion-labs/vivijure-core/dist/modules/registry.js
function isFetcher(v) {
  return !!v && typeof v.fetch === "function";
}
__name(isFetcher, "isFetcher");
function isDispatch(v) {
  return !!v && typeof v.get === "function";
}
__name(isDispatch, "isDispatch");
function isDemoEnv(env) {
  return typeof env.AUTH_MODE === "string" && env.AUTH_MODE.trim() === "demo";
}
__name(isDemoEnv, "isDemoEnv");
var DISPATCH_BINDING = "MODULE_DISPATCH";
var DISPATCH_REF_PREFIX = "dispatch:";
function dispatchRef(scriptName) {
  return DISPATCH_REF_PREFIX + scriptName;
}
__name(dispatchRef, "dispatchRef");
function resolveFetcher(env, binding) {
  if (binding.startsWith(DISPATCH_REF_PREFIX)) {
    const ns = env[DISPATCH_BINDING];
    if (!isDispatch(ns))
      return null;
    try {
      return ns.get(binding.slice(DISPATCH_REF_PREFIX.length));
    } catch {
      return null;
    }
  }
  const v = env[binding];
  return isFetcher(v) ? v : null;
}
__name(resolveFetcher, "resolveFetcher");
function moduleBindingNames(env) {
  return Object.keys(env).filter((k) => k.startsWith("MODULE_") && k !== DISPATCH_BINDING && isFetcher(env[k])).sort();
}
__name(moduleBindingNames, "moduleBindingNames");
function validateConfig(schema, user) {
  const out = {};
  if (!schema)
    return out;
  const u = user ?? {};
  for (const [key, field] of Object.entries(schema)) {
    const v = u[key];
    switch (field.type) {
      case "int":
      case "float": {
        let n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n))
          n = field.default;
        if (typeof field.min === "number")
          n = Math.max(field.min, n);
        if (typeof field.max === "number")
          n = Math.min(field.max, n);
        out[key] = field.type === "int" ? Math.round(n) : n;
        break;
      }
      case "bool":
        out[key] = typeof v === "boolean" ? v : field.default;
        break;
      case "enum":
        out[key] = field.values.includes(v) ? v : field.default;
        break;
      case "string":
        out[key] = typeof v === "string" ? v : field.default;
        break;
    }
  }
  return out;
}
__name(validateConfig, "validateConfig");
function indexByHook(modules) {
  const byHook = {};
  const ordered = [...modules].sort((a, b) => (a.ui?.order ?? 100) - (b.ui?.order ?? 100) || a.name.localeCompare(b.name));
  for (const m of ordered) {
    for (const hook of m.hooks) {
      (byHook[hook] ??= []).push(m.name);
    }
  }
  return byHook;
}
__name(indexByHook, "indexByHook");
function hookCatalog() {
  return HOOK_NAMES.map((name) => ({
    name,
    blurb: HOOK_BLURBS[name],
    cardinality: HOOK_CARDINALITY[name],
    order: HOOK_DISPLAY_ORDER[name]
  }));
}
__name(hookCatalog, "hookCatalog");
function toPublic({ binding: _binding, ...manifest }) {
  return manifest;
}
__name(toPublic, "toPublic");
function modulesResponse(modules, render, host) {
  return {
    api: MODULE_API,
    modules: modules.map(toPublic),
    hooks: indexByHook(modules),
    catalog: hookCatalog(),
    render,
    ...host ? { host } : {}
  };
}
__name(modulesResponse, "modulesResponse");
var MANIFEST_READ_TIMEOUT_MS = 3e3;
var MANIFEST_READ_ATTEMPTS = 3;
var MANIFEST_RETRY_BASE_MS = 120;
function isRetryableManifestStatus(status) {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}
__name(isRetryableManifestStatus, "isRetryableManifestStatus");
async function readManifest(binding, fetcher) {
  let lastReason = "";
  for (let attempt = 0; attempt < MANIFEST_READ_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === MANIFEST_READ_ATTEMPTS - 1;
    try {
      const res = await fetcher.fetch("https://module/module.json", {
        signal: AbortSignal.timeout(MANIFEST_READ_TIMEOUT_MS)
      });
      if (!res.ok) {
        if (isRetryableManifestStatus(res.status) && !lastAttempt) {
          lastReason = `GET /module.json -> ${res.status}`;
          await new Promise((r) => setTimeout(r, MANIFEST_RETRY_BASE_MS * (attempt + 1)));
          continue;
        }
        console.warn(`module ${binding}: GET /module.json -> ${res.status}; skipping`);
        return null;
      }
      const parsed = validateManifest(await readModuleJson(res));
      if (typeof parsed === "string") {
        console.warn(`module ${binding}: invalid manifest (${parsed}); skipping`);
        return null;
      }
      return { ...parsed, binding };
    } catch (e) {
      lastReason = e.message;
      if (!lastAttempt) {
        await new Promise((r) => setTimeout(r, MANIFEST_RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
    }
  }
  console.warn(`module ${binding}: unreachable after ${MANIFEST_READ_ATTEMPTS} attempts (${lastReason}); skipping`);
  return null;
}
__name(readManifest, "readManifest");
var discoveryCache = null;
async function discoverDispatchModules(env) {
  const ns = env[DISPATCH_BINDING];
  if (!isDispatch(ns) && !isDemoEnv(env))
    return [];
  const db = env.DB;
  if (!db || typeof db.prepare !== "function")
    return [];
  let rows;
  try {
    const res = await db.prepare("SELECT name, script_name, manifest_json, api FROM installed_modules WHERE enabled = 1").all();
    rows = res.results ?? [];
  } catch (e) {
    console.warn(`dispatch discovery: installed_modules read failed (${e.message}); skipping`);
    return [];
  }
  const out = [];
  for (const row of rows) {
    let raw;
    try {
      raw = JSON.parse(row.manifest_json);
    } catch {
      console.warn(`dispatch module ${row.name}: manifest_json is not valid JSON; skipping`);
      continue;
    }
    const parsed = validateManifest(raw);
    if (typeof parsed === "string") {
      console.warn(`dispatch module ${row.name}: stored manifest invalid (${parsed}); skipping`);
      continue;
    }
    out.push({ ...parsed, binding: dispatchRef(row.script_name) });
  }
  return out;
}
__name(discoverDispatchModules, "discoverDispatchModules");
function mergeRegistries(service, dispatch) {
  const byName = /* @__PURE__ */ new Map();
  for (const m of service)
    byName.set(m.name, m);
  for (const m of dispatch) {
    if (byName.has(m.name)) {
      console.warn(`module ${m.name}: installed via dispatch AND service-bound; service binding wins (migration overlap)`);
      continue;
    }
    byName.set(m.name, m);
  }
  return [...byName.values()];
}
__name(mergeRegistries, "mergeRegistries");
async function discoverModules(env, opts = {}) {
  const ttl = opts.cacheTtlMs ?? 0;
  const now = opts.nowMs ?? Date.now();
  if (ttl > 0 && discoveryCache && now < discoveryCache.expiresAt) {
    return discoveryCache.modules;
  }
  const names = moduleBindingNames(env);
  const [read, dispatch] = await Promise.all([
    Promise.all(names.map((n) => readManifest(n, env[n]))),
    discoverDispatchModules(env)
  ]);
  const service = read.filter((m) => m !== null);
  const modules = mergeRegistries(service, dispatch);
  if (ttl > 0)
    discoveryCache = { modules, expiresAt: now + ttl };
  return modules;
}
__name(discoverModules, "discoverModules");
function resolvePickOne(modules, hook, choice) {
  const serving = modules.filter((m) => m.hooks.includes(hook));
  if (serving.length === 0)
    return null;
  if (choice)
    return serving.find((m) => m.name === choice) ?? null;
  return serving[0];
}
__name(resolvePickOne, "resolvePickOne");
function servingForHook(modules, hook) {
  return [...modules].filter((m) => m.hooks.includes(hook)).sort((a, b) => (a.ui?.order ?? 100) - (b.ui?.order ?? 100) || a.name.localeCompare(b.name));
}
__name(servingForHook, "servingForHook");
function cloudMotionModules(modules) {
  return servingForHook(modules, "motion.backend").filter((m) => (m.ui?.locality ?? "cloud") === "cloud");
}
__name(cloudMotionModules, "cloudMotionModules");
function gpuDoorMotionModules(modules) {
  const l = /* @__PURE__ */ __name((m) => m.ui?.locality, "l");
  return servingForHook(modules, "motion.backend").filter((m) => l(m) === "byo" || l(m) === "local");
}
__name(gpuDoorMotionModules, "gpuDoorMotionModules");
function defaultGpuDoorModule(modules) {
  const doors = gpuDoorMotionModules(modules);
  return doors.find((m) => m.ui?.locality === "byo") ?? doors[0];
}
__name(defaultGpuDoorModule, "defaultGpuDoorModule");
function motionBackendPreflightError(modules, explicitChoice) {
  const names = servingForHook(modules, "motion.backend").map((m) => m.name);
  if (names.length === 0) {
    return "no motion.backend module is installed, so a full film cannot be rendered. Install a motion backend, or submit a keyframes-only render.";
  }
  const choice = (explicitChoice ?? "").trim();
  if (!choice) {
    return `choose a motion backend for a full render -- a full film needs one to turn keyframes into video. Installed: ${names.join(", ")}. (Or submit a keyframes-only render, which needs no motion backend.)`;
  }
  if (!names.includes(choice)) {
    return `motion backend "${choice}" is not an installed, serving module. Choose one of: ${names.join(", ")}.`;
  }
  return null;
}
__name(motionBackendPreflightError, "motionBackendPreflightError");
function localGpuKeyframePreflightError(modules, motionBackend, keyframeBackend) {
  const motionName = (motionBackend ?? "").trim();
  if (!motionName)
    return null;
  const motion = servingForHook(modules, "motion.backend").find((m) => m.name === motionName);
  if (!motion || (motion.ui?.locality ?? "cloud") !== "local")
    return null;
  const localKf = servingForHook(modules, "keyframe").find((m) => (m.ui?.locality ?? "cloud") === "local") ?? servingForHook(modules, "keyframe").find((m) => m.name === motion.name);
  if (!localKf) {
    return `motion backend "${motionName}" is a local GPU door, but no local keyframe module is installed. The local-gpu module must serve the keyframe hook (or install another locality:"local" keyframe module). Refusing to silently route keyframes through RunPod/cloud.`;
  }
  const kfName = (keyframeBackend ?? "").trim();
  if (!kfName || kfName === localKf.name)
    return null;
  const chosen = servingForHook(modules, "keyframe").find((m) => m.name === kfName);
  if (!chosen)
    return null;
  if ((chosen.ui?.locality ?? "cloud") === "local")
    return null;
  return `motion backend "${motionName}" requires local keyframes; keyframe backend "${kfName}" is not local (locality "${chosen.ui?.locality ?? "cloud"}"). Use "${localKf.name}" or omit keyframe_backend to auto-select it.`;
}
__name(localGpuKeyframePreflightError, "localGpuKeyframePreflightError");
function configPreflightViolations(schema, user) {
  const out = [];
  const entries = Object.entries(user ?? {});
  if (!entries.length)
    return out;
  const declared = Object.keys(schema ?? {});
  for (const [key, v] of entries) {
    const field = schema?.[key];
    if (!field) {
      out.push(declared.length ? `unknown key "${key}" (declared keys: ${declared.join(", ")})` : `unknown key "${key}" (this module declares no config keys)`);
      continue;
    }
    switch (field.type) {
      case "int":
      case "float": {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          out.push(`"${key}": expected a number, got ${JSON.stringify(v)}`);
        } else if (typeof field.min === "number" && n < field.min || typeof field.max === "number" && n > field.max) {
          out.push(`"${key}": ${n} is out of range [${field.min ?? "-inf"}, ${field.max ?? "inf"}]`);
        }
        break;
      }
      case "bool":
        if (typeof v !== "boolean")
          out.push(`"${key}": expected true or false, got ${JSON.stringify(v)}`);
        break;
      case "enum":
        if (!field.values.includes(v)) {
          out.push(`"${key}": ${JSON.stringify(v)} is not supported (allowed: ${field.values.join(", ")})`);
        }
        break;
      case "string":
        if (typeof v !== "string")
          out.push(`"${key}": expected a string, got ${JSON.stringify(v)}`);
        break;
    }
  }
  return out;
}
__name(configPreflightViolations, "configPreflightViolations");
function motionConfigPreflightError(modules, backendName, userConfig) {
  const name = (backendName ?? "").trim();
  if (!name)
    return null;
  const module = servingForHook(modules, "motion.backend").find((m) => m.name === name);
  if (!module)
    return null;
  const violations = configPreflightViolations(module.config_schema, userConfig);
  return violations.length ? `motion_config rejected by "${name}" before any GPU spend: ${violations.join("; ")}.` : null;
}
__name(motionConfigPreflightError, "motionConfigPreflightError");
function transportLabel(module) {
  return module.binding.startsWith(DISPATCH_REF_PREFIX) ? module.binding : `binding ${module.binding}`;
}
__name(transportLabel, "transportLabel");
function fetcherFor(env, module) {
  return resolveFetcher(env, module.binding);
}
__name(fetcherFor, "fetcherFor");
var MAX_MODULE_RESPONSE_BYTES = 1024 * 1024;
async function readModuleJson(res) {
  const body = res.body;
  if (!body)
    return res.json();
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (!value)
      continue;
    total += value.length;
    if (total > MAX_MODULE_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
      }
      throw new Error(`response exceeded ${MAX_MODULE_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  if (total === 0)
    throw new Error("empty response body");
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}
__name(readModuleJson, "readModuleJson");
async function invokeModule(fetcher, request) {
  let res;
  try {
    res = await fetcher.fetch("https://module/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
  } catch (e) {
    return { ok: false, error: `module unreachable: ${e.message}` };
  }
  if (!res.ok)
    return { ok: false, error: `module /invoke -> ${res.status}` };
  let data;
  try {
    data = await readModuleJson(res);
  } catch (e) {
    return { ok: false, error: `module /invoke body rejected: ${e.message}` };
  }
  if (!(data && typeof data === "object" && typeof data.ok === "boolean")) {
    return { ok: false, error: "module returned a malformed InvokeResponse" };
  }
  return data;
}
__name(invokeModule, "invokeModule");
function isPending(r) {
  return r.ok === true && r.pending === true;
}
__name(isPending, "isPending");
async function pollModule(fetcher, request) {
  let res;
  try {
    res = await fetcher.fetch("https://module/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
  } catch (e) {
    return { ok: false, error: `module unreachable: ${e.message}` };
  }
  if (!res.ok)
    return { ok: false, error: `module /poll -> ${res.status}` };
  let data;
  try {
    data = await readModuleJson(res);
  } catch (e) {
    return { ok: false, error: `module /poll body rejected: ${e.message}` };
  }
  if (!(data && typeof data === "object" && typeof data.ok === "boolean")) {
    return { ok: false, error: "module returned a malformed PollResponse" };
  }
  return data;
}
__name(pollModule, "pollModule");
async function cancelModule(fetcher, request) {
  try {
    const res = await fetcher.fetch("https://module/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!res.ok)
      return { ok: false, error: `module /cancel -> ${res.status}` };
    const data = await readModuleJson(res);
    if (data && typeof data === "object" && typeof data.ok === "boolean")
      return data;
    return { ok: false, error: "module returned a malformed CancelResponse" };
  } catch (e) {
    return { ok: false, error: `module unreachable: ${e.message}` };
  }
}
__name(cancelModule, "cancelModule");
async function awaitInvoke(fetcher, request, opts = {}) {
  const r = await invokeModule(fetcher, request);
  if (!r.ok)
    return r;
  if (!isPending(r))
    return { ok: true, output: r.output };
  const pollMs = opts.pollMs ?? 3e3;
  const pollMax = opts.pollMax ?? 40;
  for (let i = 0; i < pollMax; i++) {
    await new Promise((res) => setTimeout(res, pollMs));
    const p = await pollModule(fetcher, { poll: r.poll });
    if (!p.ok)
      return p;
    if (!p.pending)
      return { ok: true, output: p.output };
  }
  return { ok: false, error: "module async job did not finish within the poll window" };
}
__name(awaitInvoke, "awaitInvoke");
async function dispatchChain(env, modules, hook, seed, context, opts) {
  const applied = [];
  const errors = [];
  const degraded = [];
  let current = seed;
  let last = null;
  for (const module of servingForHook(modules, hook)) {
    const fetcher = fetcherFor(env, module);
    if (!fetcher) {
      errors.push(`${module.name}: ${transportLabel(module)} is not reachable`);
      continue;
    }
    const config = validateConfig(module.config_schema, opts.configFor?.(module.name));
    const r = await awaitInvoke(fetcher, { hook, input: current, config, context });
    if (r.ok) {
      last = r.output;
      current = await opts.nextInput(r.output, seed);
      applied.push(module.name);
      const deg = r.output?.degraded;
      if (typeof deg === "string" && deg.length > 0) {
        degraded.push(`${module.name}: ${deg}`);
        console.warn(`chain ${hook}: ${module.name} degraded (${deg})`);
      }
    } else {
      errors.push(`${module.name}: ${r.error}`);
    }
  }
  return { output: last, applied, errors, degraded };
}
__name(dispatchChain, "dispatchChain");

// node_modules/@skyphusion-labs/vivijure-core/dist/modules/conformance.js
var ok = /* @__PURE__ */ __name((name, detail = "ok") => ({ name, pass: true, detail }), "ok");
var bad = /* @__PURE__ */ __name((name, detail) => ({ name, pass: false, detail }), "bad");
var FIELD_TYPES = ["int", "float", "bool", "enum", "string"];
var FIELD_SCOPES = ["render", "install"];
function checkConfigField(key, f) {
  const label = "config." + key;
  if (!f || typeof f !== "object")
    return bad(label, "field is not an object");
  const ff = f;
  const t = ff.type;
  if (typeof t !== "string" || !FIELD_TYPES.includes(t))
    return bad(label, "bad field type " + String(t));
  if (ff.scope !== void 0 && (typeof ff.scope !== "string" || !FIELD_SCOPES.includes(ff.scope))) {
    return bad(label, "bad field scope " + String(ff.scope));
  }
  if (t === "enum") {
    if (!Array.isArray(ff.values) || ff.values.length === 0)
      return bad(label, "enum needs a non-empty values[]");
    if (typeof ff.default !== "string" || !ff.values.includes(ff.default)) {
      return bad(label, "enum default must be one of values");
    }
  } else if (t === "bool") {
    if (typeof ff.default !== "boolean")
      return bad(label, "bool default must be a boolean");
  } else if (t === "string") {
    if (typeof ff.default !== "string")
      return bad(label, "string default must be a string");
  } else {
    if (typeof ff.default !== "number")
      return bad(label, t + " default must be a number");
  }
  return ok(label, String(t));
}
__name(checkConfigField, "checkConfigField");
function checkManifest(raw) {
  const checks = [];
  const m = validateManifest(raw);
  if (typeof m === "string") {
    checks.push(bad("manifest", m));
    return checks;
  }
  checks.push(ok("manifest", m.name + " v" + m.version));
  checks.push(SUPPORTED_MODULE_APIS.has(String(m.api)) ? ok("api-version", String(m.api)) : bad("api-version", String(m.api) + " not in " + [...SUPPORTED_MODULE_APIS].join("/")));
  checks.push(ok("hooks", m.hooks.join(", ")));
  if (m.config_schema) {
    for (const [k, f] of Object.entries(m.config_schema))
      checks.push(checkConfigField(k, f));
  }
  if (m.provides) {
    const good = m.provides.every((p) => p && typeof p.id === "string" && typeof p.label === "string");
    checks.push(good ? ok("provides", String(m.provides.length)) : bad("provides", "each provides[] needs id + label"));
  }
  return checks;
}
__name(checkManifest, "checkManifest");
function checkInvokeResponse(raw) {
  if (!raw || typeof raw !== "object")
    return bad("invoke-response", "not an object");
  const r = raw;
  if (r.ok === true) {
    if ("output" in r)
      return ok("invoke-response", "ok:true + output");
    if (r.pending === true && typeof r.poll === "string")
      return ok("invoke-response", "ok:true + pending + poll");
    return bad("invoke-response", "ok:true but neither output nor pending+poll");
  }
  if (r.ok === false)
    return typeof r.error === "string" ? ok("invoke-response", "ok:false + error") : bad("invoke-response", "ok:false but error is not a string");
  return bad("invoke-response", "missing boolean `ok`");
}
__name(checkInvokeResponse, "checkInvokeResponse");
var isRec = /* @__PURE__ */ __name((v) => !!v && typeof v === "object" && !Array.isArray(v), "isRec");
var isStr = /* @__PURE__ */ __name((v) => typeof v === "string", "isStr");
var isNum = /* @__PURE__ */ __name((v) => typeof v === "number" && Number.isFinite(v), "isNum");
var isStrArr = /* @__PURE__ */ __name((v) => Array.isArray(v) && v.every(isStr), "isStrArr");
var HOOK_OUTPUT_CHECKS = {
  keyframe: /* @__PURE__ */ __name((o) => {
    if (!isStr(o.project))
      return "keyframe output needs a string project";
    if (!Array.isArray(o.keyframes))
      return "keyframe output needs a keyframes[]";
    const bad2 = o.keyframes.find((k) => !isRec(k) || !isStr(k.shot_id) || !isStr(k.keyframe_key));
    if (bad2)
      return "each keyframe needs shot_id + keyframe_key";
    if (o.trained_loras !== void 0) {
      if (!isRec(o.trained_loras))
        return "keyframe output trained_loras must be an object";
      if (Object.values(o.trained_loras).some((v) => !isStr(v))) {
        return "keyframe output trained_loras values must be R2 key strings";
      }
    }
    return null;
  }, "keyframe"),
  "motion.backend": /* @__PURE__ */ __name((o) => {
    if (!isStr(o.shot_id))
      return "motion output needs a string shot_id";
    if (!isStr(o.clip_key))
      return "motion output needs a string clip_key";
    if (!isNum(o.fps))
      return "motion output needs a numeric fps";
    if (!isNum(o.frames))
      return "motion output needs a numeric frames";
    return null;
  }, "motion.backend"),
  finish: /* @__PURE__ */ __name((o) => {
    if (!isStr(o.shot_id))
      return "finish output needs a string shot_id";
    if (!isStr(o.clip_key))
      return "finish output needs a string clip_key";
    if (!isNum(o.out_fps))
      return "finish output needs a numeric out_fps";
    if (!isNum(o.frames))
      return "finish output needs a numeric frames";
    if (!isStrArr(o.applied))
      return "finish output needs an applied string[]";
    return null;
  }, "finish"),
  score: /* @__PURE__ */ __name((o) => {
    if (!isStr(o.film_key))
      return "score output needs a string film_key";
    if (!isStrArr(o.applied))
      return "score output needs an applied string[]";
    if (o.degraded !== void 0 && !isStr(o.degraded))
      return "score degraded, when present, must be a string (the chain degrade reason)";
    return null;
  }, "score"),
  dialogue: /* @__PURE__ */ __name((o) => {
    if (!isStr(o.project))
      return "dialogue output needs a string project";
    if (!Array.isArray(o.audio))
      return "dialogue output needs an audio[]";
    const badEntry = o.audio.find((a) => !isRec(a) || !isStr(a.shot_id) || !isStr(a.audio_key) || !isStr(a.voice_id));
    if (badEntry)
      return "each dialogue audio needs shot_id + audio_key + voice_id";
    if (!isStrArr(o.applied))
      return "dialogue output needs an applied string[]";
    return null;
  }, "dialogue"),
  speech: /* @__PURE__ */ __name((o) => {
    if (!isStr(o.shot_id))
      return "speech output needs a string shot_id";
    if (!isStr(o.audio_key))
      return "speech output needs a string audio_key";
    if (!isStrArr(o.applied))
      return "speech output needs an applied string[]";
    return null;
  }, "speech"),
  "plan.enhance": /* @__PURE__ */ __name((o) => {
    if (!isRec(o.storyboard))
      return "plan.enhance output needs a storyboard object";
    if (!Array.isArray(o.storyboard.scenes)) {
      return "plan.enhance storyboard needs a scenes[]";
    }
    return null;
  }, "plan.enhance"),
  // The image is returned INLINE (bytes, not a storage key) -- see ImageGenerateOutput for why that
  // differs from cast.image on purpose (cf#140). So the check is on the payload, not on a key.
  "image.generate": /* @__PURE__ */ __name((o) => {
    if (!isRec(o.image))
      return "image.generate output needs an image object";
    const img = o.image;
    if (!isStr(img.bytes_b64) || !img.bytes_b64)
      return "image.generate output needs image.bytes_b64";
    if (!isStr(img.mime) || !img.mime)
      return "image.generate output needs an image.mime";
    if (img.bytes_b64.startsWith("data:")) {
      return "image.generate image.bytes_b64 must be raw base64, not a data: URL";
    }
    return null;
  }, "image.generate"),
  "cast.image": /* @__PURE__ */ __name((o) => {
    if (!isNum(o.cast_id))
      return "cast.image output needs a numeric cast_id";
    if (!Array.isArray(o.images))
      return "cast.image output needs an images[]";
    const bad2 = o.images.find((i) => !isRec(i) || !isStr(i.key) || !isStr(i.mime));
    if (bad2)
      return "each cast.image needs key + mime";
    if (!isStrArr(o.applied))
      return "cast.image output needs an applied string[]";
    return null;
  }, "cast.image"),
  notify: /* @__PURE__ */ __name((o) => {
    if (!isStrArr(o.delivered))
      return "notify output needs a delivered string[]";
    return null;
  }, "notify"),
  master: /* @__PURE__ */ __name((o) => {
    if (!isStr(o.audio_key))
      return "master output needs a string audio_key";
    if (!isStrArr(o.applied))
      return "master output needs an applied string[]";
    return null;
  }, "master"),
  "film.finish": /* @__PURE__ */ __name((o) => {
    if (!isStr(o.film_key))
      return "film.finish output needs a string film_key";
    if (o.applied !== void 0 && !isStrArr(o.applied))
      return "film.finish applied, when present, must be a string[]";
    if (o.degraded !== void 0 && !isStr(o.degraded))
      return "film.finish degraded, when present, must be a string (the uncarded reason)";
    if (o.prepend_seconds !== void 0 && (typeof o.prepend_seconds !== "number" || !Number.isFinite(o.prepend_seconds) || o.prepend_seconds < 0))
      return "film.finish prepend_seconds, when present, must be a non-negative finite number";
    return null;
  }, "film.finish")
};
function checkHookOutput(hook, output) {
  const label = "output." + hook;
  const validator = HOOK_OUTPUT_CHECKS[hook];
  if (!validator)
    return bad(label, "unknown hook " + hook);
  if (!isRec(output))
    return bad(label, "output is not an object");
  const reason = validator(output);
  return reason ? bad(label, reason) : ok(label);
}
__name(checkHookOutput, "checkHookOutput");
function hookOutputViolation(moduleId, hook, output) {
  const check = checkHookOutput(hook, output);
  return check.pass ? null : `module ${moduleId} violated ${hook} contract: ${check.detail}`;
}
__name(hookOutputViolation, "hookOutputViolation");
function allPass(checks) {
  return checks.every((c) => c.pass);
}
__name(allPass, "allPass");
function failures(checks) {
  return checks.filter((c) => !c.pass);
}
__name(failures, "failures");
var DEGRADE_PROBE_HOOK = "not.a.real.hook";
async function fetchJson(fetcher, path, init) {
  try {
    const res = await fetcher.fetch("https://module" + path, init);
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      return { status: res.status, body: null, err: `body not JSON: ${e.message}` };
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, err: `unreachable: ${e.message}` };
  }
}
__name(fetchJson, "fetchJson");
async function runLiveConformance(fetcher) {
  const checks = [];
  const man = await fetchJson(fetcher, "/module.json");
  if ("err" in man || man.status !== 200) {
    const why = "err" in man ? man.err : `GET /module.json -> ${man.status}`;
    checks.push(bad("manifest", why));
    return checks;
  }
  const manifestChecks = checkManifest(man.body);
  checks.push(...manifestChecks);
  const manifest = validateManifest(man.body);
  if (typeof manifest === "string")
    return checks;
  const hook = manifest.hooks[0];
  const probe = await fetchJson(fetcher, "/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook,
      // A plan.enhance-shaped input; for other hooks the module simply degrades (ok:false), which is
      // still a conformant envelope. The gate validates the CONTRACT WIRING, not a real render.
      input: { storyboard: { scenes: [{ prompt: "a quiet street at night" }] } },
      config: {},
      context: { project: "conformance", job_id: "install-gate" }
    })
  });
  if ("err" in probe || probe.status !== 200) {
    const why = "err" in probe ? probe.err : `POST /invoke -> ${probe.status}`;
    checks.push(bad("invoke", why));
  } else {
    const env = checkInvokeResponse(probe.body);
    checks.push(env);
    const b = probe.body;
    if (env.pass && b.ok === true && b.pending !== true) {
      checks.push(checkHookOutput(hook, b.output));
    }
  }
  const deg = await fetchJson(fetcher, "/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook: DEGRADE_PROBE_HOOK, input: {}, config: {}, context: { project: "conformance", job_id: "install-gate-degrade" } })
  });
  if ("err" in deg || deg.status !== 200) {
    const why = "err" in deg ? deg.err : `POST /invoke (bad hook) -> ${deg.status}`;
    checks.push(bad("degrade", why));
  } else {
    const shape = checkInvokeResponse(deg.body);
    const okFalse = !!deg.body && typeof deg.body === "object" && deg.body.ok === false;
    checks.push(shape.pass && okFalse ? ok("degrade", "bad hook -> 200 + ok:false") : bad("degrade", "bad hook must return 200 + ok:false"));
  }
  return checks;
}
__name(runLiveConformance, "runLiveConformance");

// src/installed-modules.ts
function rowToInstalled(r) {
  return {
    name: r.name,
    script_name: r.script_name,
    api: r.api,
    installed_at: r.installed_at,
    enabled: r.enabled === 1
  };
}
__name(rowToInstalled, "rowToInstalled");
async function installModuleRow(env, row) {
  await env.DB.prepare(
    `INSERT INTO installed_modules (name, script_name, manifest_json, api, installed_at, enabled)
     VALUES (?1, ?2, ?3, ?4, ?5, 1)
     ON CONFLICT(name) DO UPDATE SET
       script_name = excluded.script_name,
       manifest_json = excluded.manifest_json,
       api = excluded.api,
       installed_at = excluded.installed_at,
       enabled = 1`
  ).bind(row.name, row.script_name, row.manifest_json, row.api, row.installed_at).run();
}
__name(installModuleRow, "installModuleRow");
async function uninstallModuleRow(env, name) {
  const res = await env.DB.prepare(`DELETE FROM installed_modules WHERE name = ?1`).bind(name).run();
  return (res.meta?.changes ?? 0) > 0;
}
__name(uninstallModuleRow, "uninstallModuleRow");
async function setModuleEnabled(env, name, enabled) {
  const res = await env.DB.prepare(`UPDATE installed_modules SET enabled = ?2 WHERE name = ?1`).bind(name, enabled ? 1 : 0).run();
  return (res.meta?.changes ?? 0) > 0;
}
__name(setModuleEnabled, "setModuleEnabled");
async function listInstalledModules(env) {
  const res = await env.DB.prepare(`SELECT name, script_name, manifest_json, api, installed_at, enabled FROM installed_modules ORDER BY name`).all();
  return (res.results ?? []).map(rowToInstalled);
}
__name(listInstalledModules, "listInstalledModules");

// node_modules/@skyphusion-labs/vivijure-core/dist/modules/render-pipeline.js
function normalizeBackendChoice(choice) {
  const trimmed = (choice ?? "").trim();
  return trimmed || void 0;
}
__name(normalizeBackendChoice, "normalizeBackendChoice");
function resolve(m, userConfig) {
  return { name: m.name, binding: m.binding, config: validateConfig(m.config_schema, userConfig) };
}
__name(resolve, "resolve");
function pickOneForHook(modules, hook, choice) {
  const serving = servingForHook(modules, hook);
  const normalizedChoice = normalizeBackendChoice(choice);
  if (normalizedChoice)
    return serving.find((m) => m.name === normalizedChoice) ?? null;
  if (hook === "keyframe") {
    const dedicated = serving.filter((m) => (m.ui?.section ?? "keyframe") === "keyframe");
    if (dedicated.length)
      return dedicated[0] ?? null;
  }
  return serving[0] ?? null;
}
__name(pickOneForHook, "pickOneForHook");
function localKeyframeModule(modules, motionName) {
  const serving = servingForHook(modules, "keyframe");
  const byLocality = serving.find((m) => (m.ui?.locality ?? "cloud") === "local");
  if (byLocality)
    return byLocality;
  if (motionName)
    return serving.find((m) => m.name === motionName);
  return void 0;
}
__name(localKeyframeModule, "localKeyframeModule");
function coupleLocalGpuKeyframeChoice(modules, motionChoice, keyframeChoice) {
  const normalizedMotionChoice = normalizeBackendChoice(motionChoice);
  if (!normalizedMotionChoice)
    return normalizeBackendChoice(keyframeChoice);
  const motion = pickOneForHook(modules, "motion.backend", normalizedMotionChoice);
  if (!motion || (motion.ui?.locality ?? "cloud") !== "local") {
    return normalizeBackendChoice(keyframeChoice);
  }
  const normalizedKeyframeChoice = normalizeBackendChoice(keyframeChoice);
  if (normalizedKeyframeChoice)
    return normalizedKeyframeChoice;
  return localKeyframeModule(modules, motion.name)?.name;
}
__name(coupleLocalGpuKeyframeChoice, "coupleLocalGpuKeyframeChoice");
function resolveRenderPipeline(modules, selection = {}) {
  const cfg = selection.config ?? {};
  const chain = /* @__PURE__ */ __name((hook) => servingForHook(modules, hook).map((m) => resolve(m, cfg[m.name])), "chain");
  const motion = pickOneForHook(modules, "motion.backend", selection.motion_backend_choice);
  const keyframeChoice = coupleLocalGpuKeyframeChoice(modules, selection.motion_backend_choice, selection.keyframe_backend_choice);
  const keyframe = pickOneForHook(modules, "keyframe", keyframeChoice);
  return {
    motion_backend: motion ? resolve(motion, cfg[motion.name]) : null,
    keyframe: keyframe ? resolve(keyframe, cfg[keyframe.name]) : null,
    finish: chain("finish"),
    score: chain("score"),
    speech: chain("speech"),
    filmFinish: chain("film.finish"),
    master: chain("master")
  };
}
__name(resolveRenderPipeline, "resolveRenderPipeline");

// node_modules/@skyphusion-labs/vivijure-core/dist/structured-events.js
function emitStructuredEvent(event) {
  try {
    console.log(JSON.stringify(event));
  } catch {
  }
}
__name(emitStructuredEvent, "emitStructuredEvent");

// node_modules/@skyphusion-labs/vivijure-core/dist/clip-job-model.js
function summarizeJob(job) {
  const total = job.shots.length;
  const done = job.shots.filter((s) => s.status === "done").length;
  const failed = job.shots.filter((s) => s.status === "failed").length;
  return { total, done, failed, pending: total - done - failed, complete: done + failed === total };
}
__name(summarizeJob, "summarizeJob");

// node_modules/@skyphusion-labs/vivijure-core/dist/clip-validate.js
var CLIP_VALIDATE_ENABLED = true;
var CLIP_MIN_BYTES = 2048;
var CLIP_MIN_DURATION_S = 0.15;
var CLIP_MAX_DURATION_S = 900;
var CLIP_MAX_DIMENSION = 16384;
var MOOV_FETCH_CAP = 8 * 1024 * 1024;
var MAX_TOPLEVEL_BOXES = 64;
function u32(b, o) {
  return b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
__name(u32, "u32");
function u64(b, o) {
  return u32(b, o) * 4294967296 + u32(b, o + 4);
}
__name(u64, "u64");
function boxType(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
__name(boxType, "boxType");
function readBoxHeader(b, o) {
  if (o + 8 > b.length)
    return null;
  let size = u32(b, o);
  const type = boxType(b, o + 4);
  let headerSize = 8;
  if (size === 1) {
    if (o + 16 > b.length)
      return null;
    size = u64(b, o + 8);
    headerSize = 16;
  }
  return { type, size, headerSize };
}
__name(readBoxHeader, "readBoxHeader");
var CONTAINER_BOXES = /* @__PURE__ */ new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex"]);
function parseMoov(buf, start = 0, end = buf.length) {
  const info = { durationS: null, hasVideoTrack: false, frames: null, width: null, height: null };
  walk(buf, start, end, info, { inVideoTrak: false });
  return info;
}
__name(parseMoov, "parseMoov");
function walk(buf, start, end, info, ctx) {
  let o = start;
  while (o + 8 <= end) {
    const h = readBoxHeader(buf, o);
    if (!h)
      break;
    const boxEnd = h.size === 0 ? end : o + h.size;
    if (h.size !== 0 && (h.size < h.headerSize || boxEnd > end))
      break;
    const payloadStart = o + h.headerSize;
    if (h.type === "trak") {
      const tctx = { inVideoTrak: false };
      walk(buf, payloadStart, boxEnd, info, tctx);
      if (tctx.inVideoTrak) {
        info.hasVideoTrack = true;
        if (tctx.trakWidth != null && info.width == null)
          info.width = tctx.trakWidth;
        if (tctx.trakHeight != null && info.height == null)
          info.height = tctx.trakHeight;
      }
    } else if (CONTAINER_BOXES.has(h.type)) {
      walk(buf, payloadStart, boxEnd, info, ctx);
    } else if (h.type === "mvhd") {
      readMvhd(buf, payloadStart, boxEnd, info);
    } else if (h.type === "tkhd") {
      readTkhd(buf, payloadStart, boxEnd, ctx);
    } else if (h.type === "hdlr") {
      if (payloadStart + 12 <= boxEnd && boxType(buf, payloadStart + 8) === "vide")
        ctx.inVideoTrak = true;
    } else if (h.type === "stsz") {
      if (payloadStart + 12 <= boxEnd && ctx.inVideoTrak) {
        const count = u32(buf, payloadStart + 8);
        info.frames = (info.frames ?? 0) + count;
      }
    }
    if (h.size === 0)
      break;
    o = boxEnd;
  }
}
__name(walk, "walk");
function readMvhd(buf, payloadStart, end, info) {
  if (payloadStart + 4 > end)
    return;
  const version = buf[payloadStart];
  let ts, dur;
  if (version === 1) {
    if (payloadStart + 28 > end)
      return;
    ts = u32(buf, payloadStart + 20);
    dur = u64(buf, payloadStart + 24);
  } else {
    if (payloadStart + 20 > end)
      return;
    ts = u32(buf, payloadStart + 12);
    dur = u32(buf, payloadStart + 16);
  }
  if (ts > 0)
    info.durationS = dur / ts;
}
__name(readMvhd, "readMvhd");
function readTkhd(buf, payloadStart, end, ctx) {
  if (payloadStart + 4 > end)
    return;
  const version = buf[payloadStart];
  const base = version === 1 ? payloadStart + 36 : payloadStart + 24;
  const wOff = base + 8 + 2 + 2 + 2 + 2 + 36;
  if (wOff + 8 > end)
    return;
  ctx.trakWidth = u32(buf, wOff) >>> 16;
  ctx.trakHeight = u32(buf, wOff + 4) >>> 16;
}
__name(readTkhd, "readTkhd");
function judgeClip(checks) {
  if (checks.bytes < CLIP_MIN_BYTES) {
    return { verdict: "fail", reason: `clip is ${checks.bytes} bytes (< ${CLIP_MIN_BYTES} floor); truncated or empty`, checks };
  }
  if (!checks.container) {
    return { verdict: "fail", reason: "not a valid mp4 (no ftyp/moov box tree); corrupt or wrong format", checks };
  }
  if (checks.duration_s != null && (checks.duration_s < CLIP_MIN_DURATION_S || checks.duration_s > CLIP_MAX_DURATION_S)) {
    return { verdict: "fail", reason: `clip duration ${checks.duration_s.toFixed(3)}s is out of sane bounds [${CLIP_MIN_DURATION_S}, ${CLIP_MAX_DURATION_S}]s`, checks };
  }
  if (!checks.video_track) {
    return { verdict: "fail", reason: "no video track in the clip (audio-only or corrupt container)", checks };
  }
  if (checks.frames != null && checks.frames <= 0) {
    return { verdict: "fail", reason: "video track has zero frames (empty/corrupt clip)", checks };
  }
  if (checks.width != null && checks.height != null && (checks.width <= 0 || checks.height <= 0 || checks.width > CLIP_MAX_DIMENSION || checks.height > CLIP_MAX_DIMENSION)) {
    return { verdict: "fail", reason: `video dimensions ${checks.width}x${checks.height} are out of sane bounds`, checks };
  }
  return { verdict: "pass", checks };
}
__name(judgeClip, "judgeClip");
async function locateStructure(read, totalBytes) {
  let ftypOk = false;
  let offset = 0;
  for (let i = 0; i < MAX_TOPLEVEL_BOXES && offset + 8 <= totalBytes; i++) {
    const hdrBytes = await read(offset, 16);
    if (!hdrBytes || hdrBytes.length < 8)
      break;
    const h = readBoxHeader(hdrBytes, 0);
    if (!h)
      break;
    if (i === 0) {
      if (h.type !== "ftyp")
        break;
      ftypOk = true;
    }
    if (h.type === "moov")
      return { ftypOk, moov: { offset, size: h.size, headerSize: h.headerSize } };
    if (h.size === 0)
      break;
    offset += h.size;
  }
  return { ftypOk };
}
__name(locateStructure, "locateStructure");
async function validateClipArtifact(env, key, expectedSeconds) {
  const empty = { container: false, video_track: false, duration_s: null, expected_s: expectedSeconds, frames: null, width: null, height: null, bytes: 0 };
  if (!CLIP_VALIDATE_ENABLED)
    return { verdict: "skip", reason: "clip validation disabled", checks: empty };
  try {
    const head = await env.R2_RENDERS.head(key);
    if (!head)
      return { verdict: "skip", reason: "clip artifact not found in R2", checks: empty };
    const totalBytes = head.size;
    const checks = { ...empty, bytes: totalBytes };
    const read = /* @__PURE__ */ __name(async (offset, length) => {
      const obj = await env.R2_RENDERS.get(key, { range: { offset, length } });
      if (!obj)
        return null;
      return new Uint8Array(await obj.arrayBuffer());
    }, "read");
    const loc = await locateStructure(read, totalBytes);
    if (loc.ftypOk && loc.moov) {
      checks.container = true;
      const payloadOffset = loc.moov.offset + loc.moov.headerSize;
      const payloadLen = loc.moov.size - loc.moov.headerSize;
      if (payloadLen > 0 && payloadLen <= MOOV_FETCH_CAP) {
        const moovBytes = await read(payloadOffset, payloadLen);
        if (moovBytes && moovBytes.length) {
          const info = parseMoov(moovBytes);
          checks.duration_s = info.durationS;
          checks.video_track = info.hasVideoTrack;
          checks.frames = info.frames;
          checks.width = info.width;
          checks.height = info.height;
        }
      } else if (payloadLen > MOOV_FETCH_CAP) {
        checks.video_track = true;
      }
    }
    return judgeClip(checks);
  } catch (e) {
    return { verdict: "skip", reason: `clip validation errored: ${e instanceof Error ? e.message : String(e)}`, checks: empty };
  }
}
__name(validateClipArtifact, "validateClipArtifact");

// node_modules/@skyphusion-labs/vivijure-core/dist/finish-hash.js
function normalizeEtag(etag) {
  if (etag == null)
    return null;
  let e = etag.trim();
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"'))
    e = e.slice(1, -1);
  return e;
}
__name(normalizeEtag, "normalizeEtag");
function canonicalJson(o) {
  if (o === true)
    return "true";
  if (o === false)
    return "false";
  if (o === null || o === void 0)
    return "null";
  const t = typeof o;
  if (t === "string")
    return JSON.stringify(o);
  if (t === "number") {
    if (!Number.isFinite(o))
      throw new Error("finish-hash: non-finite number in config");
    return String(o);
  }
  if (Array.isArray(o))
    return "[" + o.map(canonicalJson).join(",") + "]";
  if (t === "object") {
    const rec = o;
    return "{" + Object.keys(rec).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(rec[k])).join(",") + "}";
  }
  throw new Error(`finish-hash: unserializable type ${t}`);
}
__name(canonicalJson, "canonicalJson");
async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
async function finishStepInputHash(clipEtag, audioEtag, config) {
  const payload = {
    clip_etag: normalizeEtag(clipEtag),
    audio_etag: normalizeEtag(audioEtag),
    config: config ?? {}
  };
  return sha256Hex(canonicalJson(payload));
}
__name(finishStepInputHash, "finishStepInputHash");

// node_modules/@skyphusion-labs/vivijure-core/dist/clip-provenance.js
function provKey(artifactKey) {
  return `${artifactKey}.prov`;
}
__name(provKey, "provKey");
async function sha256Hex2(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex2, "sha256Hex");
async function headEtag(env, key) {
  if (!key)
    return null;
  try {
    const e = (await env.R2_RENDERS.head(key))?.etag ?? null;
    if (e == null)
      return null;
    const t = e.trim();
    return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  } catch {
    return null;
  }
}
__name(headEtag, "headEtag");
async function clipProvenanceHash(input) {
  const payload = {
    motion_backend: input.motion_backend ?? null,
    config: input.config ?? {},
    keyframe_etag: input.keyframe_etag,
    prompt: input.prompt,
    seconds: input.seconds
  };
  return sha256Hex2(canonicalJson(payload));
}
__name(clipProvenanceHash, "clipProvenanceHash");
async function keyframeProvenanceHash(input) {
  return sha256Hex2(canonicalJson({ keyframe_config: input.keyframe_config ?? {} }));
}
__name(keyframeProvenanceHash, "keyframeProvenanceHash");
async function readProv(env, artifactKey) {
  try {
    const sc = await env.R2_RENDERS.get(provKey(artifactKey));
    if (!sc)
      return null;
    return (await sc.text()).trim();
  } catch {
    return null;
  }
}
__name(readProv, "readProv");
async function provVerdict(env, artifactKey, expected) {
  const prov = await readProv(env, artifactKey);
  if (prov === null)
    return "absent";
  return prov === expected ? "match" : "mismatch";
}
__name(provVerdict, "provVerdict");
async function writeProv(env, artifactKey, hash) {
  try {
    await env.R2_RENDERS.put(provKey(artifactKey), hash, { httpMetadata: { contentType: "text/plain" } });
  } catch (e) {
    console.warn(`clip-provenance: failed to stamp ${provKey(artifactKey)}: ${e.message}`);
  }
}
__name(writeProv, "writeProv");
async function chooseProvenanceMatch(env, expected, candidateKeys) {
  const unstamped = [];
  for (const key of candidateKeys) {
    const verdict = await provVerdict(env, key, expected);
    if (verdict === "absent") {
      unstamped.push(key);
      continue;
    }
    if (verdict === "match")
      return { key, stampNeeded: false };
  }
  if (unstamped.length === 1)
    return { key: unstamped[0], stampNeeded: true };
  return null;
}
__name(chooseProvenanceMatch, "chooseProvenanceMatch");

// node_modules/@skyphusion-labs/vivijure-core/dist/presign.js
var FILM_DOWNLOAD_TTL_SECONDS = 3600;
function isPresignSafeKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024)
    return false;
  if (key.startsWith("/"))
    return false;
  if (key.includes("://"))
    return false;
  if (/[^ -~]/.test(key))
    return false;
  return !key.split("/").includes("..");
}
__name(isPresignSafeKey, "isPresignSafeKey");
async function presignR2Get(env, key, expiresSec = 300) {
  if (!isPresignSafeKey(key))
    throw new Error("R2 presign: refusing to sign an unsafe object key");
  return env.PRESIGNER.presignGet(key, expiresSec);
}
__name(presignR2Get, "presignR2Get");
async function presignR2Put(env, key, expiresSec = 300, contentType = "application/octet-stream") {
  if (!isPresignSafeKey(key))
    throw new Error("R2 presign: refusing to sign an unsafe object key");
  return env.PRESIGNER.presignPut(key, contentType, expiresSec);
}
__name(presignR2Put, "presignR2Put");

// node_modules/@skyphusion-labs/vivijure-core/dist/stage-clip-keyframe.js
var BUCKET_KEYFRAME_MOTION_BACKENDS = /* @__PURE__ */ new Set(["own-gpu", "local-gpu"]);
var RENDERS_KEYFRAME_RE = /^renders\/[^/]+\/keyframes\/[^/]+\.(png|jpe?g)$/i;
function canonicalClipKeyframeKey(project, shotId) {
  const safeProject = project.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "project";
  const safeShot = shotId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "shot";
  return `renders/${safeProject}/keyframes/${safeShot}.png`;
}
__name(canonicalClipKeyframeKey, "canonicalClipKeyframeKey");
function isRendersKeyframeKey(key) {
  return typeof key === "string" && RENDERS_KEYFRAME_RE.test(key);
}
__name(isRendersKeyframeKey, "isRendersKeyframeKey");
async function loadKeyframeBytes(env, shot) {
  if (shot.keyframe_key) {
    const obj = await env.R2_RENDERS.get(shot.keyframe_key);
    if (obj) {
      const head = await env.R2_RENDERS.head(shot.keyframe_key);
      return {
        bytes: await obj.arrayBuffer(),
        contentType: head?.httpMetadata?.contentType ?? "image/png"
      };
    }
  }
  if (shot.keyframe_url) {
    const r = await fetch(shot.keyframe_url, { signal: AbortSignal.timeout(12e4) });
    if (r.ok) {
      return {
        bytes: await r.arrayBuffer(),
        contentType: r.headers.get("content-type") ?? "image/png"
      };
    }
  }
  return null;
}
__name(loadKeyframeBytes, "loadKeyframeBytes");
async function ensureClipKeyframeInR2(env, project, shot) {
  const canonical = canonicalClipKeyframeKey(project, shot.shot_id);
  if (shot.keyframe_key && isRendersKeyframeKey(shot.keyframe_key)) {
    const key = shot.keyframe_key;
    const existing = await env.R2_RENDERS.head(key);
    if (existing) {
      const keyframe_url2 = shot.keyframe_url || await presignR2Get(env, key, 1800);
      return { ...shot, keyframe_key: key, keyframe_url: keyframe_url2 };
    }
  }
  const loaded = await loadKeyframeBytes(env, shot);
  if (!loaded) {
    throw new Error(`keyframe missing for ${shot.shot_id}: need keyframe_key under renders/ or a fetchable keyframe_url`);
  }
  await env.R2_RENDERS.put(canonical, loaded.bytes, {
    httpMetadata: { contentType: loaded.contentType.includes("image/") ? loaded.contentType : "image/png" }
  });
  const keyframe_url = await presignR2Get(env, canonical, 1800);
  return { ...shot, keyframe_key: canonical, keyframe_url };
}
__name(ensureClipKeyframeInR2, "ensureClipKeyframeInR2");

// node_modules/@skyphusion-labs/vivijure-core/dist/render-orchestrator.js
var jobKey = /* @__PURE__ */ __name((jobId) => `renders/${jobId}/clips-job.json`, "jobKey");
function describeClipFailures(job) {
  const failed = job.shots.filter((s) => s.status === "failed");
  if (!failed.length)
    return "";
  return failed.map((s) => `${s.shot_id}: ${s.error || "unknown error"}`).join("; ");
}
__name(describeClipFailures, "describeClipFailures");
function classifyTransientFailure(error) {
  const e = error ?? "";
  const m = e.match(/->\s*(\d{3})\b/);
  if (m) {
    const s = Number(m[1]);
    return s === 408 || s === 429 || s >= 500 && s <= 599 ? "transient" : "deterministic";
  }
  if (/unreachable|timed? ?out|timeout|network|econnreset|connection (reset|lost)|fetch failed/i.test(e)) {
    return "transient";
  }
  return "deterministic";
}
__name(classifyTransientFailure, "classifyTransientFailure");
var CLIP_POLL_MAX_ATTEMPTS = 3;
function applyPoll(shot, r) {
  if (!r.ok) {
    if (classifyTransientFailure(r.error) === "transient") {
      const attempts = (shot.poll_attempts ?? 0) + 1;
      if (attempts < CLIP_POLL_MAX_ATTEMPTS) {
        shot.poll_attempts = attempts;
        return;
      }
      shot.status = "failed";
      shot.error = `${r.error} (persisted through ${attempts} consecutive polls, #719)`;
      return;
    }
    shot.status = "failed";
    shot.error = r.error;
    return;
  }
  if (r.pending) {
    if (shot.poll_attempts)
      shot.poll_attempts = 0;
    return;
  }
  const output = r.output;
  const violation = hookOutputViolation(shot.motion_backend ?? "motion.backend", "motion.backend", output);
  if (violation) {
    shot.status = "failed";
    shot.error = violation;
    return;
  }
  shot.status = "done";
  shot.clip_key = output.clip_key;
  if (typeof output.fps === "number" && output.fps > 0 && typeof output.frames === "number" && output.frames > 0) {
    shot.delivered_fps = output.fps;
    shot.delivered_frames = output.frames;
  }
  if (typeof output.distilled === "boolean")
    shot.distilled = output.distilled;
}
__name(applyPoll, "applyPoll");
function clipFileMatchesShot(file, shotId) {
  if (!file.startsWith(shotId))
    return false;
  const rest = file.slice(shotId.length);
  if (rest.length === 0)
    return false;
  if (/^\d/.test(rest))
    return false;
  if (/(^|[._-])finished([._-]|$)/i.test(rest))
    return false;
  return /\.(mp4|mov|webm|mkv)$/i.test(file);
}
__name(clipFileMatchesShot, "clipFileMatchesShot");
function finishedClipFileMatchesShot(file, shotId) {
  if (!file.startsWith(shotId))
    return false;
  const rest = file.slice(shotId.length);
  if (/^\d/.test(rest))
    return false;
  if (!/(^|[._-])finished([._-]|$)/i.test(rest))
    return false;
  return /\.(mp4|mov|webm|mkv)$/i.test(file);
}
__name(finishedClipFileMatchesShot, "finishedClipFileMatchesShot");
async function listClipsByShotId(env, project, shotIds, matches = clipFileMatchesShot, minUploadedMs = 0) {
  const prefix = `renders/${project}/clips/`;
  const found = /* @__PURE__ */ new Map();
  let cursor;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1e3 });
    for (const o of listed.objects) {
      if (minUploadedMs && (!o.uploaded || o.uploaded.getTime() < minUploadedMs))
        continue;
      const file = o.key.slice(prefix.length);
      for (const shotId of shotIds) {
        if (!found.has(shotId) && matches(file, shotId))
          found.set(shotId, o.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : void 0;
  } while (cursor);
  return found;
}
__name(listClipsByShotId, "listClipsByShotId");
async function listAllClipsByShotId(env, project, shotIds, minUploadedMs = 0) {
  const prefix = `renders/${project}/clips/`;
  const found = /* @__PURE__ */ new Map();
  let cursor;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1e3 });
    for (const o of listed.objects) {
      if (minUploadedMs && (!o.uploaded || o.uploaded.getTime() < minUploadedMs))
        continue;
      const file = o.key.slice(prefix.length);
      for (const shotId of shotIds) {
        if (clipFileMatchesShot(file, shotId)) {
          const arr = found.get(shotId) ?? [];
          arr.push(o.key);
          found.set(shotId, arr);
        }
      }
    }
    cursor = listed.truncated ? listed.cursor : void 0;
  } while (cursor);
  return found;
}
__name(listAllClipsByShotId, "listAllClipsByShotId");
async function stampClipProvenance(env, project, shot) {
  if (!shot.clip_key)
    return;
  const hash = await clipProvenanceHash({
    motion_backend: shot.motion_backend,
    config: shot.config,
    keyframe_etag: await headEtag(env, shot.keyframe_key),
    prompt: shot.prompt,
    seconds: shot.seconds
  });
  await writeProv(env, shot.clip_key, hash);
}
__name(stampClipProvenance, "stampClipProvenance");
async function startClipJob(env, args, preModules) {
  const envRec = env;
  const modules = preModules ?? await discoverModules(envRec);
  const serving = servingForHook(modules, "motion.backend");
  const defaultMb = args.motion_backend ? serving.find((m) => m.name === args.motion_backend) ?? null : serving[0] ?? null;
  const moduleConfigs = args.module_configs ?? {};
  const defaultConfig = defaultMb ? validateConfig(defaultMb.config_schema, args.config ?? moduleConfigs[defaultMb.name]) : {};
  const job_id = "clips-" + crypto.randomUUID();
  const shots = [];
  for (const sh of args.shots) {
    const shot = { ...sh, status: "pending" };
    const mbName = sh.motion_backend ?? args.motion_backend ?? defaultMb?.name;
    const mb = mbName ? serving.find((m) => m.name === mbName) ?? null : defaultMb;
    const binding = mb ? mb.binding : null;
    shot.binding = binding;
    shot.motion_backend = mb?.name ?? void 0;
    const fetcher = binding ? resolveFetcher(envRec, binding) : null;
    const config = mb ? validateConfig(mb.config_schema, moduleConfigs[mb.name] ?? (mb.name === defaultMb?.name ? args.config : void 0) ?? args.config) : defaultConfig;
    shot.config = config;
    if (!mb || !fetcher) {
      shot.status = "failed";
      shot.error = mb ? `module ${mb.name} (${binding}) is not bound` : "no motion.backend module installed";
      shots.push(shot);
      continue;
    }
    let motionInput = sh;
    if (mb.name && BUCKET_KEYFRAME_MOTION_BACKENDS.has(mb.name)) {
      try {
        motionInput = await ensureClipKeyframeInR2(env, args.project, sh);
        shot.keyframe_key = motionInput.keyframe_key;
        shot.keyframe_url = motionInput.keyframe_url;
      } catch (e) {
        shot.status = "failed";
        shot.error = e instanceof Error ? e.message : String(e);
        shots.push(shot);
        continue;
      }
    }
    const r = await invokeModule(fetcher, {
      hook: "motion.backend",
      input: {
        shot_id: motionInput.shot_id,
        keyframe_url: motionInput.keyframe_url,
        keyframe_key: motionInput.keyframe_key,
        prompt: motionInput.prompt,
        seconds: motionInput.seconds
      },
      config,
      context: { project: args.project, job_id }
    });
    if (!r.ok) {
      shot.status = "failed";
      shot.error = r.error;
    } else if (r.pending) {
      shot.poll = r.poll;
      shot.runpod_job_id = r.jobId;
    } else if ("output" in r) {
      const output = r.output;
      const violation = hookOutputViolation(mb.name, "motion.backend", output);
      if (violation) {
        shot.status = "failed";
        shot.error = violation;
      } else {
        shot.status = "done";
        shot.clip_key = output.clip_key;
        await stampClipProvenance(env, args.project, shot);
      }
    } else {
      shot.status = "failed";
      shot.error = "module returned neither output nor a poll token";
    }
    shots.push(shot);
  }
  const job = {
    job_id,
    project: args.project,
    motion_backend: defaultMb ? defaultMb.name : null,
    binding: defaultMb ? defaultMb.binding : null,
    module_configs: Object.keys(moduleConfigs).length ? moduleConfigs : void 0,
    shots,
    created_at: Date.now()
  };
  await env.R2_RENDERS.put(jobKey(job_id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}
__name(startClipJob, "startClipJob");
async function advanceClipJob(env, jobId, preModules) {
  const obj = await env.R2_RENDERS.get(jobKey(jobId));
  if (!obj)
    return null;
  const job = JSON.parse(await obj.text());
  const envRec = env;
  const polled = [];
  for (const shot of job.shots) {
    if (shot.status !== "pending" || !shot.poll)
      continue;
    const binding = shot.binding ?? job.binding;
    const fetcher = binding ? resolveFetcher(envRec, binding) : null;
    if (!fetcher) {
      shot.status = "failed";
      shot.error = "module binding no longer bound";
      continue;
    }
    const p = await pollModule(fetcher, { poll: shot.poll });
    applyPoll(shot, p);
    polled.push(shot);
  }
  for (const shot of polled) {
    if (shot.status === "done" && shot.clip_key)
      await stampClipProvenance(env, job.project, shot);
  }
  await reclaimClipsFromR2(env, job);
  await cancelFailedShots(env, job, preModules);
  await validateDoneClips(env, job);
  await env.R2_RENDERS.put(jobKey(jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
  return job;
}
__name(advanceClipJob, "advanceClipJob");
async function cancelFailedShots(env, job, preModules) {
  const orphans = job.shots.filter((s) => s.status === "failed" && s.poll && !s.cancel_sent);
  if (!orphans.length)
    return;
  const envRec = env;
  const modules = preModules ?? await discoverModules(envRec);
  for (const shot of orphans)
    await cancelShotRemote(envRec, job, shot, modules);
}
__name(cancelFailedShots, "cancelFailedShots");
async function cancelShotRemote(envRec, job, shot, modules) {
  const jobId = shot.runpod_job_id ?? "(job id unknown)";
  const binding = shot.binding ?? job.binding;
  const mb = binding ? modules.find((m) => m.binding === binding) ?? null : null;
  const fetcher = binding ? resolveFetcher(envRec, binding) : null;
  shot.cancel_sent = true;
  if (!mb || !fetcher) {
    console.warn(`clip job ${job.job_id}: cannot cancel failed shot ${shot.shot_id} -- module ${binding ?? "?"} not bound; RunPod job ${jobId} left running (ORPHAN) (#536)`);
    return;
  }
  if (!mb.cancelable) {
    console.warn(`clip job ${job.job_id}: motion module ${mb.name} has no cancel primitive (cancelable=false); RunPod job ${jobId} for shot ${shot.shot_id} left running (ORPHAN) (#536)`);
    return;
  }
  const r = await cancelModule(fetcher, { poll: shot.poll });
  if (r.ok)
    console.warn(`clip job ${job.job_id}: cancelled in-flight RunPod job ${jobId} for failed shot ${shot.shot_id} via ${mb.name} (#536)`);
  else
    console.warn(`clip job ${job.job_id}: cancel FAILED (${r.error}) for shot ${shot.shot_id} -- RunPod job ${jobId} left running (ORPHAN) (#536)`);
}
__name(cancelShotRemote, "cancelShotRemote");
async function cancelInFlightClips(env, jobId, preModules) {
  const obj = await env.R2_RENDERS.get(jobKey(jobId));
  if (!obj)
    return;
  const job = JSON.parse(await obj.text());
  const inflight = job.shots.filter((s) => s.status === "pending" && s.poll && !s.cancel_sent);
  if (!inflight.length)
    return;
  const envRec = env;
  const modules = preModules ?? await discoverModules(envRec);
  for (const shot of inflight)
    await cancelShotRemote(envRec, job, shot, modules);
  await env.R2_RENDERS.put(jobKey(jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
}
__name(cancelInFlightClips, "cancelInFlightClips");
async function reclaimClipsFromR2(env, job) {
  const notDone = job.shots.filter((s) => s.status !== "done" && s.validated !== "fail");
  if (!notDone.length)
    return 0;
  const candidates = await listAllClipsByShotId(env, job.project, notDone.map((s) => s.shot_id), job.created_at);
  let adopted = 0;
  for (const shot of notDone) {
    const keys = candidates.get(shot.shot_id);
    if (!keys || !keys.length)
      continue;
    const expected = await clipProvenanceHash({
      motion_backend: shot.motion_backend,
      config: shot.config,
      keyframe_etag: await headEtag(env, shot.keyframe_key),
      prompt: shot.prompt,
      seconds: shot.seconds
    });
    const chosen = await chooseProvenanceMatch(env, expected, keys);
    if (!chosen)
      continue;
    shot.status = "done";
    shot.clip_key = chosen.key;
    shot.poll = void 0;
    shot.error = void 0;
    shot.validated = void 0;
    if (chosen.stampNeeded)
      await stampClipProvenance(env, job.project, shot);
    adopted += 1;
  }
  return adopted;
}
__name(reclaimClipsFromR2, "reclaimClipsFromR2");
async function validateDoneClips(env, job) {
  let changed = false;
  for (const shot of job.shots) {
    if (shot.status !== "done" || !shot.clip_key || shot.validated)
      continue;
    const res = await validateClipArtifact(env, shot.clip_key, shot.seconds);
    shot.validated = res.verdict;
    emitStructuredEvent({
      ev: "clip.validate",
      job_id: job.job_id,
      shot_id: shot.shot_id,
      verdict: res.verdict,
      checks: res.checks,
      ...res.reason ? { reason: res.reason } : {}
    });
    if (res.verdict === "fail") {
      shot.status = "failed";
      shot.error = `clip failed output validation: ${res.reason}`;
      shot.poll = void 0;
      changed = true;
    }
  }
  return changed;
}
__name(validateDoneClips, "validateDoneClips");

// node_modules/@skyphusion-labs/vivijure-core/dist/storyboard-ids.js
var SHOT_ID_RE = /^shot_\d+$/;
function coerceShotId(rawId, index) {
  const desired = `shot_${String(index + 1).padStart(2, "0")}`;
  if (typeof rawId !== "string")
    return desired;
  const trimmed = rawId.trim();
  if (trimmed.length === 0)
    return desired;
  return SHOT_ID_RE.test(trimmed) ? trimmed : desired;
}
__name(coerceShotId, "coerceShotId");

// node_modules/@skyphusion-labs/vivijure-core/dist/film-model.js
var filmKey = /* @__PURE__ */ __name((id) => `renders/${id}/film-job.json`, "filmKey");
var clipDocKey = /* @__PURE__ */ __name((clipJobId) => `renders/${clipJobId}/clips-job.json`, "clipDocKey");
function filmPhaseToShardStatus(job) {
  if (job.cancelled)
    return "CANCELLED";
  if (job.phase === "done")
    return "COMPLETED";
  if (job.phase === "failed")
    return "FAILED";
  return "IN_PROGRESS";
}
__name(filmPhaseToShardStatus, "filmPhaseToShardStatus");
function joinKeyframesToScenes(scenes, keyframes) {
  const byShot = new Map(keyframes.map((k) => [k.shot_id, k.keyframe_key]));
  const matched = [];
  const missing = [];
  for (const sc of scenes) {
    const key = byShot.get(sc.shot_id);
    if (key)
      matched.push({ shot_id: sc.shot_id, keyframe_key: key, prompt: sc.prompt, seconds: sc.seconds });
    else
      missing.push(sc.shot_id);
  }
  return { matched, missing };
}
__name(joinKeyframesToScenes, "joinKeyframesToScenes");
function clipDeliveries(clipJob) {
  if (!clipJob)
    return void 0;
  const out = [];
  for (const s of clipJob.shots) {
    if (s.status !== "done" || !s.delivered_fps || !s.delivered_frames)
      continue;
    const entry = {
      shot_id: s.shot_id,
      planned_seconds: s.seconds,
      delivered_seconds: Math.round(s.delivered_frames / s.delivered_fps * 1e3) / 1e3,
      fps: s.delivered_fps,
      frames: s.delivered_frames
    };
    if (typeof s.distilled === "boolean")
      entry.distilled = s.distilled;
    out.push(entry);
  }
  return out.length ? out : void 0;
}
__name(clipDeliveries, "clipDeliveries");
function summarizeFinish(shots) {
  return {
    total: shots.length,
    done: shots.filter((s) => s.status === "done").length,
    failed: shots.filter((s) => s.status === "failed").length,
    pending: shots.filter((s) => s.status === "pending").length,
    adopted: shots.filter((s) => (s.adopted?.length ?? 0) > 0).length
    // #583: shots with >=1 finish step reused from R2
  };
}
__name(summarizeFinish, "summarizeFinish");
function summarizeFilm(job, clipJob) {
  return {
    film_id: job.film_id,
    phase: job.phase,
    error: job.error,
    clips: clipJob ? summarizeJob(clipJob) : void 0,
    clip_deliveries: clipDeliveries(clipJob),
    finish: job.finish_shots ? summarizeFinish(job.finish_shots) : void 0,
    film_key: job.film_key,
    film_finish: job.film_finish,
    finish_unavailable: job.finish_unavailable,
    keyframes_incomplete: job.keyframes_incomplete
  };
}
__name(summarizeFilm, "summarizeFilm");
function orderFinalClips(scenes, shots) {
  const byShot = new Map(shots.map((s) => [s.shot_id, s.clip_key]));
  const out = [];
  for (const sc of scenes) {
    const clip_key = byShot.get(sc.shot_id);
    if (clip_key)
      out.push({ shot_id: sc.shot_id, clip_key });
  }
  return out;
}
__name(orderFinalClips, "orderFinalClips");
function applyFinishOutput(fs, out) {
  fs.clip_key = out.clip_key;
  const tags = out.applied || [];
  fs.applied.push(...tags);
  (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [...tags], reused: false });
  fs.idx += 1;
  fs.poll = void 0;
  fs.attempts = 0;
  if (fs.idx >= fs.chain.length)
    fs.status = "done";
}
__name(applyFinishOutput, "applyFinishOutput");
function adoptFinishStepOutput(fs, clip_key, tag) {
  fs.clip_key = clip_key;
  (fs.adopted ??= []).push(tag);
  (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [tag], reused: true });
  fs.idx += 1;
  fs.poll = void 0;
  fs.attempts = 0;
  if (fs.idx >= fs.chain.length)
    fs.status = "done";
}
__name(adoptFinishStepOutput, "adoptFinishStepOutput");
function applySpeechOutput(ss, out) {
  if (!out.degraded)
    ss.audio_key = out.audio_key;
  ss.applied.push(...out.applied || []);
  if (out.degraded)
    ss.degraded = out.degraded;
  ss.idx += 1;
  ss.poll = void 0;
  ss.attempts = 0;
  if (ss.idx >= ss.chain.length)
    ss.status = "done";
}
__name(applySpeechOutput, "applySpeechOutput");
var FINISH_STEP_MAX_ATTEMPTS = 3;
function classifyFinishFailure(error) {
  return classifyTransientFailure(error);
}
__name(classifyFinishFailure, "classifyFinishFailure");
function classifyFinishRetry(error, priorAttempts, maxAttempts = FINISH_STEP_MAX_ATTEMPTS) {
  if (classifyFinishFailure(error) !== "transient")
    return { action: "fail" };
  const attempts = (priorAttempts ?? 0) + 1;
  return attempts < maxAttempts ? { action: "retry", attempts } : { action: "fail" };
}
__name(classifyFinishRetry, "classifyFinishRetry");
function resolveFinishConfigs(serving, finishConfig) {
  return serving.map((m) => validateConfig(m.config_schema, finishConfig?.[m.name]));
}
__name(resolveFinishConfigs, "resolveFinishConfigs");
function finishShotAdoptableFromR2(fs) {
  if (fs.idx !== fs.chain.length - 1)
    return false;
  if (fs.status === "failed")
    return true;
  return fs.status === "pending" && !!fs.poll;
}
__name(finishShotAdoptableFromR2, "finishShotAdoptableFromR2");
function reclaimFinishShotsFromR2(finishShots, present, modules) {
  let adopted = 0;
  for (const fs of finishShots) {
    if (finishShotAdoptableFromR2(fs) && present.has(fs.shot_id)) {
      fs.clip_key = present.get(fs.shot_id);
      fs.status = "done";
      fs.poll = void 0;
      fs.error = void 0;
      const tag = finishStepAppliedTag(fs, modules);
      (fs.adopted ??= []).push(tag);
      (fs.ledger ??= []).push({ binding: fs.chain[fs.idx] ?? "", tags: [tag], reused: true });
      adopted += 1;
    }
  }
  return adopted;
}
__name(reclaimFinishShotsFromR2, "reclaimFinishShotsFromR2");
function finishShotLedgerReconciles(fs) {
  if (fs.status !== "done" || !fs.ledger)
    return true;
  return fs.ledger.length === fs.chain.length && fs.ledger.every((r, i) => r.binding === fs.chain[i]);
}
__name(finishShotLedgerReconciles, "finishShotLedgerReconciles");
function finishStepOutputKey(project, fs, modules) {
  const binding = fs.chain[fs.idx] ?? "";
  const decl = moduleByBinding(modules, binding)?.finish_artifacts;
  if (decl) {
    if (decl.output_key.kind === "shot_named")
      return `renders/${project}/clips/${fs.shot_id}${decl.output_key.filename}`;
    return insertKeySuffix(fs.clip_key, decl.output_key.suffix);
  }
  if (/RIFE/i.test(binding))
    return `renders/${project}/clips/${fs.shot_id}_finished.mp4`;
  const suffix = /LIPSYNC|MUSETALK/i.test(binding) ? "_ls" : /UPSCALE/i.test(binding) ? "_up" : null;
  if (!suffix)
    return null;
  return insertKeySuffix(fs.clip_key, suffix);
}
__name(finishStepOutputKey, "finishStepOutputKey");
function insertKeySuffix(key, suffix) {
  const slash = key.lastIndexOf("/");
  const dotInBase = key.slice(slash + 1).lastIndexOf(".");
  if (dotInBase < 0)
    return `${key}${suffix}`;
  const at = slash + 1 + dotInBase;
  return `${key.slice(0, at)}${suffix}${key.slice(at)}`;
}
__name(insertKeySuffix, "insertKeySuffix");
function moduleByBinding(modules, binding) {
  return modules?.find((m) => m.binding === binding);
}
__name(moduleByBinding, "moduleByBinding");
var MAX_APPLIED_TAG_TEMPLATE_CHARS = 512;
function resolveAppliedTemplate(tag, cfg) {
  const src = tag.length > MAX_APPLIED_TAG_TEMPLATE_CHARS ? tag.slice(0, MAX_APPLIED_TAG_TEMPLATE_CHARS) : tag;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf("}", open + 1);
    if (close === -1) {
      out += src.slice(open);
      break;
    }
    const inner = src.slice(open + 1, close);
    const pipe = inner.indexOf("|");
    const knob = pipe === -1 ? inner : inner.slice(0, pipe);
    const dflt = pipe === -1 ? void 0 : inner.slice(pipe + 1);
    if (/^[A-Za-z0-9_]+$/.test(knob)) {
      const v = cfg[knob];
      out += v === void 0 ? dflt ?? "" : String(v);
    } else {
      out += src.slice(open, close + 1);
    }
    i = close + 1;
  }
  return out;
}
__name(resolveAppliedTemplate, "resolveAppliedTemplate");
function finishStepAppliedTag(fs, modules) {
  const binding = fs.chain[fs.idx] ?? "";
  const cfg = fs.configs?.[fs.idx] ?? {};
  const rules = moduleByBinding(modules, binding)?.finish_artifacts?.applied;
  if (rules) {
    for (const rule of rules) {
      if (rule.when && cfg[rule.when.knob] !== rule.when.equals)
        continue;
      return resolveAppliedTemplate(rule.tag, cfg);
    }
    return `${binding}:r2-adopted`;
  }
  if (/LIPSYNC|MUSETALK/i.test(binding))
    return `lipsync:${String(cfg.version ?? "v15")}`;
  if (/UPSCALE/i.test(binding))
    return `upscale:${Number(cfg.scale ?? 2)}x`;
  if (/RIFE/i.test(binding))
    return cfg.interpolate === false ? "noop:interpolate-off" : `interpolate:${Number(cfg.interpolation_factor ?? 2)}x`;
  return `${binding}:r2-adopted`;
}
__name(finishStepAppliedTag, "finishStepAppliedTag");
function classifyAssembleTransport(status, priorAttempts, maxAttempts) {
  const transient = status === null || status === 502 || status === 503 || status === 504;
  if (!transient)
    return { state: "ok", attempts: 0 };
  const attempts = priorAttempts + 1;
  const reason = status === null ? "container unreachable" : `gateway ${status}`;
  if (attempts < maxAttempts) {
    return {
      state: "retry",
      attempts,
      error: `assemble retry ${attempts}/${maxAttempts} (${reason}); clips intact, re-attempting next poll`
    };
  }
  return {
    state: "exhausted",
    attempts,
    error: `video-finish ${reason} after ${attempts} assemble attempts; clips intact in R2 (reset phase to "assemble" to retry)`
  };
}
__name(classifyAssembleTransport, "classifyAssembleTransport");
var MASTER_STEP_MAX_ATTEMPTS = 3;
var MASTER_STALL_SECONDS = 15 * 60;
function filmSeconds(job) {
  const total = (job.scenes || []).reduce((a, s) => a + (Number(s.seconds) || 0), 0);
  return total > 0 ? total : void 0;
}
__name(filmSeconds, "filmSeconds");
function masteredBedKey(audioKey, format = "wav") {
  const slash = audioKey.lastIndexOf("/");
  const dot = audioKey.lastIndexOf(".");
  const base = dot > slash ? audioKey.slice(0, dot) : audioKey;
  return `${base}_mastered.${format}`;
}
__name(masteredBedKey, "masteredBedKey");
function applyMasterOutput(m, prevKey, out) {
  const binding = m.chain[m.idx] ?? "";
  const carried = typeof out.audio_key === "string" && out.audio_key.length > 0 ? out.audio_key : prevKey;
  for (const a of out.applied || [])
    m.applied.push(a);
  if (typeof out.degraded === "string" && out.degraded.length > 0)
    m.degraded.push(`${binding}: ${out.degraded}`);
  m.idx += 1;
  m.poll = void 0;
  m.attempts = 0;
  return carried;
}
__name(applyMasterOutput, "applyMasterOutput");
function degradeMasterStep(m, reason) {
  const binding = m.chain[m.idx] ?? "";
  m.degraded.push(`${binding}: ${reason}`);
  m.idx += 1;
  m.poll = void 0;
  m.attempts = 0;
}
__name(degradeMasterStep, "degradeMasterStep");
function masterChainDone(m) {
  return m.idx >= m.chain.length;
}
__name(masterChainDone, "masterChainDone");
function coerceSceneIds(scenes) {
  return (scenes || []).map((s, i) => ({ ...s, shot_id: coerceShotId(s.shot_id, i) }));
}
__name(coerceSceneIds, "coerceSceneIds");
function coerceDialogueLineIds(originalScenes, lines) {
  if (!lines || !lines.length)
    return lines;
  const map = /* @__PURE__ */ new Map();
  (originalScenes || []).forEach((s, i) => {
    if (s && typeof s.shot_id === "string" && s.shot_id.trim())
      map.set(s.shot_id.trim(), coerceShotId(s.shot_id, i));
  });
  return lines.map((l) => {
    const mapped = l && typeof l.shot_id === "string" ? map.get(l.shot_id.trim()) : void 0;
    return mapped && mapped !== l.shot_id ? { ...l, shot_id: mapped } : l;
  });
}
__name(coerceDialogueLineIds, "coerceDialogueLineIds");
var KEYFRAME_STALL_SECONDS = 20 * 60;
var PHASE_HARD_DEADLINE_SECONDS = 90 * 60;
var POLLABLE_PHASES = /* @__PURE__ */ new Set(["keyframe", "clips", "speech", "finish"]);
function phaseAgeSeconds(job, now = Date.now()) {
  const since = job.phase_started_at ?? job.created_at;
  return Math.max(0, Math.floor((now - since) / 1e3));
}
__name(phaseAgeSeconds, "phaseAgeSeconds");
var PER_SHOT_PHASES = /* @__PURE__ */ new Set(["clips", "speech", "finish"]);
function ceilingAgeSeconds(job, now = Date.now()) {
  if (!PER_SHOT_PHASES.has(job.phase))
    return phaseAgeSeconds(job, now);
  const since = Math.max(job.phase_started_at ?? job.created_at, job.last_progress_at ?? 0);
  return Math.max(0, Math.floor((now - since) / 1e3));
}
__name(ceilingAgeSeconds, "ceilingAgeSeconds");
function filmProgressMarker(job, clipJob) {
  let done = 0;
  if (job.phase === "clips")
    done = (clipJob?.shots || []).filter((s) => s.status === "done").length;
  else if (job.phase === "finish")
    done = (job.finish_shots || []).filter((fs) => fs.status === "done").length;
  else if (job.phase === "speech")
    done = (job.speech_shots || []).filter((ss) => ss.status === "done").length;
  return `${job.phase}:${done}`;
}
__name(filmProgressMarker, "filmProgressMarker");
var DEFAULT_CLIP_DURATION_FLOOR = 0.5;
function resolveClipDurationFloor(raw) {
  const n = raw === void 0 || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n))
    return DEFAULT_CLIP_DURATION_FLOOR;
  return Math.min(1, Math.max(0, n));
}
__name(resolveClipDurationFloor, "resolveClipDurationFloor");
function mapClipDurationsToShots(finalClips, clipDurations) {
  const out = {};
  if (!Array.isArray(clipDurations))
    return out;
  for (let i = 0; i < finalClips.length; i++) {
    const d = clipDurations[i];
    if (typeof d === "number" && Number.isFinite(d) && d >= 0)
      out[finalClips[i].shot_id] = d;
  }
  return out;
}
__name(mapClipDurationsToShots, "mapClipDurationsToShots");
function resolvePlannedSeconds(scenes, bundleDurations) {
  const out = {};
  for (const s of scenes ?? []) {
    if (!s || typeof s.shot_id !== "string")
      continue;
    const fromBundle = bundleDurations[s.shot_id];
    if (typeof fromBundle === "number" && Number.isFinite(fromBundle) && fromBundle > 0) {
      out[s.shot_id] = fromBundle;
      continue;
    }
    if (typeof s.seconds === "number" && Number.isFinite(s.seconds) && s.seconds > 0)
      out[s.shot_id] = s.seconds;
  }
  return out;
}
__name(resolvePlannedSeconds, "resolvePlannedSeconds");
function findClipDurationShortfalls(finalClips, actual, planned, fraction) {
  const out = [];
  for (const c of finalClips ?? []) {
    if (!c || typeof c.shot_id !== "string")
      continue;
    const a = actual[c.shot_id];
    const p = planned[c.shot_id];
    if (typeof a !== "number" || !Number.isFinite(a) || typeof p !== "number" || !Number.isFinite(p) || p <= 0)
      continue;
    const floor = p * fraction;
    if (a < floor)
      out.push({ shot_id: c.shot_id, actual: a, planned: p, floor });
  }
  return out;
}
__name(findClipDurationShortfalls, "findClipDurationShortfalls");
function captionDurations(bundleDurations, actualDurations) {
  return { ...bundleDurations, ...actualDurations ?? {} };
}
__name(captionDurations, "captionDurations");

// node_modules/@skyphusion-labs/vivijure-core/dist/srt.js
function formatTimestamp(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const msPart = totalMs % 1e3;
  const totalSec = Math.floor(totalMs / 1e3);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = /* @__PURE__ */ __name((n, w = 2) => String(n).padStart(w, "0"), "pad");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msPart, 3)}`;
}
__name(formatTimestamp, "formatTimestamp");
function retimeSrt(srt, offsetSeconds) {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0)
    return srt;
  const offsetMs = Math.round(offsetSeconds * 1e3);
  return srt.split("\n").map((line) => {
    if (!line.includes("-->"))
      return line;
    return line.replace(/(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/g, (_m, h, mm, ss, mmm) => {
      const base = Number(h) * 36e5 + Number(mm) * 6e4 + Number(ss) * 1e3 + Number(mmm);
      return formatTimestamp(base + offsetMs);
    });
  }).join("\n");
}
__name(retimeSrt, "retimeSrt");

// node_modules/@skyphusion-labs/vivijure-core/dist/operator-config.js
function installSubschema(schema) {
  const out = {};
  if (!schema)
    return out;
  for (const [key, field] of Object.entries(schema)) {
    if (field.scope === "install")
      out[key] = field;
  }
  return out;
}
__name(installSubschema, "installSubschema");
function hasInstallConfig(schema) {
  return Object.keys(installSubschema(schema)).length > 0;
}
__name(hasInstallConfig, "hasInstallConfig");
function clampInstallPatch(schema, current, patch) {
  const sub = installSubschema(schema);
  const merged = { ...current, ...patch ?? {} };
  return validateConfig(sub, merged);
}
__name(clampInstallPatch, "clampInstallPatch");
async function readStored(env, moduleName) {
  const rs = await env.DB.prepare("SELECT field_key, value_json FROM operator_module_config WHERE module_name = ?").bind(moduleName).all();
  const out = {};
  for (const row of rs.results ?? []) {
    try {
      out[row.field_key] = JSON.parse(row.value_json);
    } catch {
    }
  }
  return out;
}
__name(readStored, "readStored");
async function loadInstallConfig(env, moduleName, schema) {
  const sub = installSubschema(schema);
  if (Object.keys(sub).length === 0)
    return {};
  const stored = await readStored(env, moduleName);
  return validateConfig(sub, stored);
}
__name(loadInstallConfig, "loadInstallConfig");
async function setInstallConfig(env, moduleName, schema, patch) {
  const sub = installSubschema(schema);
  const current = await readStored(env, moduleName);
  const next = clampInstallPatch(schema, current, patch);
  const now = Math.floor(Date.now() / 1e3);
  const stmt = env.DB.prepare(`INSERT INTO operator_module_config (module_name, field_key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(module_name, field_key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = excluded.updated_at`);
  const writes = Object.keys(sub).map((key) => stmt.bind(moduleName, key, JSON.stringify(next[key]), now));
  if (writes.length)
    await env.DB.batch(writes);
  return next;
}
__name(setInstallConfig, "setInstallConfig");

// node_modules/@skyphusion-labs/vivijure-core/dist/secret-store.js
async function secretValue(s) {
  if (typeof s === "string")
    return s;
  if (!s)
    return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + e.message);
    return "";
  }
}
__name(secretValue, "secretValue");

// node_modules/@skyphusion-labs/vivijure-core/dist/render-log.js
function renderLogKey(jobId) {
  return `renders/logs/${jobId}.txt`;
}
__name(renderLogKey, "renderLogKey");
var MAX_LOG_FIELD = 4e3;
function clampLog(s) {
  return s.length > MAX_LOG_FIELD ? `${s.slice(0, MAX_LOG_FIELD)}
...[truncated ${s.length - MAX_LOG_FIELD} chars]` : s;
}
__name(clampLog, "clampLog");
function buildRenderLogText(view, generatedAtIso) {
  const lines = [];
  lines.push(`Render log - job ${view.jobId}`);
  lines.push(`Generated: ${generatedAtIso}`);
  const raw = view.statusRaw && view.statusRaw !== view.status ? ` (${view.statusRaw})` : "";
  lines.push(`Status: ${view.status}${raw}`);
  if (typeof view.executionTimeMs === "number") {
    lines.push(`Execution: ${(view.executionTimeMs / 1e3).toFixed(1)}s`);
  }
  if (typeof view.delayTimeMs === "number") {
    lines.push(`Queue delay: ${(view.delayTimeMs / 1e3).toFixed(1)}s`);
  }
  if (view.error) {
    lines.push("", "Error:", clampLog(view.error));
  }
  if (view.output !== void 0 && view.output !== null) {
    lines.push("", "Output / diagnostics:");
    if (typeof view.output === "string") {
      lines.push(clampLog(view.output));
    } else {
      try {
        lines.push(clampLog(JSON.stringify(view.output, null, 2)));
      } catch {
        lines.push(clampLog(String(view.output)));
      }
    }
  }
  return lines.join("\n") + "\n";
}
__name(buildRenderLogText, "buildRenderLogText");
async function writeRenderLog(env, view) {
  try {
    const key = renderLogKey(view.jobId);
    const text = buildRenderLogText(view, (/* @__PURE__ */ new Date()).toISOString());
    await env.R2_RENDERS.put(key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" }
    });
    return key;
  } catch (e) {
    console.warn(`render log write failed for job ${view.jobId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
__name(writeRenderLog, "writeRenderLog");

// node_modules/@skyphusion-labs/vivijure-core/dist/d1-retry.js
var D1_FATAL = /(constraint failed|no such (table|column|index)|syntax error|datatype mismatch|not null|unique|readonly|malformed|ambiguous column|too many|foreign key)/i;
var D1_TRANSIENT = /(d1_error[\s\S]*?(internal error|transient|temporar|overloaded|try again|reset|timed? ?out|unavailable))|(network connection lost)|(storage (caused|operation)[\s\S]*?(reset|lost|error))|(\b50[02-4]\b)/i;
function isTransientD1Error(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg)
    return false;
  if (D1_FATAL.test(msg))
    return false;
  return D1_TRANSIENT.test(msg);
}
__name(isTransientD1Error, "isTransientD1Error");
function d1ErrorCode(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (msg.split("\n")[0] || "unknown").slice(0, 120);
}
__name(d1ErrorCode, "d1ErrorCode");
var defaultSleep = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "defaultSleep");
async function withD1Retry(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = Math.max(1, opts.baseDelayMs ?? 50);
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = isTransientD1Error(err);
      if (i === attempts - 1 || !transient) {
        if (transient) {
          emitStructuredEvent({ ev: "d1.exhausted", op: opts.label, attempts: i + 1, code: d1ErrorCode(err) });
        }
        throw err;
      }
      emitStructuredEvent({ ev: "d1.retry", op: opts.label, attempt: i + 1, code: d1ErrorCode(err) });
      const jitter = Math.floor(Math.random() * base);
      await sleep(base * 2 ** i + jitter);
    }
  }
  throw lastErr;
}
__name(withD1Retry, "withD1Retry");

// node_modules/@skyphusion-labs/vivijure-core/dist/public-id.js
function newPublicId() {
  return crypto.randomUUID();
}
__name(newPublicId, "newPublicId");
var PUBLIC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isPublicId(raw) {
  return typeof raw === "string" && PUBLIC_ID_RE.test(raw);
}
__name(isPublicId, "isPublicId");

// node_modules/@skyphusion-labs/vivijure-core/dist/film-output-key.js
function defaultFilmOutputKey(filmId) {
  return `renders/${filmId}/film.mp4`;
}
__name(defaultFilmOutputKey, "defaultFilmOutputKey");
function resolveFilmOutputKey(job) {
  if (typeof job.film_key === "string" && job.film_key.length > 0)
    return job.film_key;
  if (typeof job.silent_film_key === "string" && job.silent_film_key.length > 0)
    return job.silent_film_key;
  if (job.keyframes_only)
    return void 0;
  if (job.finish_unavailable?.delivered === "clips")
    return void 0;
  return defaultFilmOutputKey(job.film_id);
}
__name(resolveFilmOutputKey, "resolveFilmOutputKey");
async function adoptFilmOutputKeyFromStore(env, filmId) {
  const key = defaultFilmOutputKey(filmId);
  try {
    return await env.R2_RENDERS.head(key) !== null ? key : void 0;
  } catch {
    return void 0;
  }
}
__name(adoptFilmOutputKeyFromStore, "adoptFilmOutputKeyFromStore");

// node_modules/@skyphusion-labs/vivijure-core/dist/key-safety.js
var BUNDLE_KEY_PREFIX = "bundles/";
var REL_KEY_CHARS = /^[A-Za-z0-9._\-\/]+$/;
function isSafeRelKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024)
    return false;
  if (key.startsWith("/"))
    return false;
  if (!REL_KEY_CHARS.test(key))
    return false;
  return !key.split("/").includes("..");
}
__name(isSafeRelKey, "isSafeRelKey");
function isSafeBundleKey(key) {
  return isSafeRelKey(key) && key.startsWith(BUNDLE_KEY_PREFIX);
}
__name(isSafeBundleKey, "isSafeBundleKey");
function sanitizeKeySegment(raw, fallback = "project") {
  const s = raw.replace(/[^A-Za-z0-9._\-]/g, "_").replace(/\.\.+/g, "_").replace(/^[._-]+/, "");
  return s.length > 0 ? s : fallback;
}
__name(sanitizeKeySegment, "sanitizeKeySegment");

// node_modules/@skyphusion-labs/vivijure-core/dist/film-advance-lease.js
var FILM_ADVANCE_LEASE_TTL_SECONDS = 300;
async function claimFilmAdvance(env, filmId, now = Date.now()) {
  const lease = now + FILM_ADVANCE_LEASE_TTL_SECONDS * 1e3;
  const token = crypto.randomUUID();
  const res = await withD1Retry(() => env.DB.prepare(`UPDATE renders SET advance_lease = ?, advance_lease_token = ?
     WHERE job_id = ? AND (advance_lease IS NULL OR advance_lease < ? OR advance_lease_token = ?)`).bind(lease, token, filmId, now, token).run());
  if ((res.meta?.changes ?? 0) === 1)
    return { won: true, lease, token };
  const row = await withD1Retry(() => env.DB.prepare(`SELECT 1 AS one FROM renders WHERE job_id = ?`).bind(filmId).first());
  return row ? { won: false } : { won: true };
}
__name(claimFilmAdvance, "claimFilmAdvance");
async function releaseFilmAdvance(env, filmId, token) {
  await withD1Retry(() => env.DB.prepare(`UPDATE renders SET advance_lease = NULL, advance_lease_token = NULL
       WHERE job_id = ? AND advance_lease_token = ?`).bind(filmId, token).run());
}
__name(releaseFilmAdvance, "releaseFilmAdvance");

// node_modules/@skyphusion-labs/vivijure-core/dist/renders-db.js
function warnCorruptColumn(column, e) {
  console.warn(`renders: corrupt ${column} JSON in a row, using fallback: ${e instanceof Error ? e.message : String(e)}`);
}
__name(warnCorruptColumn, "warnCorruptColumn");
function toPublicRenderRow(row) {
  const { id: _internalId, project_id: _internalProjectId, parent_id: _internalParentId, public_id, project_public_id, parent_public_id, ...rest } = row;
  return { ...rest, id: public_id, project_id: project_public_id, parent_id: parent_public_id };
}
__name(toPublicRenderRow, "toPublicRenderRow");
var RENDER_ROW_COLUMNS = `
      r.id, r.public_id, r.job_id, r.project, r.bundle_key, r.quality_tier,
      r.render_overrides, r.status, r.output_key, r.output_json AS output,
      r.error, r.execution_time_ms, r.delay_time_ms,
      r.submitted_at, r.updated_at, r.completed_at, r.label, r.keyframes_json, r.mode,
      r.locked_shots_json, r.project_id, r.folder_path, r.tags_json, r.parent_id,
      p.public_id AS project_public_id, pr.public_id AS parent_public_id`;
var RENDER_ROW_FROM = `
    FROM renders r
    LEFT JOIN storyboard_projects p ON r.project_id = p.id
    LEFT JOIN renders pr ON r.parent_id = pr.id`;
function nowSeconds() {
  return Math.floor(Date.now() / 1e3);
}
__name(nowSeconds, "nowSeconds");
var TERMINAL_STATUSES = /* @__PURE__ */ new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT"
]);
function buildInsertRenderStmt(env, row) {
  const now = nowSeconds();
  const overrides = row.renderOverrides ? JSON.stringify(row.renderOverrides) : null;
  const mode = row.mode ?? "full";
  const projectId = typeof row.projectId === "number" && row.projectId > 0 ? row.projectId : null;
  const parentId = typeof row.parentId === "number" && row.parentId > 0 ? row.parentId : null;
  return env.DB.prepare(`INSERT INTO renders (
      public_id, job_id, project, bundle_key, quality_tier,
      render_overrides, status, submitted_at, updated_at, mode,
      project_id, parent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`).bind(newPublicId(), row.jobId, row.project, row.bundleKey, row.qualityTier, overrides, row.status, now, now, mode, projectId, parentId);
}
__name(buildInsertRenderStmt, "buildInsertRenderStmt");
async function insertRender(env, row) {
  const res = await buildInsertRenderStmt(env, row).run();
  return (res.meta?.changes ?? 0) > 0;
}
__name(insertRender, "insertRender");
async function updateRenderFromView(env, view, ctx) {
  const now = nowSeconds();
  const completed = TERMINAL_STATUSES.has(view.status) ? now : null;
  let outputKey = null;
  let keyframesJson = null;
  let modeFromOutput = null;
  if (view.output && typeof view.output === "object" && !Array.isArray(view.output)) {
    const o = view.output;
    const rawOutputKey = o.output_key;
    if (typeof rawOutputKey === "string" && rawOutputKey.length > 0) {
      if (isSafeRelKey(rawOutputKey)) {
        outputKey = rawOutputKey;
      } else {
        console.warn(`renders: rejecting unsafe output_key from GPU envelope: ${String(rawOutputKey).slice(0, 80)}`);
      }
    }
    const refs = normalizeKeyframes(o.keyframes);
    if (refs.length > 0)
      keyframesJson = JSON.stringify(refs);
    if (typeof o.mode === "string" && o.mode.length > 0) {
      modeFromOutput = o.mode;
    }
  }
  if (!outputKey && view.status === "COMPLETED" && typeof view.jobId === "string" && view.jobId.startsWith("film-")) {
    const mode = view.output && typeof view.output === "object" && !Array.isArray(view.output) && typeof view.output.mode === "string" ? String(view.output.mode) : "full";
    if (mode !== "keyframes-only") {
      const adopted = await adoptFilmOutputKeyFromStore(env, view.jobId);
      if (adopted)
        outputKey = adopted;
    }
  }
  const outputJson = view.output !== void 0 ? JSON.stringify(view.output) : null;
  await withD1Retry(() => env.DB.prepare(`UPDATE renders SET
      status = ?,
      output_key = COALESCE(?, output_key),
      output_json = ?,
      error = ?,
      execution_time_ms = ?,
      delay_time_ms = ?,
      updated_at = ?,
      completed_at = COALESCE(?, completed_at),
      keyframes_json = COALESCE(?, keyframes_json),
      mode = COALESCE(?, mode)
    WHERE job_id = ?`).bind(view.status, outputKey, outputJson, view.error ?? null, view.executionTimeMs ?? null, view.delayTimeMs ?? null, now, completed, keyframesJson, modeFromOutput, view.jobId).run());
  if (completed !== null) {
    const logTask = (async () => {
      try {
        await writeRenderLog(env, view);
      } catch (e) {
        console.warn(`render log write failed for job ${view.jobId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    if (ctx)
      ctx.waitUntil(logTask);
    else
      await logTask;
  }
}
__name(updateRenderFromView, "updateRenderFromView");
async function setCloudAnimateProgress(env, jobId, done, total) {
  const now = nowSeconds();
  const json6 = JSON.stringify({ mode: "cloud-finalized", progress: { done, total } });
  await env.DB.prepare(`UPDATE renders SET output_json = ?, updated_at = ?
       WHERE job_id = ?
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`).bind(json6, now, jobId).run();
}
__name(setCloudAnimateProgress, "setCloudAnimateProgress");
async function setHybridProgress(env, jobId, lanes) {
  const now = nowSeconds();
  const done = lanes.gpu.done + lanes.cloud.done;
  const total = lanes.gpu.total + lanes.cloud.total;
  const json6 = JSON.stringify({
    mode: "cloud-finalized",
    progress: { done, total, gpu: lanes.gpu, cloud: lanes.cloud }
  });
  await env.DB.prepare(`UPDATE renders SET output_json = ?, updated_at = ?
       WHERE job_id = ?
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`).bind(json6, now, jobId).run();
}
__name(setHybridProgress, "setHybridProgress");
async function markRenderFailedByJobId(env, jobId, error) {
  const now = nowSeconds();
  const res = await withD1Retry(() => env.DB.prepare(`UPDATE renders SET
       status = 'FAILED',
       error = ?,
       completed_at = COALESCE(completed_at, ?),
       updated_at = ?
     WHERE job_id = ?
       AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`).bind(error.slice(0, 2e3), now, now, jobId).run());
  return (res.meta?.changes ?? 0) > 0;
}
__name(markRenderFailedByJobId, "markRenderFailedByJobId");
async function claimFinish(env, jobId) {
  const now = nowSeconds();
  const res = await withD1Retry(() => env.DB.prepare(`UPDATE renders SET finish_state = 'finishing', updated_at = ?
     WHERE job_id = ? AND COALESCE(finish_state, '') NOT IN ('finishing', 'done')`).bind(now, jobId).run());
  return (res.meta?.changes ?? 0) === 1;
}
__name(claimFinish, "claimFinish");
async function markFinishDone(env, jobId, outputKey, outputJson) {
  const now = nowSeconds();
  await withD1Retry(() => env.DB.prepare(`UPDATE renders SET output_key = ?, output_json = ?, status = 'COMPLETED',
       finish_state = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ?
     WHERE job_id = ?`).bind(outputKey, outputJson, now, now, jobId).run());
}
__name(markFinishDone, "markFinishDone");
async function listUnresolvedNotifiableJobs(env, maxAgeSeconds, limit = 25) {
  const cutoff = nowSeconds() - Math.max(0, maxAgeSeconds);
  const res = await env.DB.prepare(`SELECT job_id FROM renders
       WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         AND notified_at IS NULL
         AND COALESCE(mode, 'full') != 'keyframes-only'
         AND parent_id IS NULL
         AND submitted_at >= ?
       ORDER BY submitted_at ASC
       LIMIT ?`).bind(cutoff, Math.min(Math.max(1, limit), 100)).all();
  return (res.results ?? []).map((r) => String(r.job_id)).filter((s) => s.length > 0);
}
__name(listUnresolvedNotifiableJobs, "listUnresolvedNotifiableJobs");
async function listStrandedPostClipsFilmJobs(env, maxAgeSeconds, limit = 25) {
  const cutoff = nowSeconds() - Math.max(0, maxAgeSeconds);
  const res = await env.DB.prepare(`SELECT job_id FROM renders
       WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         AND notified_at IS NULL
         AND COALESCE(mode, 'full') != 'keyframes-only'
         AND parent_id IS NULL
         AND submitted_at < ?
         AND (
           output_json LIKE '%"phase":"assemble"%'
           OR output_json LIKE '%"phase":"finish"%'
           OR output_json LIKE '%"phase":"mux"%'
         )
       ORDER BY submitted_at ASC
       LIMIT ?`).bind(cutoff, Math.min(Math.max(1, limit), 100)).all();
  return (res.results ?? []).map((r) => String(r.job_id)).filter((s) => s.length > 0);
}
__name(listStrandedPostClipsFilmJobs, "listStrandedPostClipsFilmJobs");
async function markFinishFailed(env, jobId, error) {
  const now = nowSeconds();
  await withD1Retry(() => env.DB.prepare(`UPDATE renders SET finish_state = 'failed', error = ?, updated_at = ? WHERE job_id = ?`).bind(error.slice(0, 2e3), now, jobId).run());
}
__name(markFinishFailed, "markFinishFailed");
async function getFinishState(env, jobId) {
  const row = await withD1Retry(() => env.DB.prepare(`SELECT finish_state, output_key FROM renders WHERE job_id = ?`).bind(jobId).first());
  return row ?? null;
}
__name(getFinishState, "getFinishState");
var MAX_LOCKED_SHOTS = 200;
function normalizeLockedShots(raw) {
  if (!Array.isArray(raw))
    return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string")
      continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 80)
      continue;
    if (seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_LOCKED_SHOTS)
      break;
  }
  return out;
}
__name(normalizeLockedShots, "normalizeLockedShots");
function normalizeFolderPath(raw) {
  if (typeof raw !== "string")
    return null;
  const parts = raw.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0)
    return null;
  const joined = parts.join("/");
  return joined.length > 200 ? joined.slice(0, 200) : joined;
}
__name(normalizeFolderPath, "normalizeFolderPath");
var MAX_TAGS = 24;
var MAX_TAG_LEN = 40;
function normalizeTags(raw) {
  if (!Array.isArray(raw))
    return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string")
      continue;
    const tag = entry.trim().toLowerCase().slice(0, MAX_TAG_LEN);
    if (!tag)
      continue;
    if (seen.has(tag))
      continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS)
      break;
  }
  return out;
}
__name(normalizeTags, "normalizeTags");
function normalizeKeyframes(raw) {
  if (!Array.isArray(raw))
    return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object")
      continue;
    const e = entry;
    if (typeof e.shot_id !== "string" || e.shot_id.length === 0)
      continue;
    if (typeof e.key !== "string" || e.key.length === 0)
      continue;
    out.push({ shot_id: e.shot_id, key: e.key });
  }
  return out;
}
__name(normalizeKeyframes, "normalizeKeyframes");
async function setRenderAudioOutput(env, id, outputKey, seconds) {
  const now = nowSeconds();
  const res = await env.DB.prepare(`UPDATE renders SET
       output_key = ?,
       output_json = json_set(
         COALESCE(output_json, '{}'),
         '$.output_key', ?,
         '$.has_audio', json('true'),
         '$.seconds', ?
       ),
       updated_at = ?
     WHERE id = ?`).bind(outputKey, outputKey, seconds, now, id).run();
  return (res.meta?.changes ?? 0) > 0;
}
__name(setRenderAudioOutput, "setRenderAudioOutput");
async function getRenderIdByPublicId(env, publicId) {
  const r = await env.DB.prepare(`SELECT id FROM renders WHERE public_id = ? LIMIT 1`).bind(publicId).first();
  return r ? Number(r.id) : null;
}
__name(getRenderIdByPublicId, "getRenderIdByPublicId");
async function getRenderByIdForUser(env, id) {
  const r = await env.DB.prepare(`SELECT${RENDER_ROW_COLUMNS}${RENDER_ROW_FROM}
    WHERE r.id = ?`).bind(id).first();
  if (!r)
    return null;
  return normalizeRow(r);
}
__name(getRenderByIdForUser, "getRenderByIdForUser");
async function setRenderLabel(env, id, label) {
  const now = Math.floor(Date.now() / 1e3);
  const result = await env.DB.prepare(`UPDATE renders SET label = ?, updated_at = ? WHERE id = ?`).bind(label, now, id).run();
  const changes = result.meta?.changes ?? 0;
  return changes > 0;
}
__name(setRenderLabel, "setRenderLabel");
async function deleteRenderRow(env, id) {
  const result = await env.DB.prepare(`DELETE FROM renders WHERE id = ?`).bind(id).run();
  const changes = result.meta?.changes ?? 0;
  return changes > 0;
}
__name(deleteRenderRow, "deleteRenderRow");
var DEFAULT_RENDERS_LIMIT = 50;
async function listRendersForUser(env, limit = DEFAULT_RENDERS_LIMIT, projectId = null) {
  const cap = Math.min(Math.max(1, Math.floor(limit)), 200);
  const baseSelect = `SELECT${RENDER_ROW_COLUMNS}${RENDER_ROW_FROM}`;
  const stmt = projectId !== null && projectId > 0 ? env.DB.prepare(`${baseSelect}
         WHERE r.project_id = ? OR r.project_id IS NULL
         ORDER BY r.submitted_at DESC
         LIMIT ?`).bind(projectId, cap) : env.DB.prepare(`${baseSelect}
         ORDER BY r.submitted_at DESC
         LIMIT ?`).bind(cap);
  const result = await stmt.all();
  return (result.results ?? []).map(normalizeRow);
}
__name(listRendersForUser, "listRendersForUser");
function normalizeRow(r) {
  let overrides = null;
  const oRaw = r.render_overrides;
  if (typeof oRaw === "string" && oRaw.length > 0) {
    try {
      const parsed = JSON.parse(oRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        overrides = parsed;
      }
    } catch (e) {
      warnCorruptColumn("render_overrides", e);
      overrides = null;
    }
  }
  let output = null;
  const opRaw = r.output;
  if (typeof opRaw === "string" && opRaw.length > 0) {
    try {
      output = JSON.parse(opRaw);
    } catch (e) {
      warnCorruptColumn("output_json", e);
      output = opRaw;
    }
  }
  let keyframes = null;
  const kfRaw = r.keyframes_json;
  if (typeof kfRaw === "string" && kfRaw.length > 0) {
    try {
      const parsed = JSON.parse(kfRaw);
      const refs = normalizeKeyframes(parsed);
      if (refs.length > 0)
        keyframes = refs;
    } catch (e) {
      warnCorruptColumn("keyframes_json", e);
      keyframes = null;
    }
  }
  return {
    id: Number(r.id),
    public_id: String(r.public_id),
    job_id: String(r.job_id),
    // D1 returns a SQL-NULL column as JS null, and String(null) === "null":
    // the literal "null" string is truthy and defeats every downstream falsy
    // guard (planner labels, download names, and re-render eligibility gating
    // that keys off a truthy bundle_key). The schema permits these three to be
    // NULL (migrations/0001_init.sql), so coerce SQL NULL to "" here to keep
    // the RenderRow non-null string contract with a falsy empty value.
    project: r.project == null ? "" : String(r.project),
    bundle_key: r.bundle_key == null ? "" : String(r.bundle_key),
    quality_tier: r.quality_tier == null ? "" : String(r.quality_tier),
    render_overrides: overrides,
    status: String(r.status),
    output_key: r.output_key ? String(r.output_key) : null,
    output,
    error: r.error ? String(r.error) : null,
    execution_time_ms: r.execution_time_ms == null ? null : Number(r.execution_time_ms),
    delay_time_ms: r.delay_time_ms == null ? null : Number(r.delay_time_ms),
    submitted_at: Number(r.submitted_at),
    updated_at: Number(r.updated_at),
    completed_at: r.completed_at == null ? null : Number(r.completed_at),
    label: typeof r.label === "string" && r.label.length > 0 ? r.label : null,
    keyframes,
    // v0.40.0: collapse NULL / unknown values to 'full' so callers do
    // not need to do this themselves. Legacy rows pre-dating the mode
    // column read as NULL and are therefore 'full'.
    // v0.42.0 adds 'finalized' as a third recognized value.
    mode: r.mode === "keyframes-only" ? "keyframes-only" : r.mode === "finalized" ? "finalized" : r.mode === "cloud-finalized" ? "cloud-finalized" : "full",
    // v0.42.0: parse the locked_shots_json column back into a string
    // array; NULL / empty / malformed -> null (read as "nothing
    // locked"). The normalizer keeps the same MAX_LOCKED_SHOTS cap as
    // the write path so a corrupted row cannot bloat a list response.
    locked_shots: (() => {
      const lsRaw = r.locked_shots_json;
      if (typeof lsRaw !== "string" || lsRaw.length === 0)
        return null;
      try {
        const parsed = JSON.parse(lsRaw);
        const arr = normalizeLockedShots(parsed);
        return arr.length > 0 ? arr : null;
      } catch (e) {
        warnCorruptColumn("locked_shots_json", e);
        return null;
      }
    })(),
    // v0.55.0: NULL for legacy rows or transient (no-project) submits.
    project_id: r.project_id == null ? null : Number(r.project_id),
    // v0.126.0: organization fields. folder_path is stored verbatim (already
    // normalized on the write path); tags_json is a JSON array re-normalized
    // on read so a hand-edited / corrupted row can never bloat a list.
    folder_path: typeof r.folder_path === "string" && r.folder_path.length > 0 ? r.folder_path : null,
    tags: (() => {
      const tRaw = r.tags_json;
      if (typeof tRaw !== "string" || tRaw.length === 0)
        return [];
      try {
        return normalizeTags(JSON.parse(tRaw));
      } catch (e) {
        warnCorruptColumn("tags_json", e);
        return [];
      }
    })(),
    // v0.145.2: NULL on top-level renders; set on finalize / animate-cloud
    // children to the keyframes-only preview render they derive from.
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    // S9 (F13): FK public ids from the LEFT JOIN; NULL when the FK is NULL or the referent is gone.
    project_public_id: r.project_public_id == null ? null : String(r.project_public_id),
    parent_public_id: r.parent_public_id == null ? null : String(r.parent_public_id)
  };
}
__name(normalizeRow, "normalizeRow");
async function setRenderLockedShots(env, id, lockedShots) {
  const now = Math.floor(Date.now() / 1e3);
  const json6 = lockedShots.length > 0 ? JSON.stringify(lockedShots) : null;
  const result = await env.DB.prepare(`UPDATE renders SET locked_shots_json = ?, updated_at = ? WHERE id = ?`).bind(json6, now, id).run();
  const changes = result.meta?.changes ?? 0;
  return changes > 0;
}
__name(setRenderLockedShots, "setRenderLockedShots");
async function getRenderIdByJobId(env, jobId) {
  const r = await env.DB.prepare(`SELECT id FROM renders WHERE job_id = ?`).bind(jobId).first();
  return r ? Number(r.id) : null;
}
__name(getRenderIdByJobId, "getRenderIdByJobId");
async function getScatterChildren(env, parentId) {
  const rs = await env.DB.prepare(`SELECT job_id, status FROM renders WHERE parent_id = ? ORDER BY id ASC`).bind(parentId).all();
  return (rs.results ?? []).map((r) => ({ job_id: String(r.job_id), status: String(r.status) }));
}
__name(getScatterChildren, "getScatterChildren");
async function setRenderFolder(env, id, folderPath) {
  const now = Math.floor(Date.now() / 1e3);
  const result = await env.DB.prepare(`UPDATE renders SET folder_path = ?, updated_at = ? WHERE id = ?`).bind(folderPath, now, id).run();
  const changes = result.meta?.changes ?? 0;
  return changes > 0;
}
__name(setRenderFolder, "setRenderFolder");
async function setRenderTags(env, id, tags) {
  const now = Math.floor(Date.now() / 1e3);
  const json6 = tags.length > 0 ? JSON.stringify(tags) : null;
  const result = await env.DB.prepare(`UPDATE renders SET tags_json = ?, updated_at = ? WHERE id = ?`).bind(json6, now, id).run();
  const changes = result.meta?.changes ?? 0;
  return changes > 0;
}
__name(setRenderTags, "setRenderTags");
var TAG_SCAN_LIMIT = 500;
async function listUserTags(env) {
  const result = await env.DB.prepare(`SELECT tags_json FROM renders
      WHERE tags_json IS NOT NULL
      ORDER BY submitted_at DESC
      LIMIT ?`).bind(TAG_SCAN_LIMIT).all();
  const rows = result.results ?? [];
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (typeof row.tags_json !== "string")
      continue;
    let parsed;
    try {
      parsed = JSON.parse(row.tags_json);
    } catch (e) {
      warnCorruptColumn("tags_json", e);
      continue;
    }
    for (const tag of normalizeTags(parsed)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}
__name(listUserTags, "listUserTags");

// node_modules/@skyphusion-labs/vivijure-core/dist/tar.js
var BLOCK_SIZE = 512;
function writeOctal(bytes, offset, width, value) {
  const oct = value.toString(8).padStart(width - 1, "0");
  for (let i = 0; i < width - 1; i++) {
    bytes[offset + i] = oct.charCodeAt(i);
  }
  bytes[offset + width - 1] = 0;
}
__name(writeOctal, "writeOctal");
function writeString(bytes, offset, width, s) {
  for (let i = 0; i < s.length && i < width; i++) {
    bytes[offset + i] = s.charCodeAt(i) & 255;
  }
}
__name(writeString, "writeString");
function checksumHeader(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (i >= 148 && i < 156)
      sum += 32;
    else
      sum += header[i];
  }
  return sum;
}
__name(checksumHeader, "checksumHeader");
function assertSafeTarName(name) {
  if (!isSafeRelKey(name)) {
    throw new Error(`tar: unsafe entry name: ${name}`);
  }
}
__name(assertSafeTarName, "assertSafeTarName");
function buildHeader(file) {
  assertSafeTarName(file.name);
  if (file.name.length === 0) {
    throw new Error("tar: empty file name");
  }
  if (file.name.length > 100) {
    throw new Error(`tar: filename too long (${file.name.length} > 100): ${file.name}`);
  }
  const header = new Uint8Array(BLOCK_SIZE);
  writeString(header, 0, 100, file.name);
  writeOctal(header, 100, 8, file.mode ?? 420);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.content.length);
  const mtime = file.mtime ?? Math.floor(Date.now() / 1e3);
  writeOctal(header, 136, 12, mtime);
  header[156] = 48;
  writeString(header, 257, 5, "ustar");
  header[262] = 0;
  header[263] = 48;
  header[264] = 48;
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  const sum = checksumHeader(header);
  const sumStr = sum.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++)
    header[148 + i] = sumStr.charCodeAt(i);
  header[148 + 6] = 0;
  header[148 + 7] = 32;
  return header;
}
__name(buildHeader, "buildHeader");
function readTar(bytes) {
  const out = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    let allZero = true;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero)
      break;
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0)
      nameEnd++;
    const name = decoder.decode(header.subarray(0, nameEnd));
    assertSafeTarName(name);
    const sizeStr = decoder.decode(header.subarray(124, 124 + 12)).replace(/\0/g, "").trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const contentStart = offset + BLOCK_SIZE;
    if (name) {
      out.push({ name, content: new Uint8Array(bytes.subarray(contentStart, contentStart + size)) });
    }
    offset = contentStart + BLOCK_SIZE * Math.ceil(size / BLOCK_SIZE);
  }
  return out;
}
__name(readTar, "readTar");
function emitTar(files) {
  let total = 0;
  for (const f of files) {
    total += BLOCK_SIZE;
    total += BLOCK_SIZE * Math.ceil(f.content.length / BLOCK_SIZE);
  }
  total += BLOCK_SIZE * 2;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of files) {
    const header = buildHeader(f);
    out.set(header, offset);
    offset += BLOCK_SIZE;
    out.set(f.content, offset);
    offset += BLOCK_SIZE * Math.ceil(f.content.length / BLOCK_SIZE);
  }
  return out;
}
__name(emitTar, "emitTar");

// node_modules/@skyphusion-labs/vivijure-core/dist/shot-durations-parse.js
function parseShotDurations(yaml) {
  const out = {};
  let inScenes = false;
  let idx = 0;
  let curId = null;
  let curTarget = null;
  const flush = /* @__PURE__ */ __name(() => {
    if (idx === 0)
      return;
    const shot = curId || `shot_${String(idx).padStart(2, "0")}`;
    if (curTarget !== null && Number.isFinite(curTarget) && curTarget > 0) {
      out[shot] = curTarget;
    }
  }, "flush");
  for (const line of yaml.split(/\r?\n/)) {
    if (!inScenes) {
      if (/^scenes:\s*$/.test(line))
        inScenes = true;
      continue;
    }
    if (/^ {2}-\s/.test(line)) {
      flush();
      idx++;
      curId = null;
      curTarget = null;
      continue;
    }
    const idM = line.match(/^ {4}id:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (idM) {
      curId = idM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const tsM = line.match(/^ {4}target_seconds:\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (tsM) {
      curTarget = parseFloat(tsM[1]);
      continue;
    }
  }
  flush();
  return out;
}
__name(parseShotDurations, "parseShotDurations");

// node_modules/@skyphusion-labs/vivijure-core/dist/bundle-durations.js
function chunkForStream(bytes) {
  const chunk = bytes.slice();
  return chunk;
}
__name(chunkForStream, "chunkForStream");
async function gzipBytes(bytes) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(chunkForStream(bytes)).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done)
      break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
__name(gzipBytes, "gzipBytes");
async function gunzipBytes(bytes) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(chunkForStream(bytes)).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done)
      break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
__name(gunzipBytes, "gunzipBytes");
async function readShotDurationsFromBundle(env, bundleKey) {
  try {
    const src = await env.R2_RENDERS.get(bundleKey);
    if (!src)
      return {};
    const tarBytes = await gunzipBytes(new Uint8Array(await src.arrayBuffer()));
    for (const e of readTar(tarBytes)) {
      if (e.name === "storyboard.yaml") {
        return parseShotDurations(new TextDecoder().decode(e.content));
      }
    }
  } catch {
  }
  return {};
}
__name(readShotDurationsFromBundle, "readShotDurationsFromBundle");

// node_modules/@skyphusion-labs/vivijure-core/dist/platform/fetcher.js
function asFetcher(v) {
  if (v && typeof v.fetch === "function") {
    return v;
  }
  return null;
}
__name(asFetcher, "asFetcher");

// node_modules/@skyphusion-labs/vivijure-core/dist/clip-content-validate.js
var INSPECT_TTL_SECONDS = 1800;
async function callVideoFinishInspect(env, payload, opts = {}) {
  if (!env.VIDEO_FINISH_VPC)
    return null;
  const vpc = asFetcher(env.VIDEO_FINISH_VPC);
  if (!vpc)
    return null;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  let resp = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await vpc.fetch("http://video-finish/inspect", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504)
      break;
    if (attempt < retries - 1)
      await new Promise((r) => setTimeout(r, backoffMs));
  }
  if (!resp || !resp.ok)
    return null;
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
__name(callVideoFinishInspect, "callVideoFinishInspect");
async function contentValidateClip(env, clipKey, keyframeKey) {
  if (!env.VIDEO_FINISH_VPC)
    return { verdict: "skip", reason: "video-finish tier not installed (VIDEO_FINISH_VPC unbound)" };
  let clipUrl;
  let keyframeUrl;
  try {
    clipUrl = await presignR2Get(env, clipKey, INSPECT_TTL_SECONDS);
    if (keyframeKey)
      keyframeUrl = await presignR2Get(env, keyframeKey, INSPECT_TTL_SECONDS);
  } catch (e) {
    return { verdict: "skip", reason: `presign failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = await callVideoFinishInspect(env, { clipUrl, keyframeUrl });
  if (!r || !r.ok || !r.verdict)
    return { verdict: "skip", reason: "video-finish /inspect unreachable or errored" };
  return { verdict: r.verdict, reason: r.reason, metrics: r.metrics, keyframe_similarity: r.keyframe_similarity };
}
__name(contentValidateClip, "contentValidateClip");
async function contentValidateDoneClips(env, job, inspect = contentValidateClip) {
  if (!env.VIDEO_FINISH_VPC)
    return false;
  let changed = false;
  for (const shot of job.shots) {
    if (shot.status !== "done" || !shot.clip_key || shot.content_validated && shot.content_validated !== "skip")
      continue;
    const v = await inspect(env, shot.clip_key, shot.keyframe_key);
    if (v.verdict !== "skip")
      shot.content_validated = v.verdict;
    emitStructuredEvent({
      ev: "clip.content_validate",
      job_id: job.job_id,
      shot_id: shot.shot_id,
      verdict: v.verdict,
      ...v.keyframe_similarity != null ? { keyframe_similarity: v.keyframe_similarity } : {},
      ...v.metrics ? { metrics: v.metrics } : {},
      ...v.reason ? { reason: v.reason } : {}
    });
    if (v.verdict === "corrupt") {
      shot.status = "failed";
      shot.error = `clip failed content validation: ${v.reason ?? "does not resemble its keyframe"}`;
      shot.poll = void 0;
      changed = true;
    } else if (v.verdict === "suspect") {
      shot.content_degraded = v.reason ?? "chromatic-noise signature";
      changed = true;
    }
  }
  return changed;
}
__name(contentValidateDoneClips, "contentValidateDoneClips");

// node_modules/@skyphusion-labs/vivijure-core/dist/captions.js
var MIN_CUE_SECONDS = 0.2;
function shotDuration(scene, durations) {
  const fromBundle = durations[scene.shot_id];
  if (typeof fromBundle === "number" && Number.isFinite(fromBundle) && fromBundle > 0)
    return fromBundle;
  if (typeof scene.seconds === "number" && Number.isFinite(scene.seconds) && scene.seconds > 0)
    return scene.seconds;
  return 0;
}
__name(shotDuration, "shotDuration");
function buildCaptionCues(scenes, lines, durations = {}) {
  const textByShot = /* @__PURE__ */ new Map();
  for (const l of lines ?? []) {
    if (!l || typeof l.shot_id !== "string")
      continue;
    const text = typeof l.text === "string" ? l.text.trim() : "";
    if (text)
      textByShot.set(l.shot_id, text);
  }
  const cues = [];
  let cursor = 0;
  for (const scene of scenes ?? []) {
    if (!scene || typeof scene.shot_id !== "string")
      continue;
    const start = cursor;
    cursor += shotDuration(scene, durations);
    const text = textByShot.get(scene.shot_id);
    if (!text)
      continue;
    const end = Math.max(start + MIN_CUE_SECONDS, cursor);
    cues.push({ start, end, text });
  }
  return cues;
}
__name(buildCaptionCues, "buildCaptionCues");

// node_modules/@skyphusion-labs/vivijure-core/dist/audio-routing.js
function needsAudioCrossBucketCopy(key) {
  return key.startsWith("out/");
}
__name(needsAudioCrossBucketCopy, "needsAudioCrossBucketCopy");

// node_modules/@skyphusion-labs/vivijure-core/dist/audio-stage.js
var RENDERS_AUDIO_PREFIXES = ["audio/", "dialogue/", "renders/", "out/"];
function assertStagedAudioKey(key) {
  if (!isSafeRelKey(key))
    throw new Error(`unsafe audioKey: ${key}`);
  if (needsAudioCrossBucketCopy(key)) {
    const rest = key.slice("out/".length);
    if (!rest || rest.includes("/") || rest.startsWith(".")) {
      throw new Error(`out/ audioKey must be a single segment under out/: ${key}`);
    }
    return;
  }
  if (!RENDERS_AUDIO_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(`audioKey must start with one of ${RENDERS_AUDIO_PREFIXES.join(", ")} (got ${key})`);
  }
}
__name(assertStagedAudioKey, "assertStagedAudioKey");
async function stageAudioKeyForRenders(env, audioKey) {
  const key = audioKey.trim();
  if (!key)
    throw new Error("audioKey required");
  assertStagedAudioKey(key);
  if (!needsAudioCrossBucketCopy(key)) {
    if (!await env.R2_RENDERS.head(key))
      throw new Error(`audio source not found: ${key}`);
    return key;
  }
  if (await env.R2_RENDERS.head(key))
    return key;
  const src = await env.R2.get(key);
  if (!src)
    throw new Error(`audio source not found: ${key}`);
  const ext = key.split(".").pop() || "mp3";
  const dest = `audio/${crypto.randomUUID()}.${ext}`;
  const head = await env.R2.head(key);
  const mime = head?.httpMetadata?.contentType || "audio/mpeg";
  await env.R2_RENDERS.put(dest, await src.arrayBuffer(), { httpMetadata: { contentType: mime } });
  return dest;
}
__name(stageAudioKeyForRenders, "stageAudioKeyForRenders");
async function resolveStagedAudioKey(env, audioKey) {
  if (!audioKey?.trim())
    return void 0;
  return stageAudioKeyForRenders(env, audioKey.trim());
}
__name(resolveStagedAudioKey, "resolveStagedAudioKey");

// node_modules/@skyphusion-labs/vivijure-core/dist/cast-db.js
function parseImageKeyList(raw) {
  if (!raw)
    return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
      return [];
    return parsed.filter((r) => r && typeof r === "object" && typeof r.key === "string" && typeof r.mime === "string").map((r) => ({ key: r.key, mime: r.mime }));
  } catch {
    return [];
  }
}
__name(parseImageKeyList, "parseImageKeyList");
function normalizeLoraStatus(raw) {
  if (raw === "training" || raw === "ready" || raw === "failed")
    return raw;
  return "idle";
}
__name(normalizeLoraStatus, "normalizeLoraStatus");
function rowToCast(row) {
  return {
    id: row.id,
    public_id: row.public_id,
    slug: row.slug,
    name: row.name,
    bible: row.bible,
    portrait_key: row.portrait_key,
    portrait_mime: row.portrait_mime,
    ref_keys: parseImageKeyList(row.ref_keys_json),
    source_keys: parseImageKeyList(row.source_keys_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    lora_key: row.lora_key,
    lora_status: normalizeLoraStatus(row.lora_status),
    lora_job_id: row.lora_job_id,
    lora_error: row.lora_error,
    lora_trained_at: row.lora_trained_at,
    voice_id: row.voice_id,
    wan_lora_key_high: row.wan_lora_key_high,
    wan_lora_key_low: row.wan_lora_key_low
  };
}
__name(rowToCast, "rowToCast");
function toPublicCast(row) {
  const { id: _internalId, public_id, ...rest } = row;
  return { ...rest, id: public_id };
}
__name(toPublicCast, "toPublicCast");
function slugifyCharacter(name) {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]+/g, "").trim().replace(/[\s-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "character";
}
__name(slugifyCharacter, "slugifyCharacter");
async function allocateCastSlug(env, base) {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(`SELECT id FROM cast_members WHERE slug = ? LIMIT 1`).bind(candidate).first();
    if (!existing)
      return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate cast slug after 200 attempts (base='${base}')`);
}
__name(allocateCastSlug, "allocateCastSlug");
var CAST_LIST_LIMIT = 500;
async function listCast(env) {
  const result = await env.DB.prepare(`SELECT id, public_id, slug, name, bible, portrait_key, portrait_mime,
            ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low
       FROM cast_members
      ORDER BY created_at DESC
      LIMIT ?`).bind(CAST_LIST_LIMIT).all();
  return (result.results || []).map(rowToCast);
}
__name(listCast, "listCast");
async function getCastIdByPublicId(env, publicId) {
  const row = await env.DB.prepare(`SELECT id FROM cast_members WHERE public_id = ? LIMIT 1`).bind(publicId).first();
  return row ? Number(row.id) : null;
}
__name(getCastIdByPublicId, "getCastIdByPublicId");
async function getCastById(env, id) {
  const row = await env.DB.prepare(`SELECT id, public_id, slug, name, bible, portrait_key, portrait_mime,
            ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low
       FROM cast_members
      WHERE id = ?
      LIMIT 1`).bind(id).first();
  return row ? rowToCast(row) : null;
}
__name(getCastById, "getCastById");
async function createCast(env, input) {
  const baseSlug = slugifyCharacter(input.name);
  const slug = await allocateCastSlug(env, baseSlug);
  const result = await env.DB.prepare(`INSERT INTO cast_members (public_id, slug, name, bible)
     VALUES (?, ?, ?, ?)
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(newPublicId(), slug, input.name, input.bible ?? null).first();
  if (!result)
    throw new Error("createCast: INSERT...RETURNING produced no row");
  return rowToCast(result);
}
__name(createCast, "createCast");
async function updateCast(env, id, patch) {
  const fields = [];
  const values = [];
  if (patch.name !== void 0) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.bible !== void 0) {
    fields.push("bible = ?");
    values.push(patch.bible);
  }
  if (patch.voice_id !== void 0) {
    fields.push("voice_id = ?");
    values.push(patch.voice_id);
  }
  if (fields.length === 0) {
    return getCastById(env, id);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  const result = await env.DB.prepare(`UPDATE cast_members SET ${fields.join(", ")}
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(...values).first();
  return result ? rowToCast(result) : null;
}
__name(updateCast, "updateCast");
async function deleteCast(env, id) {
  const row = await getCastById(env, id);
  if (!row)
    return null;
  await env.DB.prepare(`DELETE FROM cast_members WHERE id = ?`).bind(id).run();
  return row;
}
__name(deleteCast, "deleteCast");
async function setPortrait(env, id, key, mime) {
  const result = await env.DB.prepare(`UPDATE cast_members
        SET portrait_key = ?, portrait_mime = ?, updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(key, mime, id).first();
  return result ? rowToCast(result) : null;
}
__name(setPortrait, "setPortrait");
async function clearPortrait(env, id) {
  const result = await env.DB.prepare(`UPDATE cast_members
        SET portrait_key = NULL, portrait_mime = NULL, updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
            lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(id).first();
  return result ? rowToCast(result) : null;
}
__name(clearPortrait, "clearPortrait");
var CAST_ROW_COLUMNS = `id, public_id, slug, name, bible, portrait_key, portrait_mime,
   ref_keys_json, source_keys_json, created_at, updated_at,
   lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`;
async function casUpdateImageList(env, column, id, mutate, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cur = await env.DB.prepare(`SELECT ${column} AS raw FROM cast_members WHERE id = ?`).bind(id).first();
    if (!cur)
      return { row: null, changed: false, notFound: true };
    const { next, changed } = mutate(parseImageKeyList(cur.raw));
    if (!changed) {
      const row = await getCastById(env, id);
      return { row, changed: false, notFound: row === null };
    }
    const updated = await env.DB.prepare(`UPDATE cast_members
          SET ${column} = ?, updated_at = datetime('now')
        WHERE id = ? AND ${column} IS ?
       RETURNING ${CAST_ROW_COLUMNS}`).bind(JSON.stringify(next), id, cur.raw).first();
    if (updated)
      return { row: rowToCast(updated), changed: true, notFound: false };
  }
  console.warn(`cast ${column} update for id ${id} gave up after ${maxAttempts} CAS attempts under contention`);
  return { row: await getCastById(env, id), changed: false, notFound: false };
}
__name(casUpdateImageList, "casUpdateImageList");
async function addRef(env, id, ref) {
  const { row } = await casUpdateImageList(env, "ref_keys_json", id, (cur) => ({
    next: [...cur, ref],
    changed: true
  }));
  return row;
}
__name(addRef, "addRef");
async function addRefs(env, id, refs) {
  if (refs.length === 0)
    return getCastById(env, id);
  const { row } = await casUpdateImageList(env, "ref_keys_json", id, (cur) => ({
    next: [...cur, ...refs],
    changed: true
  }));
  return row;
}
__name(addRefs, "addRefs");
async function removeRef(env, id, refKey) {
  const { row, changed, notFound: notFound2 } = await casUpdateImageList(env, "ref_keys_json", id, (cur) => {
    const next = cur.filter((r) => r.key !== refKey);
    return { next, changed: next.length !== cur.length };
  });
  if (notFound2)
    return { row: null, removedKey: null };
  return { row, removedKey: changed ? refKey : null };
}
__name(removeRef, "removeRef");
async function addSource(env, id, src) {
  const { row } = await casUpdateImageList(env, "source_keys_json", id, (cur) => ({
    next: [...cur, src],
    changed: true
  }));
  return row;
}
__name(addSource, "addSource");
async function removeSource(env, id, srcKey) {
  const { row, changed, notFound: notFound2 } = await casUpdateImageList(env, "source_keys_json", id, (cur) => {
    const next = cur.filter((s) => s.key !== srcKey);
    return { next, changed: next.length !== cur.length };
  });
  if (notFound2)
    return { row: null, removedKey: null };
  return { row, removedKey: changed ? srcKey : null };
}
__name(removeSource, "removeSource");
async function setLoraJob(env, id, jobId) {
  const result = await env.DB.prepare(`UPDATE cast_members
        SET lora_status = 'training',
            lora_job_id = ?,
            lora_error = NULL,
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(jobId, id).first();
  return result ? rowToCast(result) : null;
}
__name(setLoraJob, "setLoraJob");
async function markLoraReady(env, id, loraKey) {
  const result = await env.DB.prepare(`UPDATE cast_members
        SET lora_status = 'ready',
            lora_key = ?,
            lora_trained_at = datetime('now'),
            lora_job_id = NULL,
            lora_error = NULL,
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(loraKey, id).first();
  return result ? rowToCast(result) : null;
}
__name(markLoraReady, "markLoraReady");
async function markWanLoraReady(env, id, highKey, lowKey) {
  const result = await env.DB.prepare(`UPDATE cast_members
        SET lora_status = 'ready',
            wan_lora_key_high = ?,
            wan_lora_key_low = ?,
            lora_trained_at = datetime('now'),
            lora_job_id = NULL,
            lora_error = NULL,
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(highKey, lowKey, id).first();
  return result ? rowToCast(result) : null;
}
__name(markWanLoraReady, "markWanLoraReady");
async function markLoraFailed(env, id, errorMessage) {
  const result = await env.DB.prepare(`UPDATE cast_members
        SET lora_status = 'failed',
            lora_error = ?,
            lora_job_id = NULL,
            updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, source_keys_json, created_at, updated_at,
               lora_key, lora_status, lora_job_id, lora_error, lora_trained_at, voice_id, wan_lora_key_high, wan_lora_key_low`).bind(errorMessage.slice(0, 4e3), id).first();
  return result ? rowToCast(result) : null;
}
__name(markLoraFailed, "markLoraFailed");

// node_modules/@skyphusion-labs/vivijure-core/dist/lora-keys.js
function deriveLoraDestKey(castId, timestamp) {
  return `loras/cast-${castId}/${timestamp}.safetensors`;
}
__name(deriveLoraDestKey, "deriveLoraDestKey");

// node_modules/@skyphusion-labs/vivijure-core/dist/film-orchestrator.js
async function r2ObjectExists(env, key) {
  try {
    return await env.R2_RENDERS.head(key) !== null;
  } catch {
    return false;
  }
}
__name(r2ObjectExists, "r2ObjectExists");
async function clipKeysFromFilmJob(env, job) {
  const out = /* @__PURE__ */ new Map();
  if (job.finish_shots?.length) {
    for (const fs of job.finish_shots) {
      if (fs.status === "done" && fs.clip_key)
        out.set(fs.shot_id, fs.clip_key);
    }
    return out;
  }
  if (!job.clip_job_id)
    return out;
  const cjObj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
  if (!cjObj)
    return out;
  const clipJob = JSON.parse(await cjObj.text());
  for (const sh of clipJob.shots) {
    if (sh.status === "done" && sh.clip_key)
      out.set(sh.shot_id, sh.clip_key);
  }
  return out;
}
__name(clipKeysFromFilmJob, "clipKeysFromFilmJob");
function completeKeyframesOnly(job, kfOut) {
  const kfs = kfOut.keyframes || [];
  if (!kfs.length) {
    job.phase = "failed";
    job.error = "keyframe stage produced no keyframes";
    return;
  }
  job.keyframes = kfs.map((k) => ({ shot_id: k.shot_id, keyframe_key: k.keyframe_key }));
  job.phase = "done";
}
__name(completeKeyframesOnly, "completeKeyframesOnly");
async function recordTrainedLorasToCast(env, job, kfOut) {
  const trained = kfOut.trained_loras;
  const castIds = job.cast_loras;
  if (!trained || !castIds)
    return;
  for (const [slot, srcKey] of Object.entries(trained)) {
    const castId = castIds[slot];
    if (!Number.isInteger(castId) || castId <= 0 || typeof srcKey !== "string" || !srcKey)
      continue;
    const stableKey = deriveLoraDestKey(castId, job.created_at);
    try {
      const cast = await withD1Retry(() => getCastById(env, castId));
      if (!cast)
        continue;
      if (cast.lora_status === "ready" && (cast.lora_key === srcKey || cast.lora_key === stableKey))
        continue;
      const obj = await env.R2_RENDERS.get(srcKey);
      if (!obj) {
        console.warn(`recordTrainedLoras: adapter missing in R2 (${srcKey}); cast ${castId} not banked`);
        continue;
      }
      await env.R2_RENDERS.put(stableKey, obj.body);
      await withD1Retry(() => markLoraReady(env, castId, stableKey));
      console.log(`recordTrainedLoras: cast ${castId} slot ${slot} banked ${srcKey} -> ${stableKey} (cross-project reuse)`);
    } catch (e) {
      console.warn(`recordTrainedLoras: cast ${castId} slot ${slot} failed: ${e.message}`);
    }
  }
}
__name(recordTrainedLorasToCast, "recordTrainedLorasToCast");
async function stampKeyframeProvenance(env, job, kfOut) {
  const kfs = kfOut.keyframes || [];
  if (!kfs.length)
    return;
  const hash = await keyframeProvenanceHash({ keyframe_config: job.keyframe_config });
  for (const k of kfs) {
    if (k.keyframe_key)
      await writeProv(env, k.keyframe_key, hash);
  }
}
__name(stampKeyframeProvenance, "stampKeyframeProvenance");
async function afterKeyframeOutput(env, job, kfOut, preModules) {
  await recordTrainedLorasToCast(env, job, kfOut);
  await stampKeyframeProvenance(env, job, kfOut);
  if (job.keyframes_only) {
    completeKeyframesOnly(job, kfOut);
    return;
  }
  await advanceToClips(env, job, kfOut, preModules);
}
__name(afterKeyframeOutput, "afterKeyframeOutput");
async function advanceToClips(env, job, kfOut, preModules) {
  const { matched, missing } = joinKeyframesToScenes(job.scenes, kfOut.keyframes || []);
  if (!matched.length) {
    job.phase = "failed";
    job.error = `keyframe stage produced none of the requested shots (missing: ${missing.join(", ")})`;
    return;
  }
  if (missing.length && !job.keyframes_incomplete) {
    job.keyframes_incomplete = { adopted: matched.length, expected: job.scenes.length, dropped: missing };
    emitKeyframesIncomplete(job);
    console.warn(`film ${job.film_id}: keyframe module completed with only ${matched.length}/${job.scenes.length} keyframes; delivering the rendered scenes, dropped ${missing.join(", ")} (#622)`);
  }
  const shots = [];
  for (const m of matched) {
    const keyframe_url = await presignR2Get(env, m.keyframe_key, 1800);
    shots.push({ shot_id: m.shot_id, keyframe_url, prompt: m.prompt, seconds: m.seconds });
  }
  const clip = await startClipJob(env, {
    project: job.project,
    shots,
    motion_backend: job.motion_backend ?? void 0,
    config: job.motion_config
  }, preModules);
  job.clip_job_id = clip.job_id;
  job.phase = "clips";
}
__name(advanceToClips, "advanceToClips");
var lastPersistedFilmPhase = /* @__PURE__ */ new Map();
var putFilm = /* @__PURE__ */ __name(async (env, job) => {
  let prev = lastPersistedFilmPhase.get(job.film_id);
  if (prev === void 0) {
    try {
      const existing = await env.R2_RENDERS.get(filmKey(job.film_id));
      if (existing) {
        const old = JSON.parse(await existing.text());
        if (old?.phase)
          prev = old.phase;
      }
    } catch {
    }
  }
  if (prev !== job.phase) {
    emitStructuredEvent({
      ev: "film.phase",
      film_id: job.film_id,
      project: job.project,
      from: prev ?? null,
      to: job.phase
    });
    if (job.phase === "done" || job.phase === "failed") {
      emitStructuredEvent({
        ev: "film.render.terminal",
        film_id: job.film_id,
        project: job.project,
        status: job.phase,
        from: prev ?? null,
        ...job.error ? { error: job.error } : {}
      });
      lastPersistedFilmPhase.delete(job.film_id);
    } else {
      lastPersistedFilmPhase.set(job.film_id, job.phase);
    }
  }
  await env.R2_RENDERS.put(filmKey(job.film_id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" }
  });
}, "putFilm");
function finishChainForShot(serving, isDialogueShot) {
  if (!isDialogueShot)
    return serving;
  return [...serving.filter((m) => m.finish_consumes_audio), ...serving.filter((m) => !m.finish_consumes_audio)];
}
__name(finishChainForShot, "finishChainForShot");
function finishOrderLegacyDialogue(finishConfig) {
  const row = finishConfig?.["finish-order"];
  if (!row || typeof row !== "object")
    return false;
  return row.dialogue_legacy === true || row.legacy === true;
}
__name(finishOrderLegacyDialogue, "finishOrderLegacyDialogue");
function finishOrderReorderDialogue(finishConfig) {
  const row = finishConfig?.["finish-order"];
  if (!row || typeof row !== "object")
    return false;
  return row.dialogue_reorder === true || row.reorder === true;
}
__name(finishOrderReorderDialogue, "finishOrderReorderDialogue");
function resolveFinishChainForShot(serving, isDialogueShot, finishConfig) {
  if (finishOrderLegacyDialogue(finishConfig))
    return serving;
  if (isDialogueShot && finishOrderReorderDialogue(finishConfig)) {
    return finishChainForShot(serving, true);
  }
  return serving;
}
__name(resolveFinishChainForShot, "resolveFinishChainForShot");
async function enterFinishPhase(env, job, clipJob, preModules) {
  if (job.clip_job_id && await validateDoneClips(env, clipJob)) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
  }
  if (job.clip_job_id && await contentValidateDoneClips(env, clipJob)) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
  }
  const modules = preModules ?? await discoverModules(env);
  const serving = servingForHook(modules, "finish");
  const doneClips = clipJob.shots.filter((s) => s.status === "done" && s.clip_key);
  if (!doneClips.length) {
    job.phase = "failed";
    const reasons = describeClipFailures(clipJob);
    job.error = reasons ? `no clips rendered to assemble -- ${reasons}` : "no clips rendered to assemble";
    return;
  }
  if (!serving.length) {
    job.phase = job.clips_only ? "done" : "assemble";
    return;
  }
  const dialogueShotIds = new Set((job.dialogue_lines ?? []).filter((l) => l.shot_id && (l.text ?? "").trim().length > 0).map((l) => l.shot_id));
  job.finish_shots = doneClips.map((s) => {
    const ordered = resolveFinishChainForShot(serving, dialogueShotIds.has(s.shot_id), job.finish_config);
    return {
      shot_id: s.shot_id,
      clip_key: s.clip_key,
      chain: ordered.map((m) => m.binding),
      configs: resolveFinishConfigs(ordered, job.finish_config),
      idx: 0,
      status: "pending",
      applied: []
    };
  });
  await enterDialogueOrFinish(env, job, preModules);
}
__name(enterFinishPhase, "enterFinishPhase");
function applyDialogueOutput(job, out) {
  const map = {};
  for (const a of out?.audio || []) {
    if (a && typeof a.shot_id === "string" && typeof a.audio_key === "string")
      map[a.shot_id] = a.audio_key;
  }
  job.dialogue_audio = map;
}
__name(applyDialogueOutput, "applyDialogueOutput");
async function enterDialogueOrFinish(env, job, preModules) {
  const lines = job.dialogue_lines;
  if (!lines || !lines.length) {
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  const envRec = env;
  const dialogueModule = servingForHook(preModules ?? await discoverModules(envRec), "dialogue")[0];
  const fetcher = dialogueModule ? resolveFetcher(envRec, dialogueModule.binding) : null;
  if (!fetcher) {
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  const req = {
    hook: "dialogue",
    input: { project: job.project, lines },
    config: {},
    context: { project: job.project, job_id: job.film_id }
  };
  const r = await invokeModule(fetcher, req);
  if (!r.ok) {
    console.warn(`film ${job.film_id}: dialogue submit failed (${r.error}); silent finish`);
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  if (r.pending) {
    job.dialogue_poll = r.poll;
    job.phase = "dialogue";
    return;
  }
  if ("output" in r) {
    const v = hookOutputViolation(dialogueModule.name, "dialogue", r.output);
    if (v) {
      console.warn(`film ${job.film_id}: dialogue ${v}; silent finish`);
      await enterSpeechOrFinish(env, job, preModules);
      return;
    }
    applyDialogueOutput(job, r.output);
  }
  await enterSpeechOrFinish(env, job, preModules);
}
__name(enterDialogueOrFinish, "enterDialogueOrFinish");
async function advanceDialoguePhase(env, job, preModules) {
  if (!job.dialogue_poll) {
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  const envRec = env;
  const dialogueModule = servingForHook(preModules ?? await discoverModules(envRec), "dialogue")[0];
  const fetcher = dialogueModule ? resolveFetcher(envRec, dialogueModule.binding) : null;
  if (!fetcher) {
    job.dialogue_poll = void 0;
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  const p = await pollModule(fetcher, { poll: job.dialogue_poll });
  if (!p.ok) {
    console.warn(`film ${job.film_id}: dialogue failed (${p.error}); silent finish`);
    job.dialogue_poll = void 0;
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  if (p.pending)
    return;
  const out = p.output;
  const v = hookOutputViolation(dialogueModule.name, "dialogue", out);
  if (v) {
    console.warn(`film ${job.film_id}: dialogue ${v}; silent finish`);
    job.dialogue_poll = void 0;
    await enterSpeechOrFinish(env, job, preModules);
    return;
  }
  applyDialogueOutput(job, out);
  job.dialogue_poll = void 0;
  await enterSpeechOrFinish(env, job, preModules);
}
__name(advanceDialoguePhase, "advanceDialoguePhase");
async function enterSpeechOrFinish(env, job, preModules) {
  const audio = job.dialogue_audio ?? {};
  const shotIds = Object.keys(audio);
  if (!shotIds.length) {
    job.phase = "finish";
    return;
  }
  const serving = servingForHook(preModules ?? await discoverModules(env), "speech");
  const chain = serving.map((m) => m.binding);
  if (!chain.length) {
    job.phase = "finish";
    return;
  }
  const configs = resolveFinishConfigs(serving, job.speech_config ?? {});
  job.speech_shots = shotIds.map((shot_id) => ({
    shot_id,
    audio_key: audio[shot_id],
    chain,
    configs,
    idx: 0,
    status: "pending",
    applied: []
  }));
  job.phase = "speech";
}
__name(enterSpeechOrFinish, "enterSpeechOrFinish");
async function advanceSpeechPhase(env, job) {
  const envRec = env;
  const degrade = /* @__PURE__ */ __name((ss, reason) => {
    ss.degraded = reason;
    ss.idx += 1;
    ss.poll = void 0;
    ss.attempts = 0;
    if (ss.idx >= ss.chain.length)
      ss.status = "done";
  }, "degrade");
  const blipOrDegrade = /* @__PURE__ */ __name((ss, error, keepPoll) => {
    const d = classifyFinishRetry(error, ss.attempts ?? 0);
    if (d.action === "retry") {
      ss.attempts = d.attempts;
      ss.error = `speech ${ss.chain[ss.idx]} transient (attempt ${d.attempts}/${FINISH_STEP_MAX_ATTEMPTS}), retrying: ${error ?? ""}`;
      if (!keepPoll)
        ss.poll = void 0;
    } else {
      degrade(ss, `${ss.chain[ss.idx]}: ${error ?? "speech step failed"}`);
    }
  }, "blipOrDegrade");
  for (const ss of job.speech_shots || []) {
    if (ss.status !== "pending")
      continue;
    const fetcher = resolveFetcher(envRec, ss.chain[ss.idx]);
    if (!fetcher) {
      degrade(ss, `speech module ${ss.chain[ss.idx]} not bound`);
      continue;
    }
    const req = {
      hook: "speech",
      input: { shot_id: ss.shot_id, audio_key: ss.audio_key },
      config: ss.configs?.[ss.idx] ?? {},
      context: { project: job.project, job_id: job.film_id }
    };
    if (!ss.poll) {
      const r = await invokeModule(fetcher, req);
      if (!r.ok) {
        blipOrDegrade(ss, r.error, false);
      } else if (r.pending) {
        ss.poll = r.poll;
      } else if ("output" in r) {
        const v = hookOutputViolation(ss.chain[ss.idx], "speech", r.output);
        if (v) {
          degrade(ss, v);
        } else {
          applySpeechOutput(ss, r.output);
        }
      } else {
        degrade(ss, "speech module returned neither output nor a poll token");
      }
    } else {
      const p = await pollModule(fetcher, { poll: ss.poll });
      if (p.ok && !p.pending) {
        const out = p.output;
        const v = hookOutputViolation(ss.chain[ss.idx], "speech", out);
        if (v) {
          degrade(ss, v);
        } else {
          applySpeechOutput(ss, out);
        }
      } else if (!p.ok && classifyFinishFailure(p.error) === "transient") {
        blipOrDegrade(ss, p.error, true);
      } else if (!p.ok) {
        blipOrDegrade(ss, p.error, false);
      }
    }
  }
  const speechShots = job.speech_shots || [];
  if (speechShots.every((ss) => ss.status !== "pending")) {
    for (const ss of speechShots)
      (job.dialogue_audio ??= {})[ss.shot_id] = ss.audio_key;
    job.phase = "finish";
  }
}
__name(advanceSpeechPhase, "advanceSpeechPhase");
async function headEtag2(env, key) {
  if (!key)
    return null;
  try {
    return (await env.R2_RENDERS.head(key))?.etag ?? null;
  } catch {
    return null;
  }
}
__name(headEtag2, "headEtag");
async function finishArtifactHashMatches(env, job, fs, artifactKey) {
  let stored;
  try {
    const sc = await env.R2_RENDERS.get(`${artifactKey}.hash`);
    if (!sc)
      return false;
    stored = (await sc.text()).trim();
  } catch {
    return false;
  }
  const [clipEtag, audioEtag] = await Promise.all([
    headEtag2(env, fs.clip_key),
    headEtag2(env, job.dialogue_audio?.[fs.shot_id])
  ]);
  const expected = await finishStepInputHash(clipEtag, audioEtag, fs.configs?.[fs.idx]);
  return stored === expected;
}
__name(finishArtifactHashMatches, "finishArtifactHashMatches");
async function adoptFinishStepFromR2(env, job, fs, preModules) {
  const modules = preModules ?? await discoverModules(env);
  const expected = finishStepOutputKey(job.project, fs, modules);
  if (!expected)
    return false;
  if (await env.R2_RENDERS.head(expected) === null)
    return false;
  if (!await finishArtifactHashMatches(env, job, fs, expected))
    return false;
  adoptFinishStepOutput(fs, expected, finishStepAppliedTag(fs, modules));
  return true;
}
__name(adoptFinishStepFromR2, "adoptFinishStepFromR2");
async function advanceFinishPhase(env, job, preModules) {
  const envRec = env;
  const failOrRetry = /* @__PURE__ */ __name((fs, error, keepPoll) => {
    const d = classifyFinishRetry(error, fs.attempts ?? 0);
    if (d.action === "retry") {
      fs.attempts = d.attempts;
      fs.error = `finish ${fs.chain[fs.idx]} transient (attempt ${d.attempts}/${FINISH_STEP_MAX_ATTEMPTS}), retrying: ${error ?? ""}`;
      if (!keepPoll)
        fs.poll = void 0;
    } else {
      fs.status = "failed";
      fs.error = error;
    }
  }, "failOrRetry");
  for (const fs of job.finish_shots || []) {
    if (fs.status !== "pending")
      continue;
    const fetcher = resolveFetcher(envRec, fs.chain[fs.idx]);
    if (!fetcher) {
      fs.status = "failed";
      fs.error = `finish module ${fs.chain[fs.idx]} not bound`;
      continue;
    }
    const req = {
      hook: "finish",
      input: { shot_id: fs.shot_id, clip_key: fs.clip_key, audio_key: job.dialogue_audio?.[fs.shot_id] },
      config: fs.configs?.[fs.idx] ?? {},
      // validated per-module config (issue #75); {} only for legacy jobs
      context: { project: job.project, job_id: job.film_id }
    };
    if (!fs.poll) {
      const [clipEtag, audioEtag] = await Promise.all([
        headEtag2(env, fs.clip_key),
        headEtag2(env, job.dialogue_audio?.[fs.shot_id])
      ]);
      req.input.output_hash = await finishStepInputHash(clipEtag, audioEtag, fs.configs?.[fs.idx]);
      const r = await invokeModule(fetcher, req);
      if (!r.ok) {
        failOrRetry(fs, r.error, false);
      } else if (r.pending) {
        fs.poll = r.poll;
      } else if ("output" in r) {
        const v = hookOutputViolation(fs.chain[fs.idx], "finish", r.output);
        if (v) {
          fs.status = "failed";
          fs.error = v;
        } else {
          applyFinishOutput(fs, r.output);
        }
      } else {
        fs.status = "failed";
        fs.error = "finish module returned neither output nor a poll token";
      }
    } else {
      const p = await pollModule(fetcher, { poll: fs.poll });
      if (p.ok && !p.pending) {
        const out = p.output;
        const v = hookOutputViolation(fs.chain[fs.idx], "finish", out);
        if (v) {
          fs.status = "failed";
          fs.error = v;
        } else {
          applyFinishOutput(fs, out);
        }
      } else if (!p.ok && classifyFinishFailure(p.error) === "transient") {
        failOrRetry(fs, p.error, true);
      } else if (!await adoptFinishStepFromR2(env, job, fs, preModules)) {
        if (!p.ok)
          failOrRetry(fs, p.error, true);
      }
    }
  }
  const finishShots = job.finish_shots || [];
  if (finishShots.some(finishShotAdoptableFromR2)) {
    const present = await listClipsByShotId(env, job.project, finishShots.map((fs) => fs.shot_id), finishedClipFileMatchesShot);
    const verified = /* @__PURE__ */ new Map();
    for (const fs of finishShots) {
      if (!finishShotAdoptableFromR2(fs))
        continue;
      const key = present.get(fs.shot_id);
      if (key && await finishArtifactHashMatches(env, job, fs, key))
        verified.set(fs.shot_id, key);
    }
    reclaimFinishShotsFromR2(finishShots, verified, preModules);
  }
  for (const fs of finishShots) {
    if (fs.status === "done" && !finishShotLedgerReconciles(fs)) {
      console.warn(`film ${job.film_id}: finish shot ${fs.shot_id} ledger does NOT reconcile to its chain [${fs.chain.join(", ")}] (ledger ${(fs.ledger ?? []).length}/${fs.chain.length}); applied=${JSON.stringify(fs.applied)} adopted=${JSON.stringify(fs.adopted ?? [])} (#662)`);
    }
  }
  if (finishShots.every((fs) => fs.status !== "pending")) {
    const failed = finishShots.filter((fs) => fs.status === "failed");
    if (failed.length) {
      job.phase = "failed";
      job.error = `finish failed for ${failed.length} shot(s): ` + failed.map((fs) => `${fs.shot_id} at ${fs.chain[fs.idx] ?? "?"} (${fs.error ?? "no error"})`).join("; ");
      return;
    }
    job.phase = job.clips_only ? "done" : "assemble";
  }
}
__name(advanceFinishPhase, "advanceFinishPhase");
async function callVideoFinish(env, payload, opts = {}) {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  };
  const vpc = asFetcher(env.VIDEO_FINISH_VPC);
  if (!vpc)
    return null;
  let resp = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await vpc.fetch("http://video-finish/finish", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504)
      return resp;
    if (attempt < retries - 1)
      await new Promise((r) => setTimeout(r, backoffMs));
  }
  return resp;
}
__name(callVideoFinish, "callVideoFinish");
async function callAudioMix(env, payload, opts = {}) {
  const mix = asFetcher(env.AUDIO_MIX_VPC);
  if (!mix)
    return null;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  let resp = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await mix.fetch("http://audio-mix/mix", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504)
      return resp;
    if (attempt < retries - 1)
      await new Promise((r) => setTimeout(r, backoffMs));
  }
  return resp;
}
__name(callAudioMix, "callAudioMix");
function shouldMultiTrackMix(job, env) {
  const hasDialogue = !!job.dialogue_audio && Object.keys(job.dialogue_audio).length > 0;
  return hasDialogue && !!job.audio_key && !!job.silent_film_key && !!env.AUDIO_MIX_VPC;
}
__name(shouldMultiTrackMix, "shouldMultiTrackMix");
async function mixFilmAudio(env, job, videoKey, bedKey) {
  const mixKey = job.mix_audio_key ?? videoKey.replace(/\.mp4$/i, "") + "-mix-" + crypto.randomUUID().slice(0, 8) + ".mp3";
  job.mix_audio_key = mixKey;
  const [dialogueUrl, musicUrl, outputUrl] = await Promise.all([
    presignR2Get(env, videoKey, 1800),
    presignR2Get(env, bedKey, 1800),
    presignR2Put(env, mixKey, 1800)
  ]);
  const resp = await callAudioMix(env, {
    tracks: [
      { url: dialogueUrl, role: "dialogue", gainDb: 0 },
      { url: musicUrl, role: "music", gainDb: 0 }
    ],
    outputUrl,
    outputKey: mixKey,
    format: "mp3",
    loudnessTargetLufs: -14
  });
  if (!resp || !resp.ok) {
    console.warn(`film ${job.film_id}: audio-mix unreachable/${resp ? resp.status : "null"}; degrading to single-track mux (#231)`);
    return null;
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    console.warn(`film ${job.film_id}: audio-mix returned non-JSON; degrading to single-track mux`);
    return null;
  }
  if (!body.ok || !body.key) {
    console.warn(`film ${job.film_id}: audio-mix not ok (${body.error ?? "no key"}); degrading to single-track mux`);
    return null;
  }
  return mixKey;
}
__name(mixFilmAudio, "mixFilmAudio");
var MAX_ASSEMBLE_ATTEMPTS = 6;
var FILM_FINISH_INFLIGHT_WINDOW_SECONDS = 1200;
async function fireNotify(env, job, preModules) {
  if (!job.film_key)
    return;
  try {
    const envRec = env;
    const notifiers = servingForHook(preModules ?? await discoverModules(envRec), "notify");
    if (!notifiers.length)
      return;
    const download_url = await presignR2Get(env, job.film_key, FILM_DOWNLOAD_TTL_SECONDS);
    const input = {
      event: "render.complete",
      film_id: job.film_id,
      project: job.project,
      download_url
    };
    const context = { project: job.project, job_id: job.film_id };
    for (const m of notifiers) {
      const fetcher = resolveFetcher(envRec, m.binding);
      if (!fetcher)
        continue;
      try {
        const installConfig = await loadInstallConfig(env, m.name, m.config_schema);
        await invokeModule(fetcher, {
          hook: "notify",
          input,
          config: validateConfig(m.config_schema ?? {}, installConfig),
          context
        });
      } catch {
      }
    }
  } catch (e) {
    console.warn(`notify chain failed for ${job.film_id}: ${e.message}`);
  }
}
__name(fireNotify, "fireNotify");
async function transitionToDone(env, job, preModules) {
  let complete = true;
  try {
    complete = await applyFilmFinish(env, job, preModules);
  } catch (e) {
    const msg = e.message;
    job.film_finish = {
      applied: job.film_finish?.applied ?? [],
      errors: [...job.film_finish?.errors ?? [], `film.finish threw: ${msg}`],
      steps: job.film_finish?.steps,
      degraded: job.film_finish?.degraded ?? `threw: ${msg}`
    };
    console.warn(`film.finish failed for ${job.film_id}: ${msg}; keeping the original film`);
    complete = true;
  }
  if (!complete)
    return;
  job.phase = "done";
  let filmKey2 = resolveFilmOutputKey(job);
  if (!filmKey2 && !job.keyframes_only) {
    const adopted = await adoptFilmOutputKeyFromStore(env, job.film_id);
    if (adopted) {
      filmKey2 = adopted;
      if (!job.film_key)
        job.film_key = adopted;
    }
  }
  if (filmKey2) {
    const mode = job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full");
    const out = { output_key: filmKey2, project: job.project, mode };
    if (job.film_finish?.sidecar_key)
      out.sidecar_key = job.film_finish.sidecar_key;
    if (job.finish_unavailable) {
      out.finish_unavailable = {
        at: job.finish_unavailable.at,
        reason: job.finish_unavailable.reason,
        delivered: job.finish_unavailable.delivered
      };
    }
    try {
      await markFinishDone(env, job.film_id, filmKey2, JSON.stringify(out));
    } catch (e) {
      console.warn(`render row finalize failed for ${job.film_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await fireNotify(env, job, preModules);
}
__name(transitionToDone, "transitionToDone");
var FILM_FINISH_STEP_MAX_ATTEMPTS = 3;
var FILM_FINISH_ASYNC_PRESIGN_TTL_SECONDS = 7200;
async function filmFinishSeed(env, input, inKey, outKey, captions, ttl = 1800) {
  const sidecarKey = outKey.replace(/\.mp4$/i, "") + ".srt";
  const [videoUrl, outputUrl, sidecarUrl] = await Promise.all([
    presignR2Get(env, inKey, ttl),
    presignR2Put(env, outKey, ttl),
    presignR2Put(env, sidecarKey, ttl)
  ]);
  return {
    film_key: inKey,
    video_url: videoUrl,
    output_url: outputUrl,
    output_key: outKey,
    title: input.film_titles?.title,
    credits: input.film_titles?.credits,
    captions,
    sidecar_url: sidecarUrl,
    sidecar_key: sidecarKey
  };
}
__name(filmFinishSeed, "filmFinishSeed");
async function runFilmFinishStep(env, input, module, inKey, outKey, captions) {
  const envRec = env;
  const seed = await filmFinishSeed(env, input, inKey, outKey, captions);
  const result = await dispatchChain(envRec, [module], "film.finish", seed, { project: input.project, job_id: input.job_id }, {
    nextInput: /* @__PURE__ */ __name(async (prev) => prev, "nextInput"),
    configFor: /* @__PURE__ */ __name((name) => input.film_finish_config?.[name], "configFor")
  });
  const degradeParts = [...result.degraded];
  let out = result.output;
  if (out !== null) {
    const v = hookOutputViolation(module.name, "film.finish", out);
    if (v) {
      degradeParts.push(v);
      out = null;
    }
  }
  const degraded = degradeParts.length > 0 ? degradeParts.join("; ") : void 0;
  const film_key = typeof out?.film_key === "string" && out.film_key.length > 0 ? out.film_key : inKey;
  const prepend_seconds = typeof out?.prepend_seconds === "number" && Number.isFinite(out.prepend_seconds) && out.prepend_seconds > 0 ? out.prepend_seconds : void 0;
  return { film_key, applied: result.applied, errors: result.errors, steps: out?.applied, degraded, prepend_seconds };
}
__name(runFilmFinishStep, "runFilmFinishStep");
async function finalizeSidecar(env, base, finalFilmKey, stepCount, prepends, captions) {
  if (!(captions ?? []).some((c) => typeof c.text === "string" && c.text.trim().length > 0))
    return void 0;
  let rawKey;
  let rawIndex = -1;
  for (let n = 0; n < stepCount; n++) {
    const k = `${base}-ff${n}.srt`;
    if (await r2ObjectExists(env, k)) {
      rawKey = k;
      rawIndex = n;
      break;
    }
  }
  if (!rawKey)
    return void 0;
  const finalKey = finalFilmKey.replace(/\.mp4$/i, "") + ".srt";
  if (finalKey === rawKey)
    return rawKey;
  let shift = 0;
  for (let n = rawIndex + 1; n < stepCount; n++) {
    const sec = prepends[`${base}-ff${n}.mp4`];
    if (typeof sec === "number" && sec > 0)
      shift += sec;
  }
  const obj = await env.R2_RENDERS.get(rawKey);
  if (!obj)
    return void 0;
  const rawText = await obj.text();
  const finalText = shift > 0 ? retimeSrt(rawText, shift) : rawText;
  await env.R2_RENDERS.put(finalKey, finalText, { httpMetadata: { contentType: "application/x-subrip; charset=utf-8" } });
  return finalKey;
}
__name(finalizeSidecar, "finalizeSidecar");
async function runFilmFinish(env, input, preModules, opts) {
  const envRec = env;
  const modules = preModules ?? await discoverModules(envRec);
  const steps = servingForHook(modules, "film.finish");
  if (steps.length === 0) {
    return { ran: false, film_key: input.film_key, applied: [], adopted: [], errors: [], complete: true };
  }
  const bundleDurations = await readShotDurationsFromBundle(env, input.bundle_key);
  const durations = captionDurations(bundleDurations, input.actual_durations);
  const captions = buildCaptionCues(input.scenes, input.dialogue_lines ?? [], durations);
  const base = input.film_key.replace(/\.mp4$/i, "");
  let curKey = input.film_key;
  const applied = [];
  const adopted = [];
  const errors = [];
  const degradeParts = [];
  let lastSteps;
  const now = opts?.now ?? Date.now();
  const asyncDrive = !!opts?.persistPoll;
  let complete = true;
  const prepends = opts?.prepends ?? {};
  const recordPrepend = /* @__PURE__ */ __name(async (key, seconds) => {
    prepends[key] = seconds;
    await opts?.persistPrepend?.(key, seconds);
  }, "recordPrepend");
  const softDegradeStep = /* @__PURE__ */ __name(async (outKey, reason) => {
    errors.push(reason);
    degradeParts.push(reason);
    if (opts?.dispatched)
      delete opts.dispatched[outKey];
    if (asyncDrive)
      await opts.persistPoll(outKey, null);
  }, "softDegradeStep");
  const foldOutput = /* @__PURE__ */ __name(async (module, out, outKey) => {
    if (hookOutputViolation(module.name, "film.finish", out))
      return false;
    applied.push(module.name);
    if (Array.isArray(out.applied))
      lastSteps = out.applied;
    if (typeof out.degraded === "string" && out.degraded.length > 0)
      degradeParts.push(`${module.name}: ${out.degraded}`);
    curKey = typeof out.film_key === "string" && out.film_key.length > 0 ? out.film_key : outKey;
    const pp = typeof out.prepend_seconds === "number" && Number.isFinite(out.prepend_seconds) && out.prepend_seconds > 0 ? out.prepend_seconds : 0;
    if (pp > 0)
      await recordPrepend(outKey, pp);
    return true;
  }, "foldOutput");
  for (let n = 0; n < steps.length; n++) {
    const module = steps[n];
    const outKey = base + "-ff" + n + ".mp4";
    if (await r2ObjectExists(env, outKey)) {
      adopted.push(module.name);
      curKey = outKey;
      if (opts?.polls)
        delete opts.polls[outKey];
      if (opts?.dispatched)
        delete opts.dispatched[outKey];
      if (opts?.attempts)
        delete opts.attempts[outKey];
      continue;
    }
    if (!asyncDrive) {
      const lastTs2 = opts?.dispatched?.[outKey];
      if (lastTs2 !== void 0 && now - lastTs2 < FILM_FINISH_INFLIGHT_WINDOW_SECONDS * 1e3) {
        complete = false;
        break;
      }
      await opts?.persistDispatch?.(outKey, now);
      const r2 = await runFilmFinishStep(env, input, module, curKey, outKey, captions);
      if (opts?.dispatched)
        delete opts.dispatched[outKey];
      errors.push(...r2.errors);
      applied.push(...r2.applied);
      if (r2.steps)
        lastSteps = r2.steps;
      if (r2.degraded)
        degradeParts.push(r2.degraded);
      curKey = r2.film_key;
      if (r2.prepend_seconds && r2.prepend_seconds > 0)
        await recordPrepend(outKey, r2.prepend_seconds);
      continue;
    }
    const fetcher = resolveFetcher(envRec, module.binding);
    if (!fetcher) {
      await softDegradeStep(outKey, `${module.name}: not reachable`);
      continue;
    }
    const config = validateConfig(module.config_schema, input.film_finish_config?.[module.name]);
    const context = { project: input.project, job_id: input.job_id };
    const token = opts?.polls?.[outKey];
    if (token) {
      const p = await pollModule(fetcher, { poll: token });
      if (p.ok && !p.pending) {
        const out = p.output;
        if (!await foldOutput(module, out, outKey)) {
          await softDegradeStep(outKey, `${module.name}: ${hookOutputViolation(module.name, "film.finish", out)}`);
          continue;
        }
        if (opts?.dispatched)
          delete opts.dispatched[outKey];
        if (opts?.attempts)
          delete opts.attempts[outKey];
        await opts.persistPoll(outKey, null);
        continue;
      }
      if (p.ok) {
        complete = false;
        break;
      }
      const attempts = (opts?.attempts?.[outKey] ?? 0) + 1;
      if (opts?.attempts)
        opts.attempts[outKey] = attempts;
      if (opts?.dispatched)
        delete opts.dispatched[outKey];
      await opts.persistPoll(outKey, null);
      if (attempts >= FILM_FINISH_STEP_MAX_ATTEMPTS) {
        await softDegradeStep(outKey, `${module.name}: ${p.error} (after ${attempts} attempts)`);
        continue;
      }
      complete = false;
      break;
    }
    const lastTs = opts?.dispatched?.[outKey];
    if (lastTs !== void 0 && now - lastTs < FILM_FINISH_INFLIGHT_WINDOW_SECONDS * 1e3) {
      complete = false;
      break;
    }
    await opts?.persistDispatch?.(outKey, now);
    const seed = await filmFinishSeed(env, input, curKey, outKey, captions, FILM_FINISH_ASYNC_PRESIGN_TTL_SECONDS);
    const r = await invokeModule(fetcher, { hook: "film.finish", input: seed, config, context });
    if (r.ok && r.pending) {
      await opts.persistPoll(outKey, r.poll);
      if (opts?.dispatched)
        delete opts.dispatched[outKey];
      complete = false;
      break;
    }
    if (opts?.dispatched)
      delete opts.dispatched[outKey];
    if (r.ok && "output" in r) {
      const out = r.output;
      if (!await foldOutput(module, out, outKey))
        await softDegradeStep(outKey, `${module.name}: ${hookOutputViolation(module.name, "film.finish", out)}`);
      continue;
    }
    await softDegradeStep(outKey, `${module.name}: ${r.error ?? "invoke failed"}`);
  }
  const degraded = degradeParts.length > 0 ? degradeParts.join("; ") : void 0;
  const sidecar_key = complete ? await finalizeSidecar(env, base, curKey, steps.length, prepends, captions) : void 0;
  return { ran: true, film_key: curKey, applied, adopted, errors, steps: lastSteps, degraded, complete, sidecar_key };
}
__name(runFilmFinish, "runFilmFinish");
async function applyFilmFinish(env, job, preModules) {
  if (!job.film_key)
    return true;
  job.film_finish_dispatched ??= {};
  job.film_finish_polls ??= {};
  job.film_finish_attempts ??= {};
  job.film_finish_prepend ??= {};
  const r = await runFilmFinish(env, {
    film_key: job.film_key,
    scenes: job.scenes,
    dialogue_lines: job.dialogue_lines,
    film_titles: job.film_titles,
    film_finish_config: job.film_finish_config,
    bundle_key: job.bundle_key,
    project: job.project,
    job_id: job.film_id,
    actual_durations: job.actual_clip_durations
  }, preModules, {
    dispatched: job.film_finish_dispatched,
    persistDispatch: /* @__PURE__ */ __name(async (key, ts) => {
      job.film_finish_dispatched[key] = ts;
      await putFilm(env, job);
    }, "persistDispatch"),
    // #602 async job+poll: persist the per-step module poll token + terminal-failure count so submit and
    // poll span ticks (a long single step no longer re-burns each tick). null token => forget the step.
    polls: job.film_finish_polls,
    attempts: job.film_finish_attempts,
    persistPoll: /* @__PURE__ */ __name(async (key, token) => {
      if (token === null)
        delete job.film_finish_polls[key];
      else
        job.film_finish_polls[key] = token;
      await putFilm(env, job);
    }, "persistPoll"),
    // #663: persist title-card prepend offsets so the post-chain .srt re-time recovers them even when the
    // prepending step is adopted (not re-folded) on a later poll tick.
    prepends: job.film_finish_prepend,
    persistPrepend: /* @__PURE__ */ __name(async (key, seconds) => {
      job.film_finish_prepend[key] = seconds;
      await putFilm(env, job);
    }, "persistPrepend")
  });
  if (!r.ran)
    return true;
  if (r.errors.length > 0) {
    console.warn(`film.finish errors for ${job.film_id}: ${r.errors.join("; ")}`);
  }
  if (r.degraded) {
    console.warn(`film.finish degraded for ${job.film_id}: ${r.degraded} -- film shipped WITHOUT cards`);
  }
  if (r.adopted.length > 0) {
    console.log(`film.finish adopted ${r.adopted.length} completed step(s) from R2 for ${job.film_id}: ${r.adopted.join(", ")}`);
  }
  job.film_finish = { applied: r.applied, adopted: r.adopted, errors: r.errors, steps: r.steps, degraded: r.degraded, sidecar_key: r.sidecar_key };
  if (r.complete)
    job.film_key = r.film_key;
  return r.complete;
}
__name(applyFilmFinish, "applyFilmFinish");
function emitFinishUnavailable(job) {
  const u = job.finish_unavailable;
  if (!u)
    return;
  emitStructuredEvent({
    ev: "film.finish_unavailable",
    film_id: job.film_id,
    project: job.project,
    at: u.at,
    delivered: u.delivered,
    clips: u.clips?.length ?? 0,
    reason: u.reason
  });
}
__name(emitFinishUnavailable, "emitFinishUnavailable");
function emitKeyframesIncomplete(job) {
  const k = job.keyframes_incomplete;
  if (!k)
    return;
  emitStructuredEvent({
    ev: "film.keyframes_incomplete",
    film_id: job.film_id,
    project: job.project,
    adopted: k.adopted,
    expected: k.expected,
    dropped: k.dropped
  });
}
__name(emitKeyframesIncomplete, "emitKeyframesIncomplete");
function degradeAssembleUnavailable(job, finalClips, reason) {
  job.finish_unavailable = { at: "assemble", reason, delivered: "clips", clips: finalClips };
  job.assemble_attempts = 0;
  emitFinishUnavailable(job);
  job.phase = "done";
}
__name(degradeAssembleUnavailable, "degradeAssembleUnavailable");
async function degradeMuxUnavailable(env, job, silentKey, reason, preModules) {
  job.finish_unavailable = { at: "mux", reason, delivered: "silent_film" };
  job.mux_attempts = 0;
  emitFinishUnavailable(job);
  job.film_key = silentKey;
  await transitionToDone(env, job, preModules);
}
__name(degradeMuxUnavailable, "degradeMuxUnavailable");
async function enterMuxPhase(env, job, preModules) {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    await transitionToDone(env, job, preModules);
    return;
  }
  if (!env.VIDEO_FINISH_VPC) {
    await degradeMuxUnavailable(env, job, silentKey, "video-finish tier not installed (VIDEO_FINISH_VPC unbound); shipped silent film", preModules);
    return;
  }
  const outKey = job.mux_output_key ?? silentKey.replace(/\.mp4$/i, "") + "-audio-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  job.mux_output_key = outKey;
  let audioToMux = audioKey;
  if (shouldMultiTrackMix(job, env)) {
    const mixed = await mixFilmAudio(env, job, silentKey, audioKey);
    if (mixed)
      audioToMux = mixed;
  }
  const [videoUrl, audioUrl, outputUrl] = await Promise.all([
    presignR2Get(env, silentKey, 1800),
    presignR2Get(env, audioToMux, 1800),
    presignR2Put(env, outKey, 1800)
  ]);
  const resp = await callVideoFinish(env, {
    clips: [{ url: videoUrl }],
    outputUrl,
    outputKey: outKey,
    audioUrl,
    remuxAudioOnly: true
  });
  const transport = classifyAssembleTransport(resp ? resp.status : null, job.mux_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  job.mux_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "mux";
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    await degradeMuxUnavailable(env, job, silentKey, transport.error, preModules);
    return;
  }
  if (!resp) {
    await degradeMuxUnavailable(env, job, silentKey, "video-finish container unreachable; shipped silent film", preModules);
    return;
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 400);
    } catch {
    }
    job.phase = "failed";
    job.error = `video-finish mux returned ${resp.status}${detail ? `: ${detail}` : ""}`;
    return;
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    job.phase = "failed";
    job.error = "video-finish returned a non-JSON response";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish mux failed: ${body.error || "unknown error"}`;
    return;
  }
  if (body.hasAudio === false) {
    await degradeMuxUnavailable(env, job, silentKey, "video-finish could not attach the audio bed (the bed exceeded the container audio cap or was undecodable); shipped silent film", preModules);
    return;
  }
  job.film_key = outKey;
  await transitionToDone(env, job, preModules);
}
__name(enterMuxPhase, "enterMuxPhase");
async function enterMasterOrMux(env, job, preModules) {
  const envRec = env;
  const serving = servingForHook(preModules ?? await discoverModules(envRec), "master");
  const chain = serving.map((mod) => mod.binding);
  if (!chain.length) {
    job.phase = "mux";
    await enterMuxPhase(env, job, preModules);
    return;
  }
  const configs = resolveFinishConfigs(serving, job.master_config ?? {});
  job.master = { chain, idx: 0, applied: [], degraded: [], configs };
  job.phase = "master";
  await advanceMasterPhase(env, job, preModules);
}
__name(enterMasterOrMux, "enterMasterOrMux");
async function advanceMasterPhase(env, job, preModules) {
  const m = job.master;
  if (!m || !job.audio_key) {
    job.phase = "mux";
    await enterMuxPhase(env, job, preModules);
    return;
  }
  const envRec = env;
  const seconds = filmSeconds(job);
  if (m.poll && phaseAgeSeconds(job) >= MASTER_STALL_SECONDS) {
    console.warn(`film ${job.film_id}: master step ${m.chain[m.idx]} stalled; passing the bed through`);
    degradeMasterStep(m, "stalled");
  }
  while (!masterChainDone(m)) {
    const fetcher = resolveFetcher(envRec, m.chain[m.idx]);
    if (!fetcher) {
      degradeMasterStep(m, "module not bound");
      continue;
    }
    if (!m.poll) {
      const audioKey = job.audio_key;
      const cfg = m.configs?.[m.idx] ?? {};
      const format = cfg.format === "mp3" ? "mp3" : "wav";
      const outputKey = masteredBedKey(audioKey, format);
      const [audioUrl, outputUrl] = await Promise.all([
        presignR2Get(env, audioKey, 1800),
        // 30min: covers a multi-minute CPU master
        presignR2Put(env, outputKey, 1800)
      ]);
      const req = {
        hook: "master",
        input: {
          film_id: job.film_id,
          audio_key: audioKey,
          audio_url: audioUrl,
          output_url: outputUrl,
          output_key: outputKey,
          seconds
        },
        config: cfg,
        context: { project: job.project, job_id: job.film_id }
      };
      const r = await invokeModule(fetcher, req);
      if (!r.ok) {
        const d2 = classifyFinishRetry(r.error, m.attempts ?? 0, MASTER_STEP_MAX_ATTEMPTS);
        if (d2.action === "retry") {
          m.attempts = d2.attempts;
          return;
        }
        degradeMasterStep(m, `invoke failed: ${r.error}`);
        continue;
      }
      if (r.pending) {
        m.poll = r.poll;
        m.attempts = 0;
        return;
      }
      if ("output" in r) {
        const v = hookOutputViolation(m.chain[m.idx], "master", r.output);
        if (v) {
          degradeMasterStep(m, v);
          continue;
        }
        job.audio_key = applyMasterOutput(m, job.audio_key, r.output);
        continue;
      }
      degradeMasterStep(m, "module returned neither output nor a poll token");
      continue;
    }
    const p = await pollModule(fetcher, { poll: m.poll });
    if (p.ok && !p.pending) {
      const out = p.output;
      const v = hookOutputViolation(m.chain[m.idx], "master", out);
      if (v) {
        degradeMasterStep(m, v);
        continue;
      }
      job.audio_key = applyMasterOutput(m, job.audio_key, out);
      continue;
    }
    if (p.ok)
      return;
    const d = classifyFinishRetry(p.error, m.attempts ?? 0, MASTER_STEP_MAX_ATTEMPTS);
    if (d.action === "retry") {
      m.attempts = d.attempts;
      return;
    }
    degradeMasterStep(m, `poll failed: ${p.error}`);
  }
  if (m.degraded.length)
    console.warn(`film ${job.film_id}: master degraded -- ${m.degraded.join("; ")}`);
  job.phase = "mux";
  await enterMuxPhase(env, job, preModules);
}
__name(advanceMasterPhase, "advanceMasterPhase");
async function finishAssembledFilm(env, job, silentKey, preModules) {
  job.silent_film_key = silentKey;
  if (!job.audio_key) {
    job.film_key = silentKey;
    await transitionToDone(env, job, preModules);
    return;
  }
  await enterMasterOrMux(env, job, preModules);
}
__name(finishAssembledFilm, "finishAssembledFilm");
async function enterAssemblePhase(env, job, finalClips, preModules) {
  if (!finalClips.length) {
    job.phase = "failed";
    job.error = "no clips to assemble";
    return;
  }
  const outputKey = defaultFilmOutputKey(job.film_id);
  const durationsGated = !!job.actual_clip_durations && Object.keys(job.actual_clip_durations).length > 0;
  if (durationsGated && await r2ObjectExists(env, outputKey)) {
    job.assemble_attempts = 0;
    await finishAssembledFilm(env, job, outputKey, preModules);
    return;
  }
  if (!env.VIDEO_FINISH_VPC) {
    degradeAssembleUnavailable(job, finalClips, "video-finish tier not installed (VIDEO_FINISH_VPC unbound); delivered per-shot clips");
    return;
  }
  const clips = [];
  for (const c of finalClips) {
    clips.push({ url: await presignR2Get(env, c.clip_key, 1800) });
  }
  const outputUrl = await presignR2Put(env, outputKey, 1800);
  const keepClipAudio = !!job.dialogue_audio && Object.keys(job.dialogue_audio).length > 0;
  const resp = await callVideoFinish(env, { clips, outputUrl, outputKey, keepClipAudio });
  const transport = classifyAssembleTransport(resp ? resp.status : null, job.assemble_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS);
  job.assemble_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "assemble";
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    degradeAssembleUnavailable(job, finalClips, transport.error);
    return;
  }
  if (!resp) {
    degradeAssembleUnavailable(job, finalClips, "video-finish container unreachable; delivered per-shot clips");
    return;
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 400);
    } catch {
    }
    job.phase = "failed";
    job.error = `video-finish container returned ${resp.status}${detail ? `: ${detail}` : ""}`;
    return;
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    job.phase = "failed";
    job.error = "video-finish returned a non-JSON response";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish failed: ${body.error || "unknown error"}`;
    return;
  }
  const actual = mapClipDurationsToShots(finalClips, body.clipDurations);
  job.actual_clip_durations = Object.keys(actual).length > 0 ? actual : void 0;
  if (Object.keys(actual).length > 0) {
    const bundleDurations = await readShotDurationsFromBundle(env, job.bundle_key);
    const planned = resolvePlannedSeconds(job.scenes, bundleDurations);
    const fraction = resolveClipDurationFloor(typeof env.FILM_CLIP_DURATION_FLOOR === "string" ? env.FILM_CLIP_DURATION_FLOOR : void 0);
    const shortfalls = findClipDurationShortfalls(finalClips, actual, planned, fraction);
    if (shortfalls.length > 0) {
      job.phase = "failed";
      job.error = `duration gate: ${shortfalls.length} shot(s) delivered below ${Math.round(fraction * 100)}% of plan: ` + shortfalls.map((sf) => `${sf.shot_id} ${sf.actual.toFixed(2)}s vs planned ${sf.planned.toFixed(2)}s (floor ${sf.floor.toFixed(2)}s)`).join("; ");
      console.warn(`film ${job.film_id}: ${job.error}`);
      return;
    }
  } else {
    console.warn(`film ${job.film_id}: video-finish reported no per-clip durations; duration gate skipped (redeploy video-finish to arm #697)`);
  }
  await finishAssembledFilm(env, job, outputKey, preModules);
}
__name(enterAssemblePhase, "enterAssemblePhase");
async function startFilmFromKeyframes(env, args, preModules) {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const stagedAudio = await resolveStagedAudioKey(env, args.audio_key);
  const { matched, missing } = joinKeyframesToScenes(scenes, args.keyframes || []);
  const job = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project,
    bundle_key: args.bundle_key,
    scenes,
    motion_backend: args.motion_backend ?? null,
    motion_config: args.motion_config ?? {},
    finish_config: args.finish_config ?? {},
    speech_config: args.speech_config ?? {},
    film_finish_config: args.film_finish_config ?? {},
    master_config: args.master_config ?? {},
    keyframe_binding: null,
    phase: "failed",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    derive_mode: args.derive_mode,
    parent_render_id: args.parent_render_id,
    audio_key: stagedAudio
  };
  if (!matched.length) {
    job.error = `no keyframes matched requested shots (missing: ${missing.join(", ")})`;
    await putFilm(env, job);
    return job;
  }
  const shots = [];
  for (const m of matched) {
    const keyframe_url = await presignR2Get(env, m.keyframe_key, 1800);
    shots.push({
      shot_id: m.shot_id,
      keyframe_url,
      keyframe_key: m.keyframe_key,
      prompt: m.prompt,
      seconds: m.seconds,
      motion_backend: args.per_shot_motion?.[m.shot_id]
    });
  }
  const clip = await startClipJob(env, {
    project: args.project,
    shots,
    motion_backend: args.motion_backend,
    config: args.motion_config,
    module_configs: args.motion_configs
  }, preModules);
  job.clip_job_id = clip.job_id;
  job.phase = summarizeJob(clip).failed === clip.shots.length ? "failed" : "clips";
  if (job.phase === "failed")
    job.error = "every clip submission failed";
  await putFilm(env, job);
  return job;
}
__name(startFilmFromKeyframes, "startFilmFromKeyframes");
async function startFilmJob(env, args, preModules) {
  const scenes = coerceSceneIds(args.scenes ?? []);
  const dialogueLines = coerceDialogueLineIds(args.scenes ?? [], args.dialogue_lines);
  const stagedAudio = args.clips_only ? void 0 : await resolveStagedAudioKey(env, args.audio_key);
  const envRec = env;
  const modules = preModules ?? await discoverModules(envRec);
  const motionBackend = normalizeBackendChoice(args.motion_backend);
  const explicitKeyframeChoice = normalizeBackendChoice(args.keyframe_backend);
  const keyframeChoice = coupleLocalGpuKeyframeChoice(modules, motionBackend, explicitKeyframeChoice);
  const pairErr = localGpuKeyframePreflightError(modules, motionBackend, keyframeChoice);
  const kf = pairErr ? null : pickOneForHook(modules, "keyframe", keyframeChoice);
  const job = {
    film_id: "film-" + crypto.randomUUID(),
    project: args.project,
    bundle_key: args.bundle_key,
    scenes,
    motion_backend: motionBackend ?? null,
    motion_config: args.motion_config ?? {},
    keyframe_config: args.keyframe_config ?? {},
    finish_config: args.finish_config ?? {},
    speech_config: args.speech_config ?? {},
    film_finish_config: args.film_finish_config ?? {},
    master_config: args.master_config ?? {},
    keyframes_only: !!args.keyframes_only,
    clips_only: !!args.clips_only,
    audio_key: stagedAudio,
    film_titles: args.film_titles,
    keyframe_binding: kf ? kf.binding : null,
    phase: "keyframe",
    created_at: Date.now(),
    phase_started_at: Date.now(),
    dialogue_lines: dialogueLines && dialogueLines.length ? dialogueLines : void 0,
    cast_loras: args.cast_loras && Object.keys(args.cast_loras).length ? args.cast_loras : void 0,
    // #762: persist the requested quality tier so filmRenderRowSeedFromJob records an honest label.
    quality_tier: args.quality_tier
  };
  const fetcher = kf ? resolveFetcher(envRec, kf.binding) : null;
  if (!kf || !fetcher) {
    job.phase = "failed";
    job.error = pairErr ? pairErr : kf ? `keyframe module ${kf.name} (${kf.binding}) is not bound` : explicitKeyframeChoice ? `keyframe module ${explicitKeyframeChoice} not installed` : "no keyframe module installed";
  } else {
    const config = validateConfig(kf.config_schema, args.keyframe_config);
    const keyframeInput = {
      project: args.project,
      bundle_key: args.bundle_key,
      shot_ids: scenes.map((s) => s.shot_id)
    };
    if (args.pretrained_loras && Object.keys(args.pretrained_loras).length) {
      keyframeInput.pretrained_loras = { ...args.pretrained_loras };
    }
    const r = await invokeModule(fetcher, {
      hook: "keyframe",
      input: keyframeInput,
      config,
      context: { project: args.project, job_id: job.film_id }
    });
    if (!r.ok) {
      job.phase = "failed";
      job.error = r.error;
    } else if (r.pending) {
      job.keyframe_poll = r.poll;
      job.keyframe_job_id = r.jobId;
    } else if ("output" in r) {
      const v = hookOutputViolation(kf.name, "keyframe", r.output);
      if (v) {
        job.phase = "failed";
        job.error = v;
      } else {
        await afterKeyframeOutput(env, job, r.output, modules);
      }
    } else {
      job.phase = "failed";
      job.error = "keyframe module returned neither output nor a poll token";
    }
  }
  await putFilm(env, job);
  return job;
}
__name(startFilmJob, "startFilmJob");
async function cancelFilmJob(env, filmId) {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj)
    return null;
  const job = JSON.parse(await obj.text());
  if (job.phase === "done" || job.phase === "failed")
    return job;
  await cancelInFlightKeyframe(env, job);
  if (job.clip_job_id)
    await cancelInFlightClips(env, job.clip_job_id);
  job.cancelled = true;
  job.phase = "failed";
  job.error = "cancelled";
  await putFilm(env, job);
  return job;
}
__name(cancelFilmJob, "cancelFilmJob");
async function listProjectKeyframes(env, project, scenes, createdAtMs, keyframeConfig) {
  const prefix = `renders/${project}/keyframes/`;
  const wanted = new Set(scenes.map((s) => s.shot_id));
  const expected = keyframeConfig !== void 0 ? await keyframeProvenanceHash({ keyframe_config: keyframeConfig }) : null;
  const out = [];
  let cursor;
  do {
    const listed = await env.R2_RENDERS.list({ prefix, cursor, limit: 1e3 });
    for (const o of listed.objects) {
      if (createdAtMs && (!o.uploaded || o.uploaded.getTime() < createdAtMs))
        continue;
      const file = o.key.slice(prefix.length);
      if (!/\.(png|jpe?g|webp)$/i.test(file))
        continue;
      const shot_id = file.replace(/\.[^.]+$/, "");
      if (!shot_id || !wanted.has(shot_id))
        continue;
      if (expected !== null && await provVerdict(env, o.key, expected) === "mismatch")
        continue;
      out.push({ shot_id, keyframe_key: o.key });
    }
    cursor = listed.truncated ? listed.cursor : void 0;
  } while (cursor);
  const seen = /* @__PURE__ */ new Set();
  return out.filter((k) => seen.has(k.shot_id) ? false : (seen.add(k.shot_id), true));
}
__name(listProjectKeyframes, "listProjectKeyframes");
async function keyframeSetCompleteInR2(env, job) {
  if (!job.scenes.length)
    return false;
  const present = await listProjectKeyframes(env, job.project, job.scenes, job.created_at, job.keyframe_config);
  const have = new Set(present.map((k) => k.shot_id));
  return job.scenes.every((s) => have.has(s.shot_id));
}
__name(keyframeSetCompleteInR2, "keyframeSetCompleteInR2");
async function cancelInFlightKeyframe(env, job) {
  if (job.phase !== "keyframe" || !job.keyframe_poll || !job.keyframe_binding)
    return;
  const poll = job.keyframe_poll;
  const jobId = job.keyframe_job_id ?? "(job id unknown)";
  const envRec = env;
  const modules = await discoverModules(envRec);
  const kf = modules.find((m) => m.binding === job.keyframe_binding) ?? null;
  const fetcher = kf ? resolveFetcher(envRec, kf.binding) : null;
  if (!kf || !fetcher) {
    console.warn(`film ${job.film_id}: cannot cancel in-flight keyframe job -- module ${job.keyframe_binding} not bound; RunPod job ${jobId} left running (ORPHAN) (#327)`);
    return;
  }
  if (!kf.cancelable) {
    console.warn(`film ${job.film_id}: keyframe module ${kf.name} has no cancel primitive (cancelable=false) -- RunPod job ${jobId} left running (ORPHAN) (#327)`);
    return;
  }
  const r = await cancelModule(fetcher, { poll });
  if (r.ok) {
    console.warn(`film ${job.film_id}: cancelled in-flight keyframe RunPod job ${jobId} via ${kf.name} (#327)`);
  } else {
    console.warn(`film ${job.film_id}: keyframe cancel FAILED (${r.error}) -- RunPod job ${jobId} left running (ORPHAN) (#327)`);
  }
}
__name(cancelInFlightKeyframe, "cancelInFlightKeyframe");
async function recoverStalledKeyframePhase(env, job, preModules, atCeiling) {
  const adopted = await listProjectKeyframes(env, job.project, job.scenes, job.created_at, job.keyframe_config);
  if (!adopted.length)
    return false;
  const covered = new Set(adopted.map((k) => k.shot_id));
  const dropped = job.scenes.filter((s) => !covered.has(s.shot_id)).map((s) => s.shot_id);
  if (dropped.length && !atCeiling) {
    console.warn(`film ${job.film_id}: keyframe poll stale with a PARTIAL set (${adopted.length}/${job.scenes.length} in R2; missing ${dropped.join(", ")}); holding, not advancing (#619)`);
    return false;
  }
  if (dropped.length) {
    job.keyframes_incomplete = { adopted: adopted.length, expected: job.scenes.length, dropped };
    emitKeyframesIncomplete(job);
    console.warn(`film ${job.film_id}: keyframe phase hit the ceiling with only ${adopted.length}/${job.scenes.length} keyframes; delivering the rendered scenes, dropped ${dropped.join(", ")} (#619)`);
  } else {
    console.warn(`film ${job.film_id}: keyframe poll stale, adopting the full set of ${adopted.length} keyframes from R2 (#129)`);
  }
  await cancelInFlightKeyframe(env, job);
  job.keyframe_recovered = true;
  job.keyframe_poll = void 0;
  await afterKeyframeOutput(env, job, { project: job.project, keyframes: adopted }, preModules);
  return true;
}
__name(recoverStalledKeyframePhase, "recoverStalledKeyframePhase");
async function recoverStalledClipsPhase(env, job, preModules) {
  if (!job.clip_job_id)
    return false;
  const cjObj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
  if (!cjObj)
    return false;
  const clipJob = JSON.parse(await cjObj.text());
  const adopted = await reclaimClipsFromR2(env, clipJob);
  if (adopted) {
    await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
    console.warn(`film ${job.film_id}: clips poll stale, adopted ${adopted} orphaned clips from R2 this pass (#143)`);
  }
  if (!summarizeJob(clipJob).complete)
    return false;
  job.clips_recovered = true;
  await enterFinishPhase(env, job, clipJob, preModules);
  return true;
}
__name(recoverStalledClipsPhase, "recoverStalledClipsPhase");
async function recoverStalledPhase(env, job, preModules, now = Date.now()) {
  if (!POLLABLE_PHASES.has(job.phase))
    return false;
  const age = phaseAgeSeconds(job, now);
  if (job.phase === "keyframe" && !job.keyframe_recovered && age >= KEYFRAME_STALL_SECONDS) {
    if (await recoverStalledKeyframePhase(env, job, preModules, age >= PHASE_HARD_DEADLINE_SECONDS))
      return true;
  }
  if (job.phase === "clips" && age >= KEYFRAME_STALL_SECONDS) {
    if (await recoverStalledClipsPhase(env, job, preModules))
      return true;
  }
  const ceilingAge = ceilingAgeSeconds(job, now);
  if (ceilingAge >= PHASE_HARD_DEADLINE_SECONDS) {
    const stuckPhase = job.phase;
    job.phase = "failed";
    job.error = `render stalled in phase "${stuckPhase}" for ${Math.floor(ceilingAge / 60)}min with no progress; failing so it does not hang (resubmit to retry) (#129/#704)`;
    return true;
  }
  return false;
}
__name(recoverStalledPhase, "recoverStalledPhase");
async function readFilmJobReadOnly(env, filmId) {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj)
    return null;
  const job = JSON.parse(await obj.text());
  let clipJob = null;
  if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
    if (cj)
      clipJob = JSON.parse(await cj.text());
  }
  return { job, clipJob };
}
__name(readFilmJobReadOnly, "readFilmJobReadOnly");
async function claimAdvanceOrFailOpen(env, filmId) {
  if (!env.DB)
    return { won: true };
  try {
    return await claimFilmAdvance(env, filmId);
  } catch (e) {
    console.warn(`film ${filmId}: advance lease unavailable (${e.message}); advancing unguarded`);
    return { won: true };
  }
}
__name(claimAdvanceOrFailOpen, "claimAdvanceOrFailOpen");
async function persistFilmJobFailed(env, filmId, error) {
  try {
    const obj = await env.R2_RENDERS.get(filmKey(filmId));
    if (!obj)
      return null;
    const job = JSON.parse(await obj.text());
    if (job.phase === "done" || job.phase === "failed")
      return job;
    job.phase = "failed";
    job.error = error.slice(0, 2e3);
    await putFilm(env, job);
    return job;
  } catch {
    return null;
  }
}
__name(persistFilmJobFailed, "persistFilmJobFailed");
async function advanceFilmJob(env, filmId) {
  const claim = await claimAdvanceOrFailOpen(env, filmId);
  if (!claim.won)
    return readFilmJobReadOnly(env, filmId);
  try {
    return await advanceFilmJobLocked(env, filmId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof SyntaxError) {
      console.error(JSON.stringify({ ev: "film.doc_corrupt", film_id: filmId, error: msg }));
      await markRenderFailedByJobId(env, filmId, `job doc corrupt/unparseable: ${msg}`);
      return null;
    }
    const error = `advance failed: ${msg}`;
    console.error(JSON.stringify({ ev: "film.advance_failed", film_id: filmId, error: msg }));
    const job = await persistFilmJobFailed(env, filmId, error);
    await markRenderFailedByJobId(env, filmId, error);
    return job ? { job, clipJob: null } : null;
  } finally {
    if (claim.token !== void 0) {
      try {
        await releaseFilmAdvance(env, filmId, claim.token);
      } catch (e) {
        console.warn(`film ${filmId}: advance lease release failed (${e.message}); it expires on its own`);
      }
    }
  }
}
__name(advanceFilmJob, "advanceFilmJob");
async function advanceFilmJobLocked(env, filmId) {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj)
    return null;
  const job = JSON.parse(await obj.text());
  if (job.cancelled)
    return { job, clipJob: null };
  const envRec = env;
  const entryPhase = job.phase;
  const modules = await discoverModules(envRec);
  await recoverStalledPhase(env, job, modules);
  if (job.phase === "keyframe" && job.keyframe_poll) {
    const fetcher = job.keyframe_binding ? resolveFetcher(envRec, job.keyframe_binding) : null;
    if (!fetcher) {
      job.phase = "failed";
      job.error = "keyframe module no longer bound";
    } else {
      const p = await pollModule(fetcher, { poll: job.keyframe_poll });
      if (!p.ok) {
        job.phase = "failed";
        job.error = p.error;
      } else if (!p.pending) {
        const out = p.output;
        const v = hookOutputViolation(job.keyframe_binding ?? "keyframe", "keyframe", out);
        if (v) {
          job.phase = "failed";
          job.error = v;
        } else
          await afterKeyframeOutput(env, job, out, modules);
      } else if (await keyframeSetCompleteInR2(env, job)) {
        await recoverStalledKeyframePhase(env, job, modules, false);
      }
    }
    await putFilm(env, job);
  }
  let clipJob = null;
  if (job.phase === "clips" && job.clip_job_id) {
    clipJob = await advanceClipJob(env, job.clip_job_id, modules);
    if (clipJob && summarizeJob(clipJob).failed > 0) {
      const adopted = await reclaimClipsFromR2(env, clipJob);
      if (adopted > 0)
        await env.R2_RENDERS.put(clipDocKey(job.clip_job_id), JSON.stringify(clipJob), { httpMetadata: { contentType: "application/json" } });
    }
    if (clipJob && summarizeJob(clipJob).complete) {
      await enterFinishPhase(env, job, clipJob, modules);
    }
    await putFilm(env, job);
  } else if (job.clip_job_id) {
    const cj = await env.R2_RENDERS.get(clipDocKey(job.clip_job_id));
    if (cj)
      clipJob = JSON.parse(await cj.text());
  }
  if (job.phase === "dialogue") {
    await advanceDialoguePhase(env, job, modules);
    await putFilm(env, job);
  }
  if (job.phase === "speech") {
    await advanceSpeechPhase(env, job);
    await putFilm(env, job);
  }
  if (job.phase === "finish" && job.finish_shots) {
    await advanceFinishPhase(env, job, modules);
    await putFilm(env, job);
  }
  if (job.phase === "assemble") {
    const source = job.finish_shots ? job.finish_shots.filter((fs) => fs.status === "done").map((fs) => ({ shot_id: fs.shot_id, clip_key: fs.clip_key })) : (clipJob?.shots || []).filter((s) => s.status === "done" && s.clip_key).map((s) => ({ shot_id: s.shot_id, clip_key: s.clip_key }));
    await enterAssemblePhase(env, job, orderFinalClips(job.scenes, source), modules);
    await putFilm(env, job);
  } else if (job.phase === "master") {
    await advanceMasterPhase(env, job, modules);
    await putFilm(env, job);
  } else if (job.phase === "mux") {
    await enterMuxPhase(env, job, modules);
    await putFilm(env, job);
  }
  const marker = filmProgressMarker(job, clipJob);
  const progressed = marker !== job.progress_marker;
  if (progressed) {
    job.progress_marker = marker;
    job.last_progress_at = Date.now();
  }
  if (job.phase !== entryPhase) {
    job.phase_started_at = Date.now();
    await putFilm(env, job);
  } else if (progressed) {
    await putFilm(env, job);
  }
  return { job, clipJob };
}
__name(advanceFilmJobLocked, "advanceFilmJobLocked");

// node_modules/@skyphusion-labs/vivijure-core/dist/render-module-config.js
var QUALITY_TIERS = [
  { value: "draft", label: "draft", blurb: "33 frames, 8 steps; fastest, lowest quality" },
  { value: "standard", label: "standard", blurb: "8-step keyframes + 20-step EasyCache i2v; balanced" },
  { value: "final", label: "final", blurb: "97 frames, 22 steps; production quality" }
];
var DEFAULT_QUALITY_TIER = "final";
function renderConfigProjection() {
  return {
    quality_tiers: QUALITY_TIERS.map((t) => ({ value: t.value, label: t.label, blurb: t.blurb })),
    default_tier: DEFAULT_QUALITY_TIER
  };
}
__name(renderConfigProjection, "renderConfigProjection");
function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
__name(isRecord, "isRecord");
function parseModuleRenderOverrides(raw) {
  if (!isRecord(raw))
    return {};
  if (isRecord(raw.config) || typeof raw.motion_backend === "string" || typeof raw.keyframe_backend === "string") {
    const out = {};
    if (typeof raw.motion_backend === "string" && raw.motion_backend.trim()) {
      out.motion_backend = raw.motion_backend.trim();
    }
    if (typeof raw.keyframe_backend === "string" && raw.keyframe_backend.trim()) {
      out.keyframe_backend = raw.keyframe_backend.trim();
    }
    if (isRecord(raw.config)) {
      const config2 = {};
      for (const [name, cfg] of Object.entries(raw.config)) {
        if (isRecord(cfg))
          config2[name] = { ...cfg };
      }
      if (Object.keys(config2).length)
        out.config = config2;
    }
    return out;
  }
  const config = {};
  const kf = raw.keyframe;
  if (isRecord(kf)) {
    const mapped = {};
    if (typeof kf.steps === "number")
      mapped.steps = kf.steps;
    if (typeof kf.guidance_scale === "number")
      mapped.guidance_scale = kf.guidance_scale;
    if (typeof kf.seed === "number" && kf.seed >= 0)
      mapped.seed = kf.seed;
    if (typeof kf.resolution === "string") {
      const m = kf.resolution.trim().match(/^(\d+)x(\d+)$/i);
      if (m) {
        mapped.width = parseInt(m[1], 10);
        mapped.height = parseInt(m[2], 10);
      }
    }
    if (Object.keys(mapped).length)
      config.keyframe = mapped;
  }
  const i2v = raw.i2v;
  if (isRecord(i2v)) {
    const mapped = {};
    if (typeof i2v.fps === "number")
      mapped.fps = i2v.fps;
    if (typeof i2v.flow_shift === "number")
      mapped.flow_shift = i2v.flow_shift;
    if (typeof i2v.seed === "number" && i2v.seed >= 0)
      mapped.seed = i2v.seed;
    if (Object.keys(mapped).length)
      config["own-gpu"] = mapped;
  }
  return Object.keys(config).length ? { config } : {};
}
__name(parseModuleRenderOverrides, "parseModuleRenderOverrides");
function injectQualityTier(config, tier, modules, keyframeChoice) {
  const out = {};
  for (const [name, cfg] of Object.entries(config))
    out[name] = { ...cfg };
  const kf = pickOneForHook(modules, "keyframe", keyframeChoice) ?? servingForHook(modules, "keyframe")[0];
  if (kf) {
    out[kf.name] = { ...out[kf.name] ?? {}, quality_tier: tier };
  }
  for (const m of servingForHook(modules, "motion.backend")) {
    if (m.config_schema?.quality) {
      out[m.name] = { ...out[m.name] ?? {}, quality: tier };
    }
  }
  return out;
}
__name(injectQualityTier, "injectQualityTier");
function resolveModuleRenderConfigs(overrides, tier, modules) {
  const parsed = parseModuleRenderOverrides(overrides);
  const keyframeChoice = coupleLocalGpuKeyframeChoice(modules, parsed.motion_backend, parsed.keyframe_backend);
  const config = injectQualityTier(parsed.config ?? {}, tier, modules, keyframeChoice);
  const selection = {
    motion_backend_choice: parsed.motion_backend,
    keyframe_backend_choice: keyframeChoice,
    config
  };
  const pipeline = resolveRenderPipeline(modules, selection);
  const keyframe_config = pipeline.keyframe ? pipeline.keyframe.config : { quality_tier: tier };
  const finish_config = {};
  for (const m of pipeline.finish)
    finish_config[m.name] = m.config;
  const speech_config = {};
  for (const m of pipeline.speech)
    speech_config[m.name] = m.config;
  const film_finish_config = {};
  for (const m of pipeline.filmFinish)
    film_finish_config[m.name] = m.config;
  const master_config = {};
  for (const m of pipeline.master)
    master_config[m.name] = m.config;
  return {
    motion_backend: pipeline.motion_backend?.name,
    keyframe_backend: pipeline.keyframe?.name,
    keyframe_config,
    motion_config: pipeline.motion_backend?.config ?? {},
    finish_config,
    speech_config,
    film_finish_config,
    master_config
  };
}
__name(resolveModuleRenderConfigs, "resolveModuleRenderConfigs");

// node_modules/@skyphusion-labs/vivijure-core/dist/film-render-bridge.js
function isFilmJobId(jobId) {
  return typeof jobId === "string" && jobId.startsWith("film-");
}
__name(isFilmJobId, "isFilmJobId");
function filmRenderRowSeedFromJob(job) {
  const mode = job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full");
  return {
    jobId: job.film_id,
    project: job.project,
    bundleKey: job.bundle_key,
    qualityTier: job.quality_tier ?? "final",
    status: filmJobToPollView(job, null).status,
    mode,
    parentId: job.parent_render_id ?? null
  };
}
__name(filmRenderRowSeedFromJob, "filmRenderRowSeedFromJob");
function mapRenderOverridesToModuleConfigs(overrides, qualityTier, modules) {
  return resolveModuleRenderConfigs(overrides, qualityTier, modules);
}
__name(mapRenderOverridesToModuleConfigs, "mapRenderOverridesToModuleConfigs");
function normalizeFilmScenes(raw) {
  if (!Array.isArray(raw))
    return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== "object")
      continue;
    const o = e;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    const seconds = typeof o.seconds === "number" && o.seconds > 0 ? o.seconds : 4;
    if (shot_id && prompt.trim())
      out.push({ shot_id, prompt, seconds });
  }
  return out;
}
__name(normalizeFilmScenes, "normalizeFilmScenes");
function filterScenesByShotIds(scenes, shotIds) {
  if (!shotIds || shotIds.length === 0)
    return scenes;
  const allow = new Set(shotIds);
  return scenes.filter((s) => allow.has(s.shot_id));
}
__name(filterScenesByShotIds, "filterScenesByShotIds");
function orderScenesByShotIds(scenes, shotIds) {
  const byId = new Map(scenes.map((s) => [s.shot_id, s]));
  const out = [];
  for (const id of shotIds) {
    const s = byId.get(id);
    if (s)
      out.push(s);
  }
  return out;
}
__name(orderScenesByShotIds, "orderScenesByShotIds");
function stallSignal(job, now = Date.now()) {
  const lastProgressAt = job.last_progress_at ?? job.phase_started_at ?? job.created_at;
  const ageSeconds = Math.max(0, Math.floor((now - lastProgressAt) / 1e3));
  const stalled = ageSeconds >= KEYFRAME_STALL_SECONDS;
  const out = { last_progress_at: lastProgressAt };
  if (stalled) {
    out.stalled = true;
    out.stall_seconds = ageSeconds;
  }
  return out;
}
__name(stallSignal, "stallSignal");
function phaseProgress(job, clipJob, keyframeDone) {
  const total = job.scenes.length;
  const summary = summarizeFilm(job, clipJob);
  const base = { scene_total: total, project: job.project, ...stallSignal(job) };
  switch (job.phase) {
    case "keyframe": {
      if (typeof keyframeDone === "number" && total > 0) {
        return {
          ...base,
          phase: "keyframe",
          scene_index: Math.min(total, keyframeDone + 1),
          progress: Math.min(1, keyframeDone / total)
        };
      }
      return { ...base, phase: "keyframe", scene_index: 1 };
    }
    case "clips": {
      const c = summary.clips;
      const done = c?.done ?? 0;
      const progress = c && c.total > 0 ? done / c.total : void 0;
      return {
        ...base,
        phase: "i2v",
        scene_index: Math.min(total, done + 1),
        progress
      };
    }
    case "finish": {
      const f = summary.finish;
      const done = f?.done ?? 0;
      return { ...base, phase: "finish", scene_index: Math.min(total, done + 1) };
    }
    case "assemble":
      return { ...base, phase: "assemble" };
    case "mux":
      return { ...base, phase: "mux" };
    default:
      return base;
  }
}
__name(phaseProgress, "phaseProgress");
function filmJobToPollView(job, clipJob, keyframeDone) {
  let status;
  let output;
  if (job.cancelled) {
    status = "CANCELLED";
  } else if (job.phase === "done") {
    status = "COMPLETED";
    const mode = job.derive_mode ?? (job.keyframes_only ? "keyframes-only" : "full");
    output = {
      output_key: resolveFilmOutputKey(job),
      project: job.project,
      mode
    };
    if (job.film_finish?.sidecar_key)
      output.sidecar_key = job.film_finish.sidecar_key;
    if (job.finish_unavailable) {
      output.finish_unavailable = {
        at: job.finish_unavailable.at,
        reason: job.finish_unavailable.reason,
        delivered: job.finish_unavailable.delivered
      };
      const uClips = job.finish_unavailable.clips;
      if (uClips?.length)
        output.clips = uClips.map((c) => ({ shot_id: c.shot_id, key: c.clip_key }));
    }
    if (job.keyframes_only && job.keyframes?.length) {
      output.keyframes = job.keyframes.map((k) => ({ shot_id: k.shot_id, key: k.keyframe_key }));
      output.scenes = job.scenes;
    }
    if (job.derive_mode && clipJob) {
      const clips = clipJob.shots.filter((s) => s.status === "done" && s.clip_key).map((s) => ({
        shot_id: s.shot_id,
        key: s.clip_key,
        model: s.motion_backend ?? clipJob.motion_backend ?? void 0
      }));
      if (clips.length)
        output.clips = clips;
      const models = new Set(clips.map((c) => c.model).filter(Boolean));
      if (models.size === 1)
        output.model = [...models][0];
      else if (job.motion_backend)
        output.model = job.motion_backend;
    }
  } else if (job.phase === "failed") {
    status = "FAILED";
  } else {
    status = "IN_PROGRESS";
    output = phaseProgress(job, clipJob, keyframeDone);
  }
  if (job.keyframes_incomplete && output)
    output.keyframes_incomplete = job.keyframes_incomplete;
  const deliveries = clipDeliveries(clipJob);
  if (deliveries && output)
    output.clip_deliveries = deliveries;
  return {
    jobId: job.film_id,
    status,
    statusRaw: job.cancelled ? "CANCELLED" : job.phase,
    output,
    error: job.error,
    executionTimeMs: Math.max(0, Date.now() - job.created_at)
  };
}
__name(filmJobToPollView, "filmJobToPollView");

// src/film-render-bridge.ts
function filmRowFromJob(job) {
  const seed = filmRenderRowSeedFromJob(job);
  return {
    jobId: seed.jobId,
    project: seed.project,
    bundleKey: seed.bundleKey,
    qualityTier: seed.qualityTier,
    status: seed.status,
    mode: seed.mode,
    parentId: seed.parentId
  };
}
__name(filmRowFromJob, "filmRowFromJob");

// node_modules/@skyphusion-labs/vivijure-core/dist/platform/object-store-r2.js
function firstIndexAfter(sortedKeys, cursor) {
  let lo = 0;
  let hi = sortedKeys.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (sortedKeys[mid] > cursor)
      hi = mid;
    else
      lo = mid + 1;
  }
  return lo;
}
__name(firstIndexAfter, "firstIndexAfter");
function toBody(bytes) {
  return {
    body: bytes,
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}
__name(toBody, "toBody");
var ObjectStoreR2Bucket = class {
  static {
    __name(this, "ObjectStoreR2Bucket");
  }
  store;
  constructor(store) {
    this.store = store;
  }
  async get(key, opts) {
    if (opts?.range && this.store.getRange) {
      const slice = await this.store.getRange(key, opts.range.offset, opts.range.length);
      if (!slice)
        return null;
      return toBody(slice);
    }
    const buf = await this.store.get(key);
    if (!buf)
      return null;
    return toBody(new Uint8Array(buf));
  }
  async put(key, value, opts) {
    let payload;
    if (typeof value === "object" && value !== null && "body" in value) {
      payload = value.body;
    } else {
      payload = value;
    }
    await this.store.put(key, payload, opts ? { httpMetadata: opts.httpMetadata } : void 0);
  }
  async head(key) {
    return this.store.head(key);
  }
  async delete(key) {
    await this.store.delete(key);
  }
  async list(opts) {
    if (!this.store.list) {
      return { objects: [], truncated: false };
    }
    const raw = await this.store.list(opts.prefix);
    const inline = raw.objects ? new Map(raw.objects.map((o) => [o.key, o])) : void 0;
    const keys = raw.keys.slice().sort();
    const limit = opts.limit ?? 1e3;
    const startIdx = opts.cursor ? firstIndexAfter(keys, opts.cursor) : 0;
    const slice = keys.slice(startIdx, startIdx + limit);
    const objects = [];
    for (const key of slice) {
      const uploaded = inline ? inline.get(key)?.uploaded : (await this.store.head(key))?.uploaded;
      objects.push({ key, uploaded });
    }
    const truncated = startIdx + slice.length < keys.length;
    return {
      objects,
      truncated,
      cursor: truncated && slice.length ? slice[slice.length - 1] : void 0
    };
  }
};
function wrapR2Bucket(store) {
  return new ObjectStoreR2Bucket(store);
}
__name(wrapR2Bucket, "wrapR2Bucket");

// node_modules/@skyphusion-labs/vivijure-core/dist/platform/types.js
function platformAsEnv(platform) {
  const env = { ...platform.vars };
  env.DB = platform.db;
  env.R2_RENDERS = wrapR2Bucket(platform.renders);
  env.R2 = wrapR2Bucket(platform.chatBucket);
  for (const binding of platform.modules.listBindings()) {
    const fetcher = platform.modules.resolve(binding);
    if (fetcher)
      env[binding] = fetcher;
  }
  return env;
}
__name(platformAsEnv, "platformAsEnv");

// node_modules/@skyphusion-labs/vivijure-core/dist/platform/orchestrator-context.js
function orchestratorContextFromPlatform(platform) {
  const env = platformAsEnv(platform);
  env.DB = platform.db;
  env.R2_RENDERS = wrapR2Bucket(platform.renders);
  env.R2 = wrapR2Bucket(platform.chatBucket);
  env.PRESIGNER = platform.presigner;
  for (const [key, value] of Object.entries(platform.vars)) {
    if (value !== void 0)
      env[key] = value;
  }
  if (platform.hostBindings) {
    for (const [key, fetcher] of Object.entries(platform.hostBindings)) {
      env[key] = fetcher;
    }
  }
  return env;
}
__name(orchestratorContextFromPlatform, "orchestratorContextFromPlatform");

// node_modules/@skyphusion-labs/vivijure-core/dist/runpod-endpoint-reconcile.js
var RUNPOD_REST_BASE = "https://rest.runpod.io/v1";
function endpointWorkersMaxNeedsRestore(current, expected) {
  if (current == null || !Number.isFinite(current))
    return false;
  return current < expected;
}
__name(endpointWorkersMaxNeedsRestore, "endpointWorkersMaxNeedsRestore");
function idleScaleDownGuidance(endpointId, expectedWorkersMax) {
  return `RunPod endpoint ${endpointId} workersMax is below the configured ${expectedWorkersMax} (likely RunPod idle scale-down after 7 days without requests). Raise workersMax in the RunPod console (Serverless \u2192 your endpoint \u2192 Max workers), or run the reconcile script with a management-capable API key.`;
}
__name(idleScaleDownGuidance, "idleScaleDownGuidance");
function authHeaders(apiKey, json6 = false) {
  const h = { authorization: `Bearer ${apiKey}` };
  if (json6)
    h["content-type"] = "application/json";
  return h;
}
__name(authHeaders, "authHeaders");
async function fetchEndpointWorkersMax(apiKey, endpointId, fetchImpl = fetch) {
  const url = `${RUNPOD_REST_BASE}/endpoints/${endpointId}`;
  let resp;
  try {
    resp = await fetchImpl(url, { method: "GET", headers: authHeaders(apiKey) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { workersMax: null, workersMin: null, status: 0, detail: `network: ${m}` };
  }
  const text = await resp.text();
  if (!resp.ok) {
    return { workersMax: null, workersMin: null, status: resp.status, detail: text.slice(0, 300) };
  }
  try {
    const body = JSON.parse(text);
    const workersMax = typeof body.workersMax === "number" ? body.workersMax : null;
    const workersMin = typeof body.workersMin === "number" ? body.workersMin : null;
    return { workersMax, workersMin, status: resp.status };
  } catch {
    return { workersMax: null, workersMin: null, status: resp.status, detail: "non-JSON response" };
  }
}
__name(fetchEndpointWorkersMax, "fetchEndpointWorkersMax");
async function patchEndpointWorkersMax(apiKey, endpointId, workersMax, workersMin, fetchImpl = fetch) {
  const url = `${RUNPOD_REST_BASE}/endpoints/${endpointId}`;
  const payload = { workersMax };
  if (workersMin != null)
    payload.workersMin = workersMin;
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: "PATCH",
      headers: authHeaders(apiKey, true),
      body: JSON.stringify(payload)
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, detail: `network: ${m}` };
  }
  const text = await resp.text();
  if (!resp.ok)
    return { ok: false, status: resp.status, detail: text.slice(0, 300) };
  return { ok: true, status: resp.status };
}
__name(patchEndpointWorkersMax, "patchEndpointWorkersMax");
async function reconcileRunpodEndpointWorkersMax(opts) {
  const { apiKey, endpointId, spec } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const expected = spec.workersMax;
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: true, action: "none" };
  }
  const live = await fetchEndpointWorkersMax(apiKey, endpointId, fetchImpl);
  if (live.status === 401 || live.status === 403) {
    return {
      ok: false,
      error: `RunPod endpoint config unreadable with this API key (HTTP ${live.status})`,
      guidance: idleScaleDownGuidance(endpointId, expected),
      status: live.status
    };
  }
  if (live.workersMax == null) {
    return { ok: true, action: "none" };
  }
  if (!endpointWorkersMaxNeedsRestore(live.workersMax, expected)) {
    return { ok: true, action: "none" };
  }
  const patch = await patchEndpointWorkersMax(apiKey, endpointId, expected, spec.workersMin ?? live.workersMin ?? 0, fetchImpl);
  if (!patch.ok) {
    if (patch.status === 401 || patch.status === 403) {
      return {
        ok: false,
        error: `RunPod endpoint workersMax restore failed: HTTP ${patch.status}`,
        guidance: idleScaleDownGuidance(endpointId, expected),
        status: patch.status
      };
    }
    return {
      ok: false,
      error: `RunPod endpoint workersMax restore failed: ${patch.detail ?? `HTTP ${patch.status}`}`,
      status: patch.status
    };
  }
  return {
    ok: true,
    action: "restored",
    workersMaxBefore: live.workersMax,
    workersMaxAfter: expected
  };
}
__name(reconcileRunpodEndpointWorkersMax, "reconcileRunpodEndpointWorkersMax");

// node_modules/@skyphusion-labs/vivijure-core/dist/runpod-submit.js
function coerceQualityTier(t) {
  if (t === "draft")
    return "draft";
  if (t === "standard")
    return "standard";
  if (t === "final")
    return "final";
  return void 0;
}
__name(coerceQualityTier, "coerceQualityTier");
var RUNPOD_BASE = "https://api.runpod.ai";
function deriveProjectFromBundleKey(bundleKey) {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m)
    return m[1];
  return bundleKey;
}
__name(deriveProjectFromBundleKey, "deriveProjectFromBundleKey");
function buildTrainLoraPayload(args) {
  const input = {
    action: "train_lora",
    project: args.project,
    bundle_key: args.bundleKey
  };
  const ro = normalizeRenderOverrides(args.renderOverrides);
  if (ro)
    input.render_overrides = ro;
  return { input };
}
__name(buildTrainLoraPayload, "buildTrainLoraPayload");
function buildTrainWanLoraPayload(args) {
  const { input } = buildTrainLoraPayload(args);
  input.model_family = "wan";
  return { input };
}
__name(buildTrainWanLoraPayload, "buildTrainWanLoraPayload");
var _OVERRIDE_SECTIONS = ["keyframe", "i2v", "lora"];
var _OVERRIDE_FLAGS = ["finish_offloaded"];
function normalizeRenderOverrides(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw;
    for (const sec of _OVERRIDE_SECTIONS) {
      const v = r[sec];
      if (v && typeof v === "object" && !Array.isArray(v))
        out[sec] = v;
    }
    for (const f of _OVERRIDE_FLAGS) {
      if (typeof r[f] === "boolean")
        out[f] = r[f];
    }
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
__name(normalizeRenderOverrides, "normalizeRenderOverrides");
function buildSubmitUrl(endpointId) {
  return `${RUNPOD_BASE}/v2/${endpointId}/run`;
}
__name(buildSubmitUrl, "buildSubmitUrl");
function buildStatusUrl(endpointId, jobId) {
  return `${RUNPOD_BASE}/v2/${endpointId}/status/${jobId}`;
}
__name(buildStatusUrl, "buildStatusUrl");
function normalizeRunpodResponse(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const r = raw;
  const jobId = typeof r.id === "string" ? r.id : "";
  const statusRaw = typeof r.status === "string" ? r.status : "";
  if (!jobId || !statusRaw)
    return null;
  const knownStatuses = [
    "IN_QUEUE",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT"
  ];
  const status = knownStatuses.includes(statusRaw) ? statusRaw : "IN_PROGRESS";
  const view = { jobId, status, statusRaw };
  if (r.output !== void 0)
    view.output = r.output;
  if (typeof r.error === "string" && r.error.length > 0)
    view.error = r.error;
  if (typeof r.executionTime === "number")
    view.executionTimeMs = r.executionTime;
  if (typeof r.delayTime === "number")
    view.delayTimeMs = r.delayTime;
  return view;
}
__name(normalizeRunpodResponse, "normalizeRunpodResponse");
var RUNPOD_MAX_ATTEMPTS = 3;
var RUNPOD_BACKOFF_BASE_MS = 250;
var RUNPOD_TIMEOUT_MS = 3e4;
function isTransientStatus(status) {
  return status === 429 || status >= 500;
}
__name(isTransientStatus, "isTransientStatus");
var defaultSleep2 = /* @__PURE__ */ __name((ms) => new Promise((resolve2) => setTimeout(resolve2, ms)), "defaultSleep");
function backoffDelayMs(attempt, baseMs, random) {
  const ceil = baseMs * 2 ** (attempt - 1);
  return Math.floor(random() * ceil);
}
__name(backoffDelayMs, "backoffDelayMs");
async function runpodRequest(env, spec, opts = {}) {
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) {
    return {
      ok: false,
      error: "RUNPOD_API_KEY must be set on the Worker (Secrets Store binding or npx wrangler secret put)"
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep2;
  const random = opts.random ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? RUNPOD_MAX_ATTEMPTS;
  const backoffBaseMs = opts.backoffBaseMs ?? RUNPOD_BACKOFF_BASE_MS;
  const timeoutMs = opts.timeoutMs ?? RUNPOD_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${apiKey}`
  };
  if (spec.body !== void 0)
    headers["content-type"] = "application/json";
  let lastTransientError = `RunPod ${spec.label} failed`;
  let lastTransientStatus;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp;
    try {
      resp = await fetchImpl(spec.url, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      lastTransientError = `RunPod ${spec.label} network error: ${m}`;
      lastTransientStatus = void 0;
      if (attempt < maxAttempts) {
        await sleep(backoffDelayMs(attempt, backoffBaseMs, random));
        continue;
      }
      return { ok: false, error: lastTransientError };
    }
    if (!resp.ok && isTransientStatus(resp.status) && attempt < maxAttempts) {
      lastTransientError = `RunPod ${spec.label} failed: HTTP ${resp.status}`;
      lastTransientStatus = resp.status;
      await sleep(backoffDelayMs(attempt, backoffBaseMs, random));
      continue;
    }
    let raw;
    try {
      raw = await resp.json();
    } catch {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `RunPod ${spec.label} returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
        status: resp.status
      };
    }
    if (!resp.ok) {
      const errStr = raw && typeof raw === "object" && "error" in raw ? String(raw.error) : `HTTP ${resp.status}`;
      return { ok: false, error: `RunPod ${spec.label} failed: ${errStr}`, status: resp.status };
    }
    const view = normalizeRunpodResponse(raw);
    if (!view) {
      return { ok: false, error: `RunPod ${spec.label} returned an unrecognized envelope` };
    }
    return { ok: true, view };
  }
  return { ok: false, error: lastTransientError, status: lastTransientStatus };
}
__name(runpodRequest, "runpodRequest");
function runpodMissingEndpoint() {
  return {
    ok: false,
    error: "RUNPOD_ENDPOINT_ID must be set on the Worker (Secrets Store binding or npx wrangler secret put)"
  };
}
__name(runpodMissingEndpoint, "runpodMissingEndpoint");
function parseWorkersMaxSpec(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0)
    return Math.floor(raw);
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0)
      return Math.floor(n);
  }
  return null;
}
__name(parseWorkersMaxSpec, "parseWorkersMaxSpec");
async function reconcileEndpointIfConfigured(env, apiKey, endpointId, opts) {
  const specRaw = env.RUNPOD_WORKERS_MAX ?? env.RUNPOD_ENDPOINT_WORKERS_MAX;
  const resolved = specRaw instanceof Promise || specRaw && typeof specRaw === "object" && "get" in specRaw ? await secretValue(specRaw) : specRaw;
  const workersMax = parseWorkersMaxSpec(resolved);
  if (workersMax == null)
    return null;
  const rec = await reconcileRunpodEndpointWorkersMax({
    apiKey,
    endpointId,
    spec: { workersMax },
    fetchImpl: opts?.fetchImpl
  });
  if (rec.ok)
    return null;
  const msg = rec.guidance ? `${rec.error}. ${rec.guidance}` : rec.error;
  return { ok: false, error: msg, status: rec.status };
}
__name(reconcileEndpointIfConfigured, "reconcileEndpointIfConfigured");
async function submitToRunpodEndpoint(env, endpointId, body, label, opts) {
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) {
    return {
      ok: false,
      error: "RUNPOD_API_KEY must be set on the Worker (Secrets Store binding or npx wrangler secret put)"
    };
  }
  const reconcileErr = await reconcileEndpointIfConfigured(env, apiKey, endpointId, opts);
  if (reconcileErr)
    return reconcileErr;
  return runpodRequest(env, { method: "POST", url: buildSubmitUrl(endpointId), body, label }, opts);
}
__name(submitToRunpodEndpoint, "submitToRunpodEndpoint");
async function submitTrainLoraJob(env, args, opts) {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID);
  if (!endpointId)
    return runpodMissingEndpoint();
  return submitToRunpodEndpoint(env, endpointId, JSON.stringify(buildTrainLoraPayload(args)), "train-lora submit", opts);
}
__name(submitTrainLoraJob, "submitTrainLoraJob");
async function submitTrainWanLoraJob(env, args, opts) {
  const endpointId = await secretValue(env.RUNPOD_WAN_TRAIN_ENDPOINT_ID);
  if (!endpointId)
    return runpodMissingWanEndpoint();
  return submitToRunpodEndpoint(env, endpointId, JSON.stringify(buildTrainWanLoraPayload(args)), "train-wan-lora submit", opts);
}
__name(submitTrainWanLoraJob, "submitTrainWanLoraJob");
function runpodMissingWanEndpoint() {
  return {
    ok: false,
    error: "RUNPOD_WAN_TRAIN_ENDPOINT_ID must be set on the Worker (the dedicated Wan-training endpoint; Secrets Store binding or npx wrangler secret put)"
  };
}
__name(runpodMissingWanEndpoint, "runpodMissingWanEndpoint");
async function pollRunpodJob(env, endpointId, jobId, opts) {
  return runpodRequest(env, {
    method: "GET",
    url: buildStatusUrl(endpointId, jobId),
    label: "poll"
  }, opts);
}
__name(pollRunpodJob, "pollRunpodJob");
async function pollRenderJob(env, jobId, opts) {
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID);
  if (!endpointId)
    return runpodMissingEndpoint();
  return pollRunpodJob(env, endpointId, jobId, opts);
}
__name(pollRenderJob, "pollRenderJob");
function mergeCastLoraPollResults(wanPoll, renderPoll) {
  if (wanPoll?.ok)
    return wanPoll;
  if (wanPoll && !wanPoll.ok && wanPoll.status !== 404)
    return wanPoll;
  return renderPoll;
}
__name(mergeCastLoraPollResults, "mergeCastLoraPollResults");
async function pollCastLoraJob(env, jobId, opts) {
  const wanEndpointId = await secretValue(env.RUNPOD_WAN_TRAIN_ENDPOINT_ID);
  let wanPoll;
  if (wanEndpointId) {
    wanPoll = await pollRunpodJob(env, wanEndpointId, jobId, opts);
    if (wanPoll.ok)
      return wanPoll;
    if (wanPoll.status !== 404)
      return wanPoll;
  }
  const renderPoll = await pollRenderJob(env, jobId, opts);
  return mergeCastLoraPollResults(wanPoll, renderPoll);
}
__name(pollCastLoraJob, "pollCastLoraJob");
function parseAudioBeatPlan(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const r = raw;
  const mode = r.mode === "beat" || r.mode === "duration" ? r.mode : null;
  if (!mode)
    return null;
  return {
    mode,
    audioKey: String(r.audio_key ?? ""),
    durationSeconds: Number(r.duration_seconds ?? 0),
    bpm: typeof r.bpm === "number" ? r.bpm : void 0,
    beatCount: typeof r.beat_count === "number" ? r.beat_count : void 0,
    suggestedShots: Number(r.suggested_shots ?? 0),
    clipSeconds: Number(r.clip_seconds ?? 0),
    filmSeconds: Number(r.film_seconds ?? 0),
    remainderSeconds: Number(r.remainder_seconds ?? 0),
    timedScenes: Array.isArray(r.timed_scenes) ? r.timed_scenes.filter((s) => !!s && typeof s === "object").map((s) => ({
      index: Number(s.index ?? 0),
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      targetSeconds: Number(s.target_seconds ?? 0)
    })) : [],
    note: String(r.note ?? "")
  };
}
__name(parseAudioBeatPlan, "parseAudioBeatPlan");

// node_modules/@skyphusion-labs/vivijure-core/dist/storyboard-projects-db.js
function parseJson(raw, fallback) {
  if (!raw)
    return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
__name(parseJson, "parseJson");
function rowToProject(row) {
  return {
    id: row.id,
    public_id: row.public_id,
    slug: row.slug,
    name: row.name,
    prefs: parseJson(row.prefs_json, {}),
    last_storyboard: row.last_storyboard_json ? parseJson(row.last_storyboard_json, null) : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
__name(rowToProject, "rowToProject");
function toPublicProject(row) {
  const { id: _internalId, public_id, ...rest } = row;
  return { ...rest, id: public_id };
}
__name(toPublicProject, "toPublicProject");
function slugifyProject(name) {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]+/g, "").trim().replace(/[\s-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "project";
}
__name(slugifyProject, "slugifyProject");
async function allocateProjectSlug(env, base) {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(`SELECT id FROM storyboard_projects WHERE slug = ? LIMIT 1`).bind(candidate).first();
    if (!existing)
      return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate project slug after 200 attempts (base='${base}')`);
}
__name(allocateProjectSlug, "allocateProjectSlug");
var PROJECT_LIST_LIMIT = 500;
async function listProjects(env) {
  const result = await env.DB.prepare(`SELECT id, public_id, slug, name, prefs_json, last_storyboard_json,
            created_at, updated_at
       FROM storyboard_projects
      ORDER BY created_at DESC
      LIMIT ?`).bind(PROJECT_LIST_LIMIT).all();
  return (result.results || []).map(rowToProject);
}
__name(listProjects, "listProjects");
async function getProjectIdByPublicId(env, publicId) {
  const row = await env.DB.prepare(`SELECT id FROM storyboard_projects WHERE public_id = ? LIMIT 1`).bind(publicId).first();
  return row ? Number(row.id) : null;
}
__name(getProjectIdByPublicId, "getProjectIdByPublicId");
async function getProjectById(env, id) {
  const row = await env.DB.prepare(`SELECT id, public_id, slug, name, prefs_json, last_storyboard_json,
            created_at, updated_at
       FROM storyboard_projects
      WHERE id = ?
      LIMIT 1`).bind(id).first();
  return row ? rowToProject(row) : null;
}
__name(getProjectById, "getProjectById");
async function createProject(env, input) {
  const baseSlug = slugifyProject(input.name);
  const slug = await allocateProjectSlug(env, baseSlug);
  const prefsJson = JSON.stringify(input.prefs ?? {});
  const row = await env.DB.prepare(`INSERT INTO storyboard_projects (public_id, slug, name, prefs_json)
     VALUES (?, ?, ?, ?)
     RETURNING id, public_id, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`).bind(newPublicId(), slug, input.name, prefsJson).first();
  if (!row)
    throw new Error("createProject: INSERT...RETURNING produced no row");
  return rowToProject(row);
}
__name(createProject, "createProject");
async function updateProjectMeta(env, id, patch) {
  const fields = [];
  const values = [];
  if (patch.name !== void 0) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.prefs !== void 0) {
    fields.push("prefs_json = ?");
    values.push(JSON.stringify(patch.prefs));
  }
  if (fields.length === 0) {
    return getProjectById(env, id);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  const row = await env.DB.prepare(`UPDATE storyboard_projects SET ${fields.join(", ")}
      WHERE id = ?
     RETURNING id, public_id, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`).bind(...values).first();
  return row ? rowToProject(row) : null;
}
__name(updateProjectMeta, "updateProjectMeta");
async function setLastStoryboard(env, id, storyboard) {
  const sbJson = JSON.stringify(storyboard);
  const row = await env.DB.prepare(`UPDATE storyboard_projects
        SET last_storyboard_json = ?, updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`).bind(sbJson, id).first();
  return row ? rowToProject(row) : null;
}
__name(setLastStoryboard, "setLastStoryboard");
async function deleteProject(env, id) {
  const cur = await getProjectById(env, id);
  if (!cur)
    return null;
  await env.DB.prepare(`DELETE FROM storyboard_projects WHERE id = ?`).bind(id).run();
  return cur;
}
__name(deleteProject, "deleteProject");

// node_modules/@skyphusion-labs/vivijure-core/dist/storyboard-validate.js
var SLOT_IDS = ["A", "B", "C", "D"];
var SLOT_SET = new Set(SLOT_IDS);
var SCENE_PROMPT_MAX_WORDS = 50;
var STORYBOARD_MAX_SCENES = 50;
var FULL_PROMPT_MAX_CHARS = 1024;
var STYLE_PREFIX_MAX_CHARS = 256;
var SCENE_MAX_SECONDS = 60;
var STORYBOARD_MAX_SECONDS = STORYBOARD_MAX_SCENES * SCENE_MAX_SECONDS;
var DIALOGUE_MAX_CHARS = 300;
function countWords(prompt) {
  return prompt.trim().split(/\s+/).filter((w) => w.length > 0).length;
}
__name(countWords, "countWords");
function normalizeProjectName(title) {
  const raw = typeof title === "string" ? title : "";
  const slug = raw.trim().replace(/\s+/g, "_");
  return sanitizeKeySegment(slug, "project");
}
__name(normalizeProjectName, "normalizeProjectName");
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
__name(isPositiveFiniteNumber, "isPositiveFiniteNumber");
function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
__name(isNonNegativeFiniteNumber, "isNonNegativeFiniteNumber");
function describeType(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  return typeof value;
}
__name(describeType, "describeType");
function sceneLabel(scene, index) {
  const id = typeof scene.id === "string" && scene.id.trim().length > 0 ? scene.id.trim() : null;
  return id ? `scenes[${index}] (id="${id}")` : `scenes[${index}]`;
}
__name(sceneLabel, "sceneLabel");
function normalizeStyleNone(value) {
  if (typeof value !== "string")
    return "None";
  const trimmed = value.trim();
  return trimmed.length === 0 ? "None" : trimmed;
}
__name(normalizeStyleNone, "normalizeStyleNone");
function validateTitleSection(input, errors) {
  let title = "";
  let projectName = "project";
  const rawTitle = input.title;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
    errors.push("title is required and must be a non-empty string");
  } else {
    title = rawTitle;
    projectName = normalizeProjectName(rawTitle);
  }
  return { title, projectName };
}
__name(validateTitleSection, "validateTitleSection");
function validateUseCharactersSection(input, errors) {
  const useCharacters = [];
  if (input.use_characters !== void 0) {
    if (!Array.isArray(input.use_characters)) {
      errors.push(`use_characters must be an array of slot ids if provided (got ${describeType(input.use_characters)})`);
    } else {
      const seen = /* @__PURE__ */ new Set();
      input.use_characters.forEach((slot, i) => {
        if (typeof slot !== "string") {
          errors.push(`use_characters[${i}] must be a string (got ${describeType(slot)})`);
          return;
        }
        if (!SLOT_SET.has(slot)) {
          errors.push(`use_characters[${i}] = "${slot}" is not a valid slot id (allowed: ${SLOT_IDS.join(", ")})`);
          return;
        }
        if (seen.has(slot)) {
          errors.push(`use_characters[${i}] = "${slot}" is duplicated`);
          return;
        }
        seen.add(slot);
        useCharacters.push(slot);
      });
    }
  }
  return useCharacters;
}
__name(validateUseCharactersSection, "validateUseCharactersSection");
function validateSceneSlots(scene, label, useCharacters, out, errors) {
  if (scene.character_slots !== void 0) {
    if (!Array.isArray(scene.character_slots)) {
      errors.push(`${label} character_slots must be an array if provided (got ${describeType(scene.character_slots)})`);
    } else {
      const slotsOut = [];
      const seenLocal = /* @__PURE__ */ new Set();
      scene.character_slots.forEach((slot, j) => {
        if (typeof slot !== "string") {
          errors.push(`${label} character_slots[${j}] must be a string (got ${describeType(slot)})`);
          return;
        }
        if (!SLOT_SET.has(slot)) {
          errors.push(`${label} character_slots[${j}] = "${slot}" is not a valid slot id (allowed: ${SLOT_IDS.join(", ")})`);
          return;
        }
        if (seenLocal.has(slot)) {
          errors.push(`${label} character_slots[${j}] = "${slot}" is duplicated within the scene`);
          return;
        }
        if (!useCharacters.includes(slot)) {
          const loaded = useCharacters.length > 0 ? useCharacters.join(", ") : "(none)";
          errors.push(`${label} character_slots references slot "${slot}" which is not in use_characters (loaded: ${loaded})`);
          return;
        }
        seenLocal.add(slot);
        slotsOut.push(slot);
      });
      out.character_slots = slotsOut;
    }
  }
}
__name(validateSceneSlots, "validateSceneSlots");
function validateSceneDialogue(scene, label, out, errors) {
  if (scene.dialogue !== void 0) {
    if (!isPlainObject(scene.dialogue)) {
      errors.push(`${label} dialogue must be an object { slot, text } if provided (got ${describeType(scene.dialogue)})`);
    } else {
      const dlgSlot = scene.dialogue.slot;
      const dlgText = scene.dialogue.text;
      let slotOk = false;
      if (typeof dlgSlot !== "string" || !SLOT_SET.has(dlgSlot)) {
        errors.push(`${label} dialogue.slot must be a valid slot id (allowed: ${SLOT_IDS.join(", ")})`);
      } else if (!(out.character_slots ?? []).includes(dlgSlot)) {
        errors.push(`${label} dialogue.slot "${dlgSlot}" must be one of this shot's character_slots (the speaker has to be in the shot)`);
      } else {
        slotOk = true;
      }
      let textOk = false;
      if (typeof dlgText !== "string" || dlgText.trim().length === 0) {
        errors.push(`${label} dialogue.text must be a non-empty string`);
      } else if (dlgText.length > DIALOGUE_MAX_CHARS) {
        errors.push(`${label} dialogue.text is ${dlgText.length} chars; cap is ${DIALOGUE_MAX_CHARS} (one spoken line per shot)`);
      } else {
        textOk = true;
      }
      if (slotOk && textOk) {
        out.dialogue = { slot: dlgSlot, text: dlgText.trim() };
      }
    }
  }
}
__name(validateSceneDialogue, "validateSceneDialogue");
function validateSceneTiming(scene, label, out, errors) {
  if (scene.start !== void 0) {
    if (!isNonNegativeFiniteNumber(scene.start)) {
      errors.push(`${label} start must be a non-negative finite number if provided`);
    } else {
      out.start = scene.start;
    }
  }
  if (scene.end !== void 0) {
    if (!isPositiveFiniteNumber(scene.end)) {
      errors.push(`${label} end must be a positive finite number if provided`);
    } else {
      out.end = scene.end;
    }
  }
  if (scene.target_seconds !== void 0) {
    if (!isPositiveFiniteNumber(scene.target_seconds)) {
      errors.push(`${label} target_seconds must be a positive finite number if provided`);
    } else if (scene.target_seconds > SCENE_MAX_SECONDS) {
      errors.push(`${label} target_seconds is ${scene.target_seconds}s; cap is ${SCENE_MAX_SECONDS}s per shot`);
    } else {
      out.target_seconds = scene.target_seconds;
    }
  }
  if (typeof out.start === "number" && typeof out.end === "number" && out.end <= out.start) {
    errors.push(`${label} end (${out.end}) must be greater than start (${out.start})`);
  } else if (typeof out.start === "number" && typeof out.end === "number" && out.end - out.start > SCENE_MAX_SECONDS) {
    errors.push(`${label} span (end - start = ${Math.round((out.end - out.start) * 100) / 100}s) exceeds the per-shot cap of ${SCENE_MAX_SECONDS}s`);
  }
}
__name(validateSceneTiming, "validateSceneTiming");
function validateScene(scene, i, useCharacters, errors) {
  if (!isPlainObject(scene)) {
    errors.push(`scenes[${i}] must be an object (got ${describeType(scene)})`);
    return null;
  }
  const label = sceneLabel(scene, i);
  const out = { prompt: "" };
  if (typeof scene.prompt !== "string" || scene.prompt.trim().length === 0) {
    errors.push(`${label} is missing prompt (must be a non-empty string)`);
  } else {
    out.prompt = scene.prompt;
    const wc = countWords(scene.prompt);
    if (wc > SCENE_PROMPT_MAX_WORDS) {
      errors.push(`${label} prompt is ${wc} words; cap is ${SCENE_PROMPT_MAX_WORDS} to fit within SDXL CLIP 77 tokens after triggers + style_prefix. Tighten the prompt or move appearance details to the cast bible.`);
    }
  }
  if (scene.id !== void 0 && typeof scene.id !== "string") {
    errors.push(`${label} id must be a string if provided (got ${describeType(scene.id)})`);
  }
  out.id = coerceShotId(typeof scene.id === "string" ? scene.id : void 0, i);
  validateSceneSlots(scene, label, useCharacters, out, errors);
  validateSceneDialogue(scene, label, out, errors);
  validateSceneTiming(scene, label, out, errors);
  for (const key of ["act", "start_image"]) {
    const v = scene[key];
    if (v !== void 0) {
      if (typeof v !== "string") {
        errors.push(`${label} ${key} must be a string if provided (got ${describeType(v)})`);
      } else if (key === "start_image" && !isSafeRelKey(v)) {
        errors.push(`${label} start_image must be a safe relative path (letters, digits, . _ - /, no "..", no leading "/")`);
      } else {
        out[key] = v;
      }
    }
  }
  return out;
}
__name(validateScene, "validateScene");
function validateScenesSection(input, useCharacters, errors) {
  const validatedScenes = [];
  if (!Array.isArray(input.scenes)) {
    errors.push(`scenes is required and must be a non-empty array (got ${describeType(input.scenes)})`);
  } else if (input.scenes.length === 0) {
    errors.push("scenes is required and must be a non-empty array (got empty array)");
  } else if (input.scenes.length > STORYBOARD_MAX_SCENES) {
    errors.push(`scenes count ${input.scenes.length} exceeds the hard cap of ${STORYBOARD_MAX_SCENES} (preflight warns at 24; consider splitting the storyboard or shortening the duration)`);
  } else {
    input.scenes.forEach((scene, i) => {
      const out = validateScene(scene, i, useCharacters, errors);
      if (out)
        validatedScenes.push(out);
    });
  }
  {
    const seenIds = /* @__PURE__ */ new Set();
    for (const s of validatedScenes) {
      const id = s.id;
      if (!id)
        continue;
      if (seenIds.has(id)) {
        errors.push(`duplicate shot id "${id}" (an authored id collided with an auto-numbered one; rename or renumber the scene)`);
      } else {
        seenIds.add(id);
      }
    }
  }
  return validatedScenes;
}
__name(validateScenesSection, "validateScenesSection");
function validateTopLevelFields(input, errors) {
  let fullPrompt = "";
  if (input.full_prompt !== void 0) {
    if (typeof input.full_prompt !== "string") {
      errors.push(`full_prompt must be a string if provided (got ${describeType(input.full_prompt)})`);
    } else if (input.full_prompt.length > FULL_PROMPT_MAX_CHARS) {
      errors.push(`full_prompt is ${input.full_prompt.length} chars; cap is ${FULL_PROMPT_MAX_CHARS}`);
    } else {
      fullPrompt = input.full_prompt;
    }
  }
  let stylePrefix = "";
  if (input.style_prefix !== void 0) {
    if (typeof input.style_prefix !== "string") {
      errors.push(`style_prefix must be a string if provided (got ${describeType(input.style_prefix)})`);
    } else if (input.style_prefix.length > STYLE_PREFIX_MAX_CHARS) {
      errors.push(`style_prefix is ${input.style_prefix.length} chars; cap is ${STYLE_PREFIX_MAX_CHARS} (the pod's bg-pass uses style_prefix verbatim and SDXL CLIP truncates at 77 tokens)`);
    } else {
      stylePrefix = input.style_prefix;
    }
  }
  let castRules = "";
  if (input.cast_rules !== void 0) {
    if (typeof input.cast_rules !== "string") {
      errors.push(`cast_rules must be a string if provided (got ${describeType(input.cast_rules)})`);
    } else {
      castRules = input.cast_rules;
    }
  }
  let durationSeconds;
  if (input.duration_seconds !== void 0) {
    if (!isPositiveFiniteNumber(input.duration_seconds)) {
      errors.push("duration_seconds must be a positive finite number if provided");
    } else if (input.duration_seconds > STORYBOARD_MAX_SECONDS) {
      errors.push(`duration_seconds is ${input.duration_seconds}s; cap is ${STORYBOARD_MAX_SECONDS}s (${STORYBOARD_MAX_SCENES} shots x ${SCENE_MAX_SECONDS}s)`);
    } else {
      durationSeconds = input.duration_seconds;
    }
  }
  let clipSeconds;
  if (input.clip_seconds !== void 0) {
    if (!isPositiveFiniteNumber(input.clip_seconds)) {
      errors.push("clip_seconds must be a positive finite number if provided");
    } else if (input.clip_seconds > SCENE_MAX_SECONDS) {
      errors.push(`clip_seconds is ${input.clip_seconds}s; cap is ${SCENE_MAX_SECONDS}s per shot`);
    } else {
      clipSeconds = input.clip_seconds;
    }
  }
  let refsDir;
  if (input.refs_dir !== void 0) {
    if (typeof input.refs_dir !== "string" || input.refs_dir.trim().length === 0) {
      errors.push("refs_dir must be a non-empty string if provided");
    } else if (!isSafeRelKey(input.refs_dir)) {
      errors.push('refs_dir must be a safe relative path (letters, digits, . _ - /, no "..", no leading "/")');
    } else {
      refsDir = input.refs_dir;
    }
  }
  return { fullPrompt, stylePrefix, castRules, durationSeconds, clipSeconds, refsDir };
}
__name(validateTopLevelFields, "validateTopLevelFields");
function backfillTargetSeconds(validatedScenes, clipSeconds, durationSeconds) {
  const perShotFallback = typeof clipSeconds === "number" && clipSeconds > 0 ? clipSeconds : typeof durationSeconds === "number" && durationSeconds > 0 && validatedScenes.length > 0 ? Math.round(durationSeconds / validatedScenes.length * 100) / 100 : void 0;
  for (const s of validatedScenes) {
    if (typeof s.target_seconds === "number")
      continue;
    if (typeof s.start === "number" && typeof s.end === "number" && s.end > s.start) {
      s.target_seconds = Math.round((s.end - s.start) * 100) / 100;
    } else if (perShotFallback !== void 0) {
      s.target_seconds = perShotFallback;
    }
  }
}
__name(backfillTargetSeconds, "backfillTargetSeconds");
function validateStoryboard(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        `storyboard must be an object (got ${describeType(input)})`
      ]
    };
  }
  const { title, projectName } = validateTitleSection(input, errors);
  const useCharacters = validateUseCharactersSection(input, errors);
  const validatedScenes = validateScenesSection(input, useCharacters, errors);
  const { fullPrompt, stylePrefix, castRules, durationSeconds, clipSeconds, refsDir } = validateTopLevelFields(input, errors);
  const styleCategory = normalizeStyleNone(input.style_category);
  const stylePreset = normalizeStyleNone(input.style_preset);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  backfillTargetSeconds(validatedScenes, clipSeconds, durationSeconds);
  const value = {
    title,
    projectName,
    full_prompt: fullPrompt,
    duration_seconds: durationSeconds,
    clip_seconds: clipSeconds,
    style_prefix: stylePrefix,
    style_category: styleCategory,
    style_preset: stylePreset,
    use_characters: useCharacters,
    cast_rules: castRules,
    scenes: validatedScenes
  };
  if (refsDir !== void 0)
    value.refs_dir = refsDir;
  return { ok: true, value };
}
__name(validateStoryboard, "validateStoryboard");
function normalizePerShotModels(raw, allowedModelIds) {
  const perShot = {};
  const errors = [];
  if (raw === void 0 || raw === null)
    return { perShot, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("perShot must be an object mapping shot_id to a model id");
    return { perShot, errors };
  }
  for (const [shotId, modelId] of Object.entries(raw)) {
    if (!shotId.trim())
      continue;
    if (typeof modelId !== "string" || !modelId) {
      errors.push(`perShot["${shotId}"] must be a model id string`);
      continue;
    }
    if (!allowedModelIds.has(modelId)) {
      errors.push(`perShot["${shotId}"] "${modelId}" is not an image-input video model`);
      continue;
    }
    perShot[shotId] = modelId;
  }
  return { perShot, errors };
}
__name(normalizePerShotModels, "normalizePerShotModels");
function normalizeHybridBackends(raw, allowedModelIds) {
  const backends = {};
  const errors = [];
  if (raw === void 0 || raw === null)
    return { backends, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("backends must be an object mapping shot_id to { backend, model? }");
    return { backends, errors };
  }
  for (const [shotId, v] of Object.entries(raw)) {
    if (!shotId.trim())
      continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errors.push(`backends["${shotId}"] must be an object { backend, model? }`);
      continue;
    }
    const backend = v.backend;
    if (backend !== "gpu" && backend !== "cloud") {
      errors.push(`backends["${shotId}"].backend must be "gpu" or "cloud"`);
      continue;
    }
    const entry = { backend };
    if (backend === "cloud") {
      const model = v.model;
      if (model !== void 0) {
        if (typeof model !== "string" || !allowedModelIds.has(model)) {
          errors.push(`backends["${shotId}"].model "${String(model)}" is not an image-input video model`);
          continue;
        }
        entry.model = model;
      }
    }
    backends[shotId] = entry;
  }
  return { backends, errors };
}
__name(normalizeHybridBackends, "normalizeHybridBackends");

// node_modules/@skyphusion-labs/vivijure-core/dist/planner-yaml.js
function escapeForDoubleQuoted(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
__name(escapeForDoubleQuoted, "escapeForDoubleQuoted");
function quote(s) {
  return `"${escapeForDoubleQuoted(s)}"`;
}
__name(quote, "quote");
function emitSlotList(slots) {
  return `[${slots.join(", ")}]`;
}
__name(emitSlotList, "emitSlotList");
function emitScene(scene) {
  const lines = [];
  lines.push(`  - prompt: ${quote(scene.prompt)}`);
  const inner = "    ";
  if (scene.id !== void 0)
    lines.push(`${inner}id: ${quote(scene.id)}`);
  if (scene.character_slots !== void 0) {
    lines.push(`${inner}character_slots: ${emitSlotList(scene.character_slots)}`);
  }
  if (scene.act !== void 0)
    lines.push(`${inner}act: ${quote(scene.act)}`);
  if (scene.start !== void 0)
    lines.push(`${inner}start: ${scene.start}`);
  if (scene.end !== void 0)
    lines.push(`${inner}end: ${scene.end}`);
  if (scene.target_seconds !== void 0) {
    lines.push(`${inner}target_seconds: ${scene.target_seconds}`);
  }
  if (scene.start_image !== void 0) {
    lines.push(`${inner}start_image: ${quote(scene.start_image)}`);
  }
  if (scene.dialogue !== void 0) {
    lines.push(`${inner}dialogue:`);
    lines.push(`${inner}  slot: ${scene.dialogue.slot}`);
    lines.push(`${inner}  text: ${quote(scene.dialogue.text)}`);
  }
  return lines;
}
__name(emitScene, "emitScene");
function parseStoryboardScenes(yaml, defaultSeconds = 4) {
  const out = [];
  let inScenes = false;
  let idx = 0;
  let curId = null;
  let curPrompt = null;
  let curTarget = null;
  let curDlgSlot = null;
  let curDlgText = null;
  const flush = /* @__PURE__ */ __name(() => {
    if (idx === 0 || !curPrompt)
      return;
    const shot = curId || `shot_${String(idx).padStart(2, "0")}`;
    const scene = {
      shot_id: shot,
      prompt: curPrompt,
      seconds: curTarget !== null && curTarget > 0 ? curTarget : defaultSeconds
    };
    if (curDlgSlot && curDlgText)
      scene.dialogue = { slot: curDlgSlot, text: curDlgText };
    out.push(scene);
  }, "flush");
  for (const line of yaml.split(/\r?\n/)) {
    if (!inScenes) {
      if (/^scenes:\s*$/.test(line))
        inScenes = true;
      continue;
    }
    const promptM = line.match(/^ {2}- prompt: "((?:[^"\\]|\\.)*)"\s*$/);
    if (promptM) {
      flush();
      idx++;
      curId = null;
      curTarget = null;
      curDlgSlot = null;
      curDlgText = null;
      curPrompt = promptM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const idM = line.match(/^ {4}id:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (idM) {
      curId = idM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const tsM = line.match(/^ {4}target_seconds:\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (tsM) {
      curTarget = parseFloat(tsM[1]);
      continue;
    }
    const dlgSlotM = line.match(/^ {6}slot:\s*([A-Za-z0-9_]+)\s*$/);
    if (dlgSlotM) {
      curDlgSlot = dlgSlotM[1];
      continue;
    }
    const dlgTextM = line.match(/^ {6}text:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (dlgTextM) {
      curDlgText = dlgTextM[1].replace(/\\(.)/g, "$1");
    }
  }
  flush();
  return out;
}
__name(parseStoryboardScenes, "parseStoryboardScenes");
function serializeStoryboardYaml(value) {
  const lines = [];
  lines.push(`title: ${quote(value.title)}`);
  lines.push(`full_prompt: ${quote(value.full_prompt)}`);
  if (value.duration_seconds !== void 0) {
    lines.push(`duration_seconds: ${value.duration_seconds}`);
  }
  if (value.clip_seconds !== void 0) {
    lines.push(`clip_seconds: ${value.clip_seconds}`);
  }
  lines.push(`style_prefix: ${quote(value.style_prefix)}`);
  lines.push(`style_category: ${quote(value.style_category)}`);
  lines.push(`style_preset: ${quote(value.style_preset)}`);
  lines.push(`use_characters: ${emitSlotList(value.use_characters)}`);
  lines.push(`cast_rules: ${quote(value.cast_rules)}`);
  if (value.refs_dir !== void 0) {
    lines.push(`refs_dir: ${quote(value.refs_dir)}`);
  }
  lines.push("scenes:");
  for (const scene of value.scenes) {
    for (const sceneLine of emitScene(scene)) {
      lines.push(sceneLine);
    }
  }
  return lines.join("\n") + "\n";
}
__name(serializeStoryboardYaml, "serializeStoryboardYaml");

// node_modules/@skyphusion-labs/vivijure-core/dist/bundle-assembler.js
function safeCharFilename(slot, name) {
  const trimmed = name.trim();
  const noPath = trimmed.replace(/[/\\\0]/g, "_").replace(/\.\.+/g, "_");
  const safe = noPath.replace(/ /g, "_").slice(0, 40) || slot;
  return `char_${slot}_${safe}.png`;
}
__name(safeCharFilename, "safeCharFilename");
function detectImageExt(bytes) {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "jpg";
  }
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
    return "webp";
  }
  return "png";
}
__name(detectImageExt, "detectImageExt");
function decodeDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:([\w./+-]+);base64,(.+)$/);
  if (!m)
    return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
      bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
__name(decodeDataUrl, "decodeDataUrl");
async function resolveImage(env, img, label) {
  if (img.dataUrl) {
    const bytes = decodeDataUrl(img.dataUrl);
    if (!bytes)
      return { error: `${label}: invalid data URL` };
    return { bytes, ext: detectImageExt(bytes) };
  }
  if (img.key) {
    const obj = await env.R2_RENDERS.get(img.key);
    if (!obj)
      return { error: `${label}: R2 object not found at key "${img.key}"` };
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return { bytes, ext: detectImageExt(bytes) };
  }
  return { error: `${label}: must provide either { key } or { dataUrl }` };
}
__name(resolveImage, "resolveImage");
async function sha256HexBytes(bytes) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", ab);
  const b = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < b.length; i++)
    s += b[i].toString(16).padStart(2, "0");
  return s;
}
__name(sha256HexBytes, "sha256HexBytes");
async function bundleKeyFor(projectName, tarBytes) {
  const contentHash = (await sha256HexBytes(tarBytes)).slice(0, 16);
  return `bundles/${projectName}-${contentHash}.tar.gz`;
}
__name(bundleKeyFor, "bundleKeyFor");
async function callImagePrep(env, payload, opts = {}) {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  };
  let resp = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await env.IMAGE_PREP_VPC.fetch("http://image-prep/portrait/prep", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503)
      return resp;
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  return resp;
}
__name(callImagePrep, "callImagePrep");
async function prepPortraitBytes(env, bytes, sourceKey) {
  try {
    const hash = await sha256HexBytes(bytes);
    const cleanKey = `cast-clean/${hash}.png`;
    const cached = await env.R2_RENDERS.get(cleanKey);
    if (cached)
      return new Uint8Array(await cached.arrayBuffer());
    let srcKey = sourceKey;
    if (!srcKey) {
      srcKey = `cast-clean/src/${hash}.png`;
      await env.R2_RENDERS.put(srcKey, bytes, { httpMetadata: { contentType: "image/png" } });
    }
    const inputUrl = await presignR2Get(env, srcKey, 300);
    const outputUrl = await presignR2Put(env, cleanKey, 300);
    const resp = await callImagePrep(env, {
      inputUrl,
      outputUrl,
      outputKey: cleanKey,
      background: "alpha"
    });
    if (!resp || !resp.ok) {
      console.warn(`image-prep failed (status ${resp ? resp.status : "network"}) for ${cleanKey}; using original portrait`);
      return null;
    }
    const out = await env.R2_RENDERS.get(cleanKey);
    if (!out) {
      console.warn(`image-prep reported ok but ${cleanKey} missing in R2; using original portrait`);
      return null;
    }
    return new Uint8Array(await out.arrayBuffer());
  } catch (err) {
    console.warn(`image-prep threw (${err instanceof Error ? err.message : String(err)}); using original portrait`);
    return null;
  }
}
__name(prepPortraitBytes, "prepPortraitBytes");
async function assembleBundle(env, args) {
  const validation = validateStoryboard(args.storyboard);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.map((e) => `storyboard: ${e}`) };
  }
  const storyboard = validation.value;
  const errors = [];
  const files = [];
  files.push({
    name: "storyboard.yaml",
    content: new TextEncoder().encode(serializeStoryboardYaml(storyboard))
  });
  const registryCharacters = {};
  for (const slot of storyboard.use_characters) {
    const ref = args.characterRefs[slot];
    if (!ref) {
      errors.push(`characterRefs missing entry for slot "${slot}" (referenced in storyboard.use_characters)`);
      continue;
    }
    if (!ref.name || ref.name.trim().length === 0) {
      errors.push(`characterRefs[${slot}].name is required (non-empty string)`);
      continue;
    }
    if (!Array.isArray(ref.trainingImages) || ref.trainingImages.length === 0) {
      errors.push(`characterRefs[${slot}].trainingImages is required (non-empty array)`);
      continue;
    }
    const portraitSrc = ref.portrait ?? ref.trainingImages[0];
    const portraitResolved = await resolveImage(env, portraitSrc, `characterRefs[${slot}].portrait`);
    if ("error" in portraitResolved) {
      errors.push(portraitResolved.error);
      continue;
    }
    const cleanedPortrait = await prepPortraitBytes(env, portraitResolved.bytes, portraitSrc.key);
    const portraitFilename = safeCharFilename(slot, ref.name);
    files.push({
      name: `characters/${portraitFilename}`,
      content: cleanedPortrait ?? portraitResolved.bytes
    });
    for (let i = 0; i < ref.trainingImages.length; i++) {
      const img = ref.trainingImages[i];
      const resolved = await resolveImage(env, img, `characterRefs[${slot}].trainingImages[${i}]`);
      if ("error" in resolved) {
        errors.push(resolved.error);
        continue;
      }
      const num = String(i + 1).padStart(2, "0");
      const innerName = img.filename ?? `ref_${num}.${resolved.ext}`;
      files.push({
        name: `characters/refs/${slot}/${innerName}`,
        content: resolved.bytes
      });
    }
    registryCharacters[slot] = {
      name: ref.name,
      prompt: ref.prompt ?? "",
      image: `characters/${portraitFilename}`
    };
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  files.push({
    name: "characters/registry.json",
    content: new TextEncoder().encode(JSON.stringify({ characters: registryCharacters }, null, 2) + "\n")
  });
  if (args.startImage) {
    const startResolved = await resolveImage(env, args.startImage, "startImage");
    if ("error" in startResolved) {
      return { ok: false, errors: [startResolved.error] };
    }
    files.push({
      name: "start_image.png",
      content: startResolved.bytes
    });
  }
  if (args.sceneStartImages) {
    const sceneIds = new Set(storyboard.scenes.map((s, i) => s.id || `shot_${String(i + 1).padStart(2, "0")}`));
    for (const [sceneId, img] of Object.entries(args.sceneStartImages)) {
      if (!sceneIds.has(sceneId)) {
        return {
          ok: false,
          errors: [`sceneStartImages: "${sceneId}" is not a scene id in the storyboard`]
        };
      }
      const resolved = await resolveImage(env, img, `sceneStartImages["${sceneId}"]`);
      if ("error" in resolved) {
        return { ok: false, errors: [resolved.error] };
      }
      files.push({
        name: `clips/${sceneId}_keyframe.png`,
        content: resolved.bytes
      });
    }
  }
  const tarBytes = emitTar(files);
  const gz = await gzipBytes(tarBytes);
  const bundleKey = await bundleKeyFor(storyboard.projectName, tarBytes);
  await env.R2_RENDERS.put(bundleKey, gz, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { source: "skyphusion-planner" }
  });
  return {
    ok: true,
    bundleKey,
    sizeBytes: gz.length,
    fileCount: files.length
  };
}
__name(assembleBundle, "assembleBundle");

// node_modules/@skyphusion-labs/vivijure-core/dist/preflight.js
function checkStoryboardShape(storyboard) {
  const issues = [];
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const loadedSlots = new Set(Array.isArray(storyboard.use_characters) ? storyboard.use_characters : []);
  if (scenes.length === 0) {
    issues.push({ level: "error", scope: "scenes", message: "storyboard has no scenes" });
    return issues;
  }
  if (scenes.length > 24) {
    issues.push({
      level: "warning",
      scope: "scenes",
      message: `${scenes.length} scenes is a lot for one render; consider splitting (>15 min Wan I2V time)`
    });
  }
  scenes.forEach((scene, idx) => {
    const sid = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const scope = `scene[${sid}]`;
    if (!scene.prompt || !scene.prompt.trim()) {
      issues.push({ level: "error", scope, message: `${sid} has an empty prompt` });
    } else if (scene.prompt.trim().length < 8) {
      issues.push({
        level: "warning",
        scope,
        message: `${sid} prompt is very short (${scene.prompt.trim().length} chars); the keyframe model may underspecify`
      });
    }
    if (Array.isArray(scene.character_slots)) {
      for (const slot of scene.character_slots) {
        if (!loadedSlots.has(slot)) {
          issues.push({
            level: "error",
            scope,
            message: `${sid} references slot "${slot}" which is not in use_characters`
          });
        }
      }
    }
    if (typeof scene.target_seconds === "number") {
      if (scene.target_seconds <= 0) {
        issues.push({
          level: "error",
          scope,
          message: `${sid} has target_seconds <= 0 (got ${scene.target_seconds})`
        });
      } else if (scene.target_seconds < 1.5) {
        issues.push({
          level: "warning",
          scope,
          message: `${sid} target_seconds is ${scene.target_seconds}s; Wan I2V default minimum is ~1.5s`
        });
      } else if (scene.target_seconds > 12) {
        issues.push({
          level: "warning",
          scope,
          message: `${sid} target_seconds is ${scene.target_seconds}s; long clips often look static`
        });
      }
    }
  });
  return issues;
}
__name(checkStoryboardShape, "checkStoryboardShape");
function checkCastBindingsReady(bindings, catalog, keyframeLabel = "SDXL") {
  const issues = [];
  if (!bindings)
    return issues;
  const byId = new Map(catalog.map((c) => [c.id, c]));
  for (const slot of Object.keys(bindings)) {
    const id = bindings[slot];
    const member = byId.get(id);
    const scope = `cast[${slot}]`;
    if (!member) {
      issues.push({
        level: "error",
        scope,
        message: `slot ${slot} is bound to cast id ${id} which no longer exists`
      });
      continue;
    }
    const refCount = member.ref_keys?.length ?? 0;
    if (!member.portrait_key) {
      issues.push({
        level: "error",
        scope,
        message: `${member.name} (slot ${slot}) has no portrait; render will fail at the ${keyframeLabel} keyframe stage`
      });
    }
    if (refCount === 0) {
      issues.push({
        level: "error",
        scope,
        message: `${member.name} (slot ${slot}) has no training refs; LoRA training will fail`
      });
    } else if (refCount < 4) {
      issues.push({
        level: "warning",
        scope,
        message: `${member.name} (slot ${slot}) has only ${refCount} training refs; 4-8 is recommended for stable LoRAs`
      });
    }
  }
  return issues;
}
__name(checkCastBindingsReady, "checkCastBindingsReady");
function resolveCastBindings(bindings, catalog) {
  const resolved = {};
  const unresolved = [];
  if (!bindings)
    return { resolved, unresolved };
  const byNumericId = new Map(catalog.map((c) => [c.id, c]));
  const byPublicId = /* @__PURE__ */ new Map();
  for (const c of catalog) {
    if (typeof c.public_id === "string" && c.public_id)
      byPublicId.set(c.public_id, c);
  }
  for (const slot of Object.keys(bindings)) {
    const value = bindings[slot];
    const scope = `cast[${slot}]`;
    if (typeof value === "number" || typeof value === "string" && /^[0-9]+$/.test(value)) {
      const numeric = typeof value === "number" ? value : Number(value);
      if (byNumericId.has(numeric)) {
        resolved[slot] = numeric;
      } else {
        unresolved.push({
          level: "error",
          scope,
          message: `slot ${slot} is bound to unknown cast id ${numeric} (no cast member has this numeric id)`
        });
      }
      continue;
    }
    if (typeof value === "string") {
      const member = byPublicId.get(value);
      if (member) {
        resolved[slot] = member.id;
      } else {
        unresolved.push({
          level: "error",
          scope,
          message: `slot ${slot} is bound to unknown cast id "${value}" (no cast member has this public id)`
        });
      }
      continue;
    }
    unresolved.push({
      level: "error",
      scope,
      message: `slot ${slot} is bound to an invalid cast id (${value === null ? "null" : typeof value}); expected a cast public id or numeric row id`
    });
  }
  return { resolved, unresolved };
}
__name(resolveCastBindings, "resolveCastBindings");
function checkDurationGrid(storyboard, grid, quality, backendName = "the selected motion backend", floorFraction) {
  const issues = [];
  if (!grid || typeof grid.fps !== "number" || !(grid.fps > 0) || !grid.tiers)
    return issues;
  const caps = Object.entries(grid.tiers).filter((e) => typeof e[1]?.max_frames === "number" && e[1].max_frames > 0);
  if (caps.length === 0)
    return issues;
  const declared = quality ? caps.find(([t]) => t === quality) : void 0;
  const maxFrames = declared ? declared[1].max_frames : Math.max(...caps.map(([, t]) => t.max_frames));
  const maxSeconds = Math.round(maxFrames / grid.fps * 1e3) / 1e3;
  const tierPhrase = declared ? `at the ${declared[0]} tier` : "even at its largest tier";
  const gateArmed = typeof floorFraction === "number" && floorFraction > 0;
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  scenes.forEach((scene, idx) => {
    const sid = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const planned = typeof scene.target_seconds === "number" ? scene.target_seconds : typeof storyboard.clip_seconds === "number" ? storyboard.clip_seconds : void 0;
    if (planned === void 0 || !(planned > 0))
      return;
    if (planned > maxSeconds + 1e-3) {
      const floorSeconds = gateArmed ? Math.round(floorFraction * planned * 1e3) / 1e3 : 0;
      const breachesFloor = gateArmed && maxSeconds < floorSeconds - 1e-3;
      issues.push(breachesFloor ? {
        level: "error",
        scope: `scene[${sid}]`,
        message: `${sid} plans ${planned}s but ${backendName} delivers at most ${maxSeconds}s ${tierPhrase} (${maxFrames} frames at ${grid.fps}fps) -- below the ${Math.round(floorFraction * 100)}% duration floor (${floorSeconds}s), so this render would fail the duration gate. Shorten the shot to <= ${maxSeconds}s or choose a backend/tier that delivers more frames.`
      } : {
        level: "warning",
        scope: `scene[${sid}]`,
        message: `${sid} plans ${planned}s but ${backendName} delivers at most ${maxSeconds}s ${tierPhrase} (${maxFrames} frames at ${grid.fps}fps); the clip will be clamped`
      });
    }
  });
  return issues;
}
__name(checkDurationGrid, "checkDurationGrid");
function summarize(issues) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues)
    counts[i.level]++;
  return {
    ok: counts.error === 0,
    counts,
    issues
  };
}
__name(summarize, "summarize");

// node_modules/@skyphusion-labs/vivijure-core/dist/planner-prompt.js
function buildPlanningSystemPrompt() {
  return `You are the storyboard planner for a music-video / short-film AI pipeline.
Your output is consumed directly by a renderer that turns each scene into
a Wan I2V clip with an SDXL keyframe. Return ONE JSON object that exactly
matches the schema below. No prose. No markdown. No YAML. Do not wrap the
JSON in code fences.

SCHEMA:
{
  "title": string,
  "full_prompt": string,
  "duration_seconds": number,
  "clip_seconds": number,
  "style_prefix": string,
  "style_category": string,
  "style_preset": string,
  "use_characters": ["A" | "B" | "C" | "D", ...],
  "cast_rules": string,
  "scenes": [
    {
      "prompt": string,
      "character_slots": ["A" | "B" | "C" | "D", ...],
      "act": string,
      "start": number,
      "end": number,
      "target_seconds": number,
      "dialogue": { "slot": "A" | "B" | "C" | "D", "text": string }
    },
    ...
  ]
}

FIELDS:
- title: short film title; spaces become underscores in the on-disk slug.
- full_prompt: one or two sentence film-level summary (optional).
- duration_seconds: total film length target in seconds (positive number).
- clip_seconds: per-shot target length in seconds (positive number).
- style_prefix: ALL style language goes here, EXACTLY ONCE. Palette, lens,
  era, lighting register, film stock, color grade, key visual vocabulary.
  The renderer prepends this string verbatim to every scene prompt at
  manifest-build time, so any style word repeated inside a scene prompt
  is double-applied and biases the keyframe.
- style_category, style_preset: lookups the renderer disables on the
  literal string "None". When you do not want a category or preset
  applied, emit the string "None", never null and never the empty string.
- use_characters: slot ids loaded for this render. Slot ids are exactly
  the literal strings "A", "B", "C", "D". Nothing else is valid. Set this
  to the slots you plan to feature; omit slots that will not appear.
- cast_rules: optional plain-text rules for cast cohesion (pairings,
  outfit constraints, prop continuity).
- scenes: REQUIRED, at least one entry, one per shot.
- scenes[].prompt: SHOT CONTENT ONLY. Subject action, framing, moment,
  emotional beat. Do NOT include style language; that lives in
  style_prefix above. Do NOT repeat the film title or full_prompt.
- scenes[].character_slots: subset of use_characters. Omit the field
  entirely for an empty-frame shot rather than send an unloaded slot.
- scenes[].act: optional act tag, one of "opening", "rising", "turn",
  "climax", "resolution".
- scenes[].start, end, target_seconds: optional per-shot timing in
  seconds. start may be 0; end must be strictly greater than start;
  target_seconds must be positive.
- scenes[].dialogue: OPTIONAL spoken line for the shot (auto-direction).
  Include it ONLY when a character actually speaks on camera in that shot.
  "slot" is the speaking character and MUST be one of that scene's
  character_slots. "text" is the line itself: natural spoken words only,
  no quotation marks, no "Name:" speaker prefix, no stage directions. Keep
  it short enough to be said within the shot's length (roughly 2-3 spoken
  words per second). Omit the field entirely for a silent shot.

HARD RULES:
1. style_prefix is the ONLY place style language belongs. Repeating style
   words inside scenes[].prompt double-applies them because style_prefix
   is prepended to every scene at manifest-build time.
2. Every entry in a scene's character_slots must appear in the top-level
   use_characters array. Never lock a scene to a slot you have not loaded.
3. Slot ids are exactly "A", "B", "C", "D". No lowercase, no other letters.
4. style_category and style_preset default to the literal string "None"
   when you do not want a lookup. Never null. Never empty string.
5. Numeric fields are plain JSON numbers, never strings. No units ("s",
   "sec", "min"); seconds is implicit.
6. Plan 3 to 12 scenes for a vignette / single-track music video unless
   the brief specifies otherwise.
6a. A scene's dialogue.slot MUST be one of that scene's character_slots
    (the speaker has to be in the shot). Only one character speaks per
    shot. Most shots have no dialogue; reserve it for genuine spoken beats.

LENGTH CAPS (the renderer rejects outputs over these caps because they
overflow SDXL's CLIP 77-token text encoder or break manifest builds):
7. Each scenes[].prompt: at most ${SCENE_PROMPT_MAX_WORDS} words. The pod
   prepends 2-4 LoRA trigger tokens plus the style_prefix to every scene,
   leaving roughly ${SCENE_PROMPT_MAX_WORDS}-word headroom inside CLIP 77.
   Move character appearance details to the cast bible (already loaded),
   not into the scene prompt.
8. style_prefix: at most ${STYLE_PREFIX_MAX_CHARS} characters. Compress.
   Three or four palette / lens / lighting clauses is plenty; the model
   reads ALL of it once per scene, so verbosity here costs every shot.
9. full_prompt: at most ${FULL_PROMPT_MAX_CHARS} characters. This is the
   film-level summary, not the script; one or two sentences.
10. scenes array length: at most ${STORYBOARD_MAX_SCENES} entries. A 50-
    shot render is already 25+ minutes of GPU time at typical clip
    seconds; if the brief implies more, shorten clip_seconds or split.
11. scenes[].dialogue.text: at most ${DIALOGUE_MAX_CHARS} characters. One
    spoken line per shot; a clip is only a few seconds, so a sentence or
    two is the ceiling, not a speech.

GOLDEN EXAMPLE (mirrors the renderer's storyboard.example.yaml). This
shape is the canonical output; produce JSON that matches its style:

{
  "title": "morning_walk",
  "full_prompt": "Three-shot vignette: Elena walks into a hilltop clearing at dawn.",
  "duration_seconds": 21,
  "clip_seconds": 7,
  "style_prefix": "cinematic 35mm film, soft golden hour light, shallow depth of field",
  "style_category": "None",
  "style_preset": "None",
  "use_characters": ["A"],
  "cast_rules": "",
  "scenes": [
    {
      "prompt": "Wide establishing shot of a quiet hilltop at dawn, mist over the valley below.",
      "act": "opening"
    },
    {
      "prompt": "Elena walks into frame from the left, looks out over the valley, wind in her coat.",
      "character_slots": ["A"],
      "act": "rising"
    },
    {
      "prompt": "Close-up on Elena's face, soft side light, expression of quiet resolve, eyes catching the last warm light.",
      "character_slots": ["A"],
      "act": "turn"
    }
  ]
}

What that example demonstrates concretely:
- Each scene's prompt is ~15-25 words: subject + action + framing +
  one beat of mood. Well inside the ${SCENE_PROMPT_MAX_WORDS}-word cap.
- The cast member is referenced by NAME ("Elena"), not by slot id.
  The slot id only appears in scenes[].character_slots, never in prose.
- Scene 1 omits character_slots entirely because nothing in the prompt
  references a character. Do NOT send character_slots:[] either; omit
  the field. (The example.yaml puts ["A"] on every shot; both forms
  are accepted, but omitting is clearer for empty-frame shots.)
- No appearance details in any scene prompt (no "red hair, green coat",
  no "weathered older man"). The cast bible carries those; the renderer
  prepends a LoRA trigger that injects the appearance vector for you.
- No style language in any scene prompt: "cinematic", "35mm",
  "golden hour" all live in style_prefix and are prepended once per
  shot. Repeating them inside a scene double-applies them.
- style_category and style_preset are literal "None" strings (never
  null, never empty) because the renderer disables on the string.
- act values are lowercase: "opening", "rising", "turn", "climax",
  "resolution". Each scene optionally tagged.

Return ONLY the JSON object. Nothing before it. Nothing after it.`;
}
__name(buildPlanningSystemPrompt, "buildPlanningSystemPrompt");
function buildPlanningUserMessage(brief, characters, beatBlock) {
  const sorted = [...characters].sort((a, b) => a.slot.localeCompare(b.slot));
  const castLines = sorted.length === 0 ? ["(none)"] : sorted.map((c) => `${c.slot}) ${c.name}: ${c.bible}`);
  const parts = [
    "BRIEF:",
    brief.trim(),
    "",
    "CAST LOADED FOR THIS RENDER:",
    ...castLines,
    ""
  ];
  if (beatBlock && beatBlock.trim().length > 0) {
    parts.push(beatBlock.trim(), "");
  }
  parts.push("Plan the storyboard and return the JSON now.");
  return parts.join("\n");
}
__name(buildPlanningUserMessage, "buildPlanningUserMessage");
function buildRefinementSystemPrompt() {
  return `You are refining an existing storyboard for a music-video / short-film AI
pipeline. The user will request specific changes (add a scene, rewrite a
prompt, shorten a shot, swap which character appears, etc.). Apply EXACTLY
the requested change and PRESERVE everything else unchanged. Return ONE
JSON object matching the same schema the planner uses:

{
  "title": string,
  "full_prompt": string,
  "duration_seconds": number,
  "clip_seconds": number,
  "style_prefix": string,
  "style_category": string,
  "style_preset": string,
  "use_characters": ["A" | "B" | "C" | "D", ...],
  "cast_rules": string,
  "scenes": [
    {
      "prompt": string,
      "character_slots": ["A" | "B" | "C" | "D", ...],
      "act": string,
      "start": number,
      "end": number,
      "target_seconds": number,
      "dialogue": { "slot": "A" | "B" | "C" | "D", "text": string }
    },
    ...
  ]
}

REFINEMENT RULES:
- If the user is silent about a field, KEEP THE OLD VALUE BIT-FOR-BIT.
  Do not paraphrase prompts the user did not ask you to touch. Do not
  re-tune target_seconds the user did not mention. Stability matters.
- If the user asks for a new scene, place it at the position they request
  ("before the ending", "after scene 2", "first"); when ambiguous, append.
- If the user asks to delete a scene, remove the entry; preserve the order
  of the remaining scenes.
- character_slots on each scene must be a subset of use_characters. If
  the user adds a new character or removes one, also update use_characters.
- dialogue: KEEP each scene's existing dialogue bit-for-bit unless the user
  asks to change it. When you do edit or add a line, dialogue.slot must be
  one of that scene's character_slots, "text" is plain spoken words (no
  quotes, no speaker prefix), and at most ${DIALOGUE_MAX_CHARS} characters.
- style_prefix carries ALL style language. Do not add style words to
  individual scene prompts; the renderer prepends style_prefix to every
  scene at manifest-build time, so style words inside a scene double-apply.
- style_category and style_preset are "None" literal strings unless the
  user explicitly names a category / preset. Never null. Never empty.

LENGTH CAPS (same caps as the planner; the renderer rejects outputs
over these because they overflow SDXL's CLIP 77-token text encoder):
- Each scenes[].prompt: at most ${SCENE_PROMPT_MAX_WORDS} words. If the
  user asks you to add detail to a scene, tighten the existing wording
  rather than letting the word count drift past the cap.
- style_prefix: at most ${STYLE_PREFIX_MAX_CHARS} characters. If the user
  asks to expand the style, compress earlier clauses to make room.
- full_prompt: at most ${FULL_PROMPT_MAX_CHARS} characters.
- scenes array length: at most ${STORYBOARD_MAX_SCENES} entries. If the
  user asks for more shots than the cap allows, add as many as fit
  under the cap and keep the remaining requested scenes for a future
  refinement turn; never let the array exceed the cap.

CANONICAL SHAPE (any new or edited scene must match this style;
mirrors the renderer's storyboard.example.yaml):

{
  "scenes": [
    {
      "prompt": "Wide establishing shot of a quiet hilltop at dawn, mist over the valley below.",
      "act": "opening"
    },
    {
      "prompt": "Elena walks into frame from the left, looks out over the valley, wind in her coat.",
      "character_slots": ["A"],
      "act": "rising"
    },
    {
      "prompt": "Close-up on Elena's face, soft side light, expression of quiet resolve, eyes catching the last warm light.",
      "character_slots": ["A"],
      "act": "turn"
    }
  ]
}

What that example demonstrates:
- Each prompt is ~15-25 words; subject + action + framing + one beat
  of mood. No style language, no appearance descriptors.
- Cast referenced by NAME in prose; slot id only in character_slots.
- character_slots omitted entirely for empty-frame shots (don't send
  an empty array).
- act tags lowercase: opening / rising / turn / climax / resolution.

Return ONLY the JSON object. No prose, no markdown, no fences.`;
}
__name(buildRefinementSystemPrompt, "buildRefinementSystemPrompt");
function buildRefinementUserMessage(currentStoryboard, message) {
  return [
    "CURRENT STORYBOARD:",
    JSON.stringify(currentStoryboard, null, 2),
    "",
    "USER REQUEST:",
    message.trim(),
    "",
    "Return the updated storyboard JSON now."
  ].join("\n");
}
__name(buildRefinementUserMessage, "buildRefinementUserMessage");

// node_modules/@skyphusion-labs/vivijure-core/dist/voices.js
var VOICE_IDS = [
  "angus",
  "asteria",
  "arcas",
  "orion",
  "orpheus",
  "athena",
  "luna",
  "zeus",
  "perseus",
  "helios",
  "hera",
  "stella"
];
var DEFAULT_VOICE_ID = "angus";
function voiceLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
__name(voiceLabel, "voiceLabel");
var VOICE_CATALOG = VOICE_IDS.map((id) => ({ id, label: voiceLabel(id) }));
var VOICE_ID_SET = new Set(VOICE_IDS);
function isValidVoiceId(value) {
  return typeof value === "string" && VOICE_ID_SET.has(value);
}
__name(isValidVoiceId, "isValidVoiceId");
function coerceVoiceId(value) {
  return isValidVoiceId(value) ? value : null;
}
__name(coerceVoiceId, "coerceVoiceId");

// node_modules/@skyphusion-labs/vivijure-core/dist/dialogue-lines.js
function extractScenes(storyboard) {
  if (!storyboard || typeof storyboard !== "object")
    return [];
  const scenes = storyboard.scenes;
  return Array.isArray(scenes) ? scenes : [];
}
__name(extractScenes, "extractScenes");
function buildDialogueLines(storyboard, voices, shotIds) {
  const scenes = extractScenes(storyboard);
  if (!scenes.length)
    return [];
  const want = new Set(shotIds);
  const lines = [];
  scenes.forEach((scene, i) => {
    const dlg = scene.dialogue;
    if (!dlg || typeof dlg !== "object")
      return;
    const slot = dlg.slot;
    const text = dlg.text;
    if (typeof slot !== "string" || typeof text !== "string" || !text.trim())
      return;
    const shotId = coerceShotId(typeof scene.id === "string" ? scene.id : void 0, i);
    if (!want.has(shotId))
      return;
    const voice = coerceVoiceId(voices[slot]) ?? DEFAULT_VOICE_ID;
    lines.push({ shot_id: shotId, text: text.trim(), voice_id: voice });
  });
  return lines;
}
__name(buildDialogueLines, "buildDialogueLines");
function resolveExplicitLineVoices(lines, scenes, voices) {
  const slotByShot = /* @__PURE__ */ new Map();
  for (const s of scenes) {
    if (s.dialogue && typeof s.dialogue.slot === "string")
      slotByShot.set(s.shot_id, s.dialogue.slot);
  }
  return lines.map((line) => {
    if (typeof line.voice_id === "string" && line.voice_id.trim())
      return line;
    const slot = slotByShot.get(line.shot_id);
    const voice = (slot !== void 0 ? coerceVoiceId(voices[slot]) : void 0) ?? DEFAULT_VOICE_ID;
    return { ...line, voice_id: voice };
  });
}
__name(resolveExplicitLineVoices, "resolveExplicitLineVoices");
function dialogueLinesFromBundleScenes(scenes, voices) {
  const lines = [];
  for (const s of scenes) {
    const dlg = s.dialogue;
    if (!dlg || typeof dlg.text !== "string" || !dlg.text.trim())
      continue;
    const voice = coerceVoiceId(voices[dlg.slot]) ?? DEFAULT_VOICE_ID;
    lines.push({ shot_id: s.shot_id, text: dlg.text.trim(), voice_id: voice });
  }
  return lines;
}
__name(dialogueLinesFromBundleScenes, "dialogueLinesFromBundleScenes");

// node_modules/@skyphusion-labs/vivijure-core/dist/bundle-storyboard.js
function readTarString(header, offset, width) {
  let s = "";
  for (let i = 0; i < width; i++) {
    const c = header[offset + i];
    if (c === 0)
      break;
    s += String.fromCharCode(c);
  }
  return s;
}
__name(readTarString, "readTarString");
function parseTarOctal(header, offset, width) {
  const raw = readTarString(header, offset, width).trim();
  if (!raw)
    return 0;
  return parseInt(raw, 8) || 0;
}
__name(parseTarOctal, "parseTarOctal");
function listTarNames(tar) {
  const names = [];
  let offset = 0;
  for (; ; ) {
    if (offset + 512 > tar.length)
      break;
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0))
      break;
    const name = readTarString(header, 0, 100);
    const size = parseTarOctal(header, 124, 12);
    offset += 512;
    if (offset + size > tar.length)
      break;
    offset += Math.ceil(size / 512) * 512;
    if (name)
      names.push(name);
  }
  return names;
}
__name(listTarNames, "listTarNames");
function extractTarBytes(tar, wantName) {
  let offset = 0;
  for (; ; ) {
    if (offset + 512 > tar.length)
      break;
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0))
      break;
    const name = readTarString(header, 0, 100);
    const size = parseTarOctal(header, 124, 12);
    offset += 512;
    if (offset + size > tar.length)
      break;
    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (name === wantName)
      return content;
  }
  return null;
}
__name(extractTarBytes, "extractTarBytes");
function extractTarText(tar, wantName) {
  const bytes = extractTarBytes(tar, wantName);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
__name(extractTarText, "extractTarText");
async function readBundleStoryboardYaml(env, bundleKey) {
  const obj = await env.R2_RENDERS.get(bundleKey);
  if (!obj)
    return null;
  const compressed = await obj.arrayBuffer();
  const tarStream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tarBuf = new Uint8Array(await new Response(tarStream).arrayBuffer());
  return extractTarText(tarBuf, "storyboard.yaml");
}
__name(readBundleStoryboardYaml, "readBundleStoryboardYaml");
async function readBundleScenes(env, bundleKey, defaultSeconds = 4) {
  const yaml = await readBundleStoryboardYaml(env, bundleKey);
  if (!yaml)
    return [];
  return parseStoryboardScenes(yaml, defaultSeconds);
}
__name(readBundleScenes, "readBundleScenes");

// node_modules/@skyphusion-labs/vivijure-core/dist/scatter.js
function splitShots(shotIds, shardCount) {
  const shots = shotIds.filter((s) => typeof s === "string" && s.length > 0);
  if (shots.length === 0)
    return [];
  const n = Math.max(1, Math.min(Math.floor(shardCount) || 1, shots.length));
  const base = Math.floor(shots.length / n);
  const extra = shots.length % n;
  const shards = [];
  let i = 0;
  for (let s = 0; s < n; s++) {
    const size = base + (s < extra ? 1 : 0);
    shards.push(shots.slice(i, i + size));
    i += size;
  }
  return shards;
}
__name(splitShots, "splitShots");
function scopePretrainedToShard(pretrainedLoras, shard, shotSlots) {
  if (!shotSlots)
    return { ...pretrainedLoras };
  const used = /* @__PURE__ */ new Set();
  for (const shotId of shard) {
    for (const slot of shotSlots[shotId] ?? [])
      used.add(slot);
  }
  const scoped = {};
  for (const [slot, key] of Object.entries(pretrainedLoras)) {
    if (used.has(slot))
      scoped[slot] = key;
  }
  return scoped;
}
__name(scopePretrainedToShard, "scopePretrainedToShard");
function scatterShards(args) {
  return splitShots(args.shotIds, args.shardCount).filter((shard) => shard.length > 0).map((shots) => ({
    shots,
    pretrainedLoras: scopePretrainedToShard(args.pretrainedLoras, shots, args.shotSlots)
  }));
}
__name(scatterShards, "scatterShards");
var SHARD_DEAD_STATUSES = /* @__PURE__ */ new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
var SHARD_TERMINAL_STATUSES = /* @__PURE__ */ new Set([...SHARD_DEAD_STATUSES, "COMPLETED"]);
function gatherDecision(present, expected, shards) {
  const expectedShots = expected.filter((s) => typeof s === "string" && s.length > 0);
  if (expectedShots.length === 0) {
    return { kind: "failed", reason: "no expected shots: nothing to gather" };
  }
  const presentSet = new Set(present);
  const missing = expectedShots.filter((id) => !presentSet.has(id));
  if (missing.length === 0)
    return { kind: "finish" };
  const recoverable = /* @__PURE__ */ new Set();
  for (const shard of shards) {
    if (!SHARD_TERMINAL_STATUSES.has(shard.status)) {
      for (const shot of shard.shots)
        recoverable.add(shot);
    }
  }
  const doomed = missing.filter((id) => !recoverable.has(id));
  if (doomed.length > 0) {
    return {
      kind: "failed",
      reason: `${doomed.length} shot(s) can never arrive (owning shard dead, completed-without-it, or unassigned): ${doomed.join(", ")}`
    };
  }
  return { kind: "waiting", remaining: missing.length };
}
__name(gatherDecision, "gatherDecision");
function scatterParentJobId(token) {
  return `scatter-${token}`;
}
__name(scatterParentJobId, "scatterParentJobId");
function isScatterParentJobId(jobId) {
  return typeof jobId === "string" && jobId.startsWith("scatter-");
}
__name(isScatterParentJobId, "isScatterParentJobId");

// node_modules/@skyphusion-labs/vivijure-core/dist/lora-bundle.js
function buildLoraTrainingBundleArgs(cast, bundleSuffix) {
  const safeSlug = cast.slug || `cast-${cast.id}`;
  const projectName = `lora-${safeSlug}-${bundleSuffix}`;
  return {
    storyboard: {
      title: projectName,
      projectName,
      full_prompt: "",
      duration_seconds: void 0,
      clip_seconds: void 0,
      style_prefix: "",
      style_category: "None",
      style_preset: "None",
      use_characters: ["A"],
      cast_rules: "",
      scenes: [
        {
          id: "lora_train_shot",
          prompt: "lora training reference shot (not rendered)",
          character_slots: ["A"],
          target_seconds: 1
        }
      ]
    },
    characterRefs: {
      A: {
        name: cast.name,
        prompt: cast.bible || cast.name,
        trainingImages: cast.ref_keys.map((r) => ({ key: r.key })),
        portrait: cast.portrait_key ? { key: cast.portrait_key } : void 0
      }
    }
  };
}
__name(buildLoraTrainingBundleArgs, "buildLoraTrainingBundleArgs");
function deriveLoraDestKey2(castId, timestamp) {
  return `loras/cast-${castId}/${timestamp}.safetensors`;
}
__name(deriveLoraDestKey2, "deriveLoraDestKey");
function deriveWanLoraDestKeys(castId, timestamp) {
  return {
    high: `loras/cast-${castId}/${timestamp}.high.safetensors`,
    low: `loras/cast-${castId}/${timestamp}.low.safetensors`
  };
}
__name(deriveWanLoraDestKeys, "deriveWanLoraDestKeys");
function extractTrainedWanLoraKeys(output) {
  if (!output || typeof output !== "object")
    return null;
  const lora = output.lora;
  if (!lora || typeof lora !== "object" || Array.isArray(lora))
    return null;
  for (const entry of Object.values(lora)) {
    if (entry && typeof entry === "object") {
      const high = entry.lora_id_high;
      const low = entry.lora_id_low;
      if (typeof high === "string" && high && typeof low === "string" && low) {
        return { high, low };
      }
    }
  }
  return null;
}
__name(extractTrainedWanLoraKeys, "extractTrainedWanLoraKeys");
function extractTrainedLoraKey(output) {
  if (!output || typeof output !== "object")
    return null;
  const o = output;
  if (typeof o.lora_key === "string" && o.lora_key)
    return o.lora_key;
  const lora = o.lora;
  if (lora && typeof lora === "object" && !Array.isArray(lora)) {
    for (const entry of Object.values(lora)) {
      if (entry && typeof entry === "object") {
        const id = entry.lora_id;
        if (typeof id === "string" && id)
          return id;
      }
    }
  }
  return null;
}
__name(extractTrainedLoraKey, "extractTrainedLoraKey");

// node_modules/@skyphusion-labs/vivijure-core/dist/cast-lora-train.js
var MIN_TRAINING_REFS = 4;
async function wanTrainEndpointConfigured(env) {
  const endpointId = await secretValue(env.RUNPOD_WAN_TRAIN_ENDPOINT_ID);
  return Boolean(endpointId.trim());
}
__name(wanTrainEndpointConfigured, "wanTrainEndpointConfigured");
function resolveCastTrainFamily(wanConfigured, explicit) {
  const norm = String(explicit ?? "").trim().toLowerCase();
  if (norm === "sdxl")
    return "sdxl";
  if (norm === "wan")
    return wanConfigured ? "wan" : "sdxl";
  return wanConfigured ? "wan" : "sdxl";
}
__name(resolveCastTrainFamily, "resolveCastTrainFamily");
function parseCastTrainBodyFields(parsed, wanConfigured) {
  let renderOverrides;
  let modelFamily;
  if (parsed?.renderOverrides && typeof parsed.renderOverrides === "object" && !Array.isArray(parsed.renderOverrides)) {
    renderOverrides = parsed.renderOverrides;
    const roFamily = renderOverrides.model_family ?? renderOverrides.modelFamily;
    if (typeof roFamily === "string") {
      modelFamily = resolveCastTrainFamily(wanConfigured, roFamily);
    }
  }
  const topFamily = parsed?.model_family ?? parsed?.modelFamily;
  if (typeof topFamily === "string") {
    modelFamily = resolveCastTrainFamily(wanConfigured, topFamily);
  }
  return { renderOverrides, modelFamily };
}
__name(parseCastTrainBodyFields, "parseCastTrainBodyFields");
async function parseCastTrainRequestBody(request, wanConfigured) {
  try {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const parsed = await request.json();
      return parseCastTrainBodyFields(parsed, wanConfigured);
    }
  } catch {
  }
  return {};
}
__name(parseCastTrainRequestBody, "parseCastTrainRequestBody");
var LORA_TRAIN_404_GRACE_SECONDS = 120;
var LORA_TRAIN_MAX_AGE_SECONDS = 60 * 60;
var LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS = 3 * 60 * 60;
function sqliteUtcToMs(s) {
  if (!s)
    return null;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(t) ? t : t + "Z";
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}
__name(sqliteUtcToMs, "sqliteUtcToMs");
function trainingAgeSeconds(cast, now) {
  const ms = sqliteUtcToMs(cast.updated_at);
  if (ms === null)
    return null;
  return (now - ms) / 1e3;
}
__name(trainingAgeSeconds, "trainingAgeSeconds");
function decideStuckTraining(poll, ageSeconds) {
  if (ageSeconds === null)
    return { reconcile: false };
  const notFound2 = poll.ok === false && poll.status === 404;
  if (notFound2 && ageSeconds >= LORA_TRAIN_404_GRACE_SECONDS) {
    return {
      reconcile: true,
      reason: `backing RunPod job not found (HTTP 404; aged out of retention) after ${Math.round(ageSeconds)}s in training -- it cannot complete; re-fire training`
    };
  }
  const ceiling = poll.ok ? LORA_TRAIN_OBSERVED_MAX_AGE_SECONDS : LORA_TRAIN_MAX_AGE_SECONDS;
  if (ageSeconds >= ceiling) {
    return {
      reconcile: true,
      reason: `training exceeded max age (${Math.round(ageSeconds)}s >= ${ceiling}s); backing job not observed terminal -- re-fire training`
    };
  }
  return { reconcile: false };
}
__name(decideStuckTraining, "decideStuckTraining");
async function harvestCompletedLora(env, cast, output) {
  const wanKeys = extractTrainedWanLoraKeys(output);
  if (wanKeys)
    return await markWanLoraReady(env, cast.id, wanKeys.high, wanKeys.low) || cast;
  const loraKey = extractTrainedLoraKey(output);
  if (loraKey)
    return await markLoraReady(env, cast.id, loraKey) || cast;
  return await markLoraFailed(env, cast.id, "GPU job completed but envelope carried no harvestable LoRA key (neither SDXL nor Wan experts)") || cast;
}
__name(harvestCompletedLora, "harvestCompletedLora");
async function discoverWanLoraKeysInR2(env, cast) {
  const safeSlug = cast.slug || `cast-${cast.id}`;
  const prefix = `loras/lora-${safeSlug}-`;
  const highSuffix = "/A/wan_high_noise.safetensors";
  const lowSuffix = "/A/wan_low_noise.safetensors";
  let cursor;
  let best = null;
  do {
    const page = await env.R2_RENDERS.list({ prefix, cursor, limit: 100 });
    for (const obj of page.objects) {
      if (!obj.key.endsWith(highSuffix))
        continue;
      const base = obj.key.slice(0, -highSuffix.length);
      const lowKey = `${base}${lowSuffix}`;
      const lowListed = page.objects.some((o) => o.key === lowKey);
      if (!lowListed && await env.R2_RENDERS.head(lowKey) === null)
        continue;
      const uploaded = obj.uploaded?.getTime() ?? 0;
      if (!best || uploaded > best.uploaded) {
        best = { high: obj.key, low: lowKey, uploaded };
      }
    }
    cursor = page.truncated ? page.cursor : void 0;
  } while (cursor);
  return best ? { high: best.high, low: best.low } : null;
}
__name(discoverWanLoraKeysInR2, "discoverWanLoraKeysInR2");
async function tryReconcileWanLoraFromR2(env, cast) {
  if (cast.wan_lora_key_high || cast.wan_lora_key_low)
    return null;
  let keys;
  try {
    keys = await discoverWanLoraKeysInR2(env, cast);
  } catch {
    return null;
  }
  if (!keys)
    return null;
  return await markWanLoraReady(env, cast.id, keys.high, keys.low) || cast;
}
__name(tryReconcileWanLoraFromR2, "tryReconcileWanLoraFromR2");
async function refreshTrainingLora(env, cast, now = Date.now()) {
  if (!cast || cast.lora_status !== "training" || !cast.lora_job_id)
    return cast;
  const ageSeconds = trainingAgeSeconds(cast, now);
  let poll;
  try {
    poll = await pollCastLoraJob(env, cast.lora_job_id);
  } catch {
    poll = { ok: false, error: "poll threw" };
  }
  if (poll.ok) {
    const view = poll.view;
    if (view.status === "COMPLETED") {
      return harvestCompletedLora(env, cast, view.output);
    }
    if (view.status === "FAILED" || view.status === "TIMED_OUT" || view.status === "CANCELLED") {
      return await markLoraFailed(env, cast.id, view.error || `training ${view.status.toLowerCase()}`) || cast;
    }
  }
  const decision = decideStuckTraining(poll, ageSeconds);
  if (decision.reconcile) {
    const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
    if (fromR2)
      return fromR2;
    return await markLoraFailed(env, cast.id, decision.reason) || cast;
  }
  if (!poll.ok && poll.status === 404) {
    const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
    if (fromR2)
      return fromR2;
  }
  return cast;
}
__name(refreshTrainingLora, "refreshTrainingLora");
async function handleCastTrainLora(request, env, id) {
  const wanConfigured = await wanTrainEndpointConfigured(env);
  const body = await parseCastTrainRequestBody(request, wanConfigured);
  const family = body.modelFamily ?? resolveCastTrainFamily(wanConfigured);
  return executeCastTrain(env, id, body.renderOverrides, family);
}
__name(handleCastTrainLora, "handleCastTrainLora");
async function handleCastTrainWanLora(request, env, id) {
  const wanConfigured = await wanTrainEndpointConfigured(env);
  const body = await parseCastTrainRequestBody(request, wanConfigured);
  return executeCastTrain(env, id, body.renderOverrides, "wan");
}
__name(handleCastTrainWanLora, "handleCastTrainWanLora");
async function executeCastTrain(env, id, bodyRenderOverrides, family) {
  const cast = await getCastById(env, id);
  if (!cast)
    return json({ error: "cast not found" }, 404);
  if (cast.lora_status === "training") {
    return json({
      error: "a LoRA training job is already in flight for this cast member",
      jobId: cast.lora_job_id
    }, 409);
  }
  if (!cast.portrait_key) {
    return json({ error: "cast member needs a portrait before training (set one via /cast)" }, 400);
  }
  if (cast.ref_keys.length < MIN_TRAINING_REFS) {
    return json({
      error: `cast member has only ${cast.ref_keys.length} training refs; need at least ${MIN_TRAINING_REFS}. Use the training-set generator on /cast.`
    }, 400);
  }
  const timestamp = Math.floor(Date.now() / 1e3);
  const args = buildLoraTrainingBundleArgs(cast, String(timestamp));
  let bundleResult;
  try {
    bundleResult = await assembleBundle(env, args);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `bundle assembly failed: ${m}` }, 500);
  }
  if (!bundleResult.ok) {
    return json({ error: "bundle assembly failed", details: bundleResult.errors }, 500);
  }
  if (family === "wan") {
    if (!await wanTrainEndpointConfigured(env)) {
      return json({ error: "Wan cast LoRA training is not configured on this host (wire RUNPOD_WAN_TRAIN_ENDPOINT_ID)" }, 501);
    }
    const loraDestKeys = deriveWanLoraDestKeys(cast.id, timestamp);
    const submit2 = await submitTrainWanLoraJob(env, {
      project: args.storyboard.projectName,
      bundleKey: bundleResult.bundleKey,
      renderOverrides: bodyRenderOverrides
    });
    if (!submit2.ok) {
      return json({ error: submit2.error }, 502);
    }
    const updated2 = await setLoraJob(env, cast.id, submit2.view.jobId);
    return json({
      ok: true,
      jobId: submit2.view.jobId,
      status: submit2.view.status,
      statusRaw: submit2.view.statusRaw,
      bundleKey: bundleResult.bundleKey,
      loraDestKeys,
      modelFamily: "wan",
      cast: toPublicCast(updated2 || cast)
    });
  }
  const loraDestKey = deriveLoraDestKey2(cast.id, timestamp);
  const submit = await submitTrainLoraJob(env, {
    project: args.storyboard.projectName,
    bundleKey: bundleResult.bundleKey,
    renderOverrides: bodyRenderOverrides
  });
  if (!submit.ok) {
    return json({ error: submit.error }, 502);
  }
  const updated = await setLoraJob(env, cast.id, submit.view.jobId);
  return json({
    ok: true,
    jobId: submit.view.jobId,
    status: submit.view.status,
    statusRaw: submit.view.statusRaw,
    bundleKey: bundleResult.bundleKey,
    loraDestKey,
    modelFamily: "sdxl",
    cast: toPublicCast(updated || cast)
  });
}
__name(executeCastTrain, "executeCastTrain");
async function handleCastLoraStatus(env, id) {
  const cast = await getCastById(env, id);
  if (!cast)
    return json({ error: "cast not found" }, 404);
  if (!cast.lora_job_id) {
    return json({ cast: toPublicCast(cast), view: null });
  }
  const ageSeconds = trainingAgeSeconds(cast, Date.now());
  let poll;
  try {
    poll = await pollCastLoraJob(env, cast.lora_job_id);
  } catch {
    poll = { ok: false, error: "poll threw" };
  }
  if (poll.ok) {
    const view = poll.view;
    if (view.status === "COMPLETED") {
      const updated = await harvestCompletedLora(env, cast, view.output);
      return json({ cast: toPublicCast(updated || cast), view });
    }
    if (view.status === "FAILED" || view.status === "TIMED_OUT" || view.status === "CANCELLED") {
      const msg = view.error || `training ${view.status.toLowerCase()}`;
      const updated = await markLoraFailed(env, cast.id, msg);
      return json({ cast: toPublicCast(updated || cast), view });
    }
    return json({ cast: toPublicCast(cast), view });
  }
  if (cast.lora_status === "training") {
    const decision = decideStuckTraining(poll, ageSeconds);
    if (decision.reconcile) {
      const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
      if (fromR2) {
        return json({ cast: toPublicCast(fromR2), view: null, reconciledFromR2: true });
      }
      const updated = await markLoraFailed(env, cast.id, decision.reason);
      return json({ cast: toPublicCast(updated || cast), view: null, reconciled: true });
    }
    if (!poll.ok && poll.status === 404) {
      const fromR2 = await tryReconcileWanLoraFromR2(env, cast);
      if (fromR2) {
        return json({ cast: toPublicCast(fromR2), view: null, reconciledFromR2: true });
      }
    }
  }
  return json({ error: poll.error, cast: toPublicCast(cast) }, 502);
}
__name(handleCastLoraStatus, "handleCastLoraStatus");
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");

// node_modules/@skyphusion-labs/vivijure-core/dist/cast-loras.js
async function resolveCastLoras(env, castLoras) {
  const pretrained = {};
  const wanPretrained = {};
  const voices = {};
  const castIds = {};
  const skipped = [];
  const skippedDetail = [];
  const skip = /* @__PURE__ */ __name((d) => {
    skipped.push(d.slot);
    skippedDetail.push(d);
  }, "skip");
  if (!castLoras || typeof castLoras !== "object")
    return { pretrained, wanPretrained, voices, castIds, skipped, skippedDetail };
  for (const [slot, raw] of Object.entries(castLoras)) {
    if (typeof slot !== "string" || !slot.trim())
      continue;
    if (!isPublicId(raw)) {
      skip({ slot, reason: "not a valid cast id" });
      continue;
    }
    const id = await getCastIdByPublicId(env, raw);
    if (id === null) {
      skip({ slot, reason: "cast member not found" });
      continue;
    }
    castIds[slot] = id;
    let cast = await getCastById(env, id);
    if (cast?.lora_status === "training") {
      cast = await refreshTrainingLora(env, cast);
    }
    if (cast)
      voices[slot] = coerceVoiceId(cast.voice_id) ?? DEFAULT_VOICE_ID;
    if (!cast) {
      skip({ slot, reason: "cast member not found" });
      continue;
    }
    if (cast.lora_status !== "ready") {
      skip({
        slot,
        name: cast.name,
        reason: cast.lora_status === "training" ? "LoRA still training" : "no trained LoRA"
      });
      continue;
    }
    const sdxlKey = cast.lora_key && cast.lora_key.startsWith("loras/") ? cast.lora_key : null;
    const wanHigh = cast.wan_lora_key_high && cast.wan_lora_key_high.startsWith("loras/") ? cast.wan_lora_key_high : null;
    const wanLow = cast.wan_lora_key_low && cast.wan_lora_key_low.startsWith("loras/") ? cast.wan_lora_key_low : null;
    if (sdxlKey) {
      pretrained[slot] = sdxlKey;
    } else if (wanHigh && wanLow) {
      wanPretrained[slot] = { high: wanHigh, low: wanLow };
    } else {
      skip({ slot, name: cast.name, reason: "no trained LoRA" });
    }
  }
  return { pretrained, wanPretrained, voices, castIds, skipped, skippedDetail };
}
__name(resolveCastLoras, "resolveCastLoras");
function untrainedCastMessage(skippedDetail) {
  const names = skippedDetail.map((d) => {
    const who = d.name ?? `slot ${d.slot}`;
    return d.reason === "LoRA still training" ? `${who} (still training)` : who;
  });
  return `These characters have no trained LoRA -- train them on the Cast page first: ${names.join(", ")}.`;
}
__name(untrainedCastMessage, "untrainedCastMessage");

// node_modules/@skyphusion-labs/vivijure-core/dist/scatter-notify.js
async function fireNotifyForScatter(env, job) {
  if (!job.film_key)
    return;
  try {
    const envRec = env;
    const notifiers = servingForHook(await discoverModules(envRec), "notify");
    if (!notifiers.length)
      return;
    const download_url = await presignR2Get(env, job.film_key, FILM_DOWNLOAD_TTL_SECONDS);
    const input = {
      event: "render.complete",
      film_id: job.scatter_id,
      project: job.project,
      download_url
    };
    const context = { project: job.project, job_id: job.scatter_id };
    for (const m of notifiers) {
      const fetcher = resolveFetcher(envRec, m.binding);
      if (!fetcher)
        continue;
      try {
        const installConfig = await loadInstallConfig(env, m.name, m.config_schema);
        await invokeModule(fetcher, {
          hook: "notify",
          input,
          config: validateConfig(m.config_schema ?? {}, installConfig),
          context
        });
      } catch {
      }
    }
  } catch (e) {
    console.warn(`scatter notify failed for ${job.scatter_id}: ${e.message}`);
  }
}
__name(fireNotifyForScatter, "fireNotifyForScatter");

// node_modules/@skyphusion-labs/vivijure-core/dist/scatter-orchestrator.js
var MAX_ASSEMBLE_ATTEMPTS2 = 6;
var scatterDocKey = /* @__PURE__ */ __name((id) => `renders/${id}/scatter-job.json`, "scatterDocKey");
var scatterOutKey = /* @__PURE__ */ __name((id) => `renders/${id}/film.mp4`, "scatterOutKey");
async function loadScatterJob(env, scatterId) {
  const obj = await env.R2_RENDERS.get(scatterDocKey(scatterId));
  if (!obj)
    return null;
  return JSON.parse(await obj.text());
}
__name(loadScatterJob, "loadScatterJob");
async function saveScatterJob(env, job) {
  await env.R2_RENDERS.put(scatterDocKey(job.scatter_id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" }
  });
}
__name(saveScatterJob, "saveScatterJob");
async function loadFilmJobDoc(env, filmId) {
  const obj = await env.R2_RENDERS.get(filmKey(filmId));
  if (!obj)
    return null;
  return JSON.parse(await obj.text());
}
__name(loadFilmJobDoc, "loadFilmJobDoc");
async function resolveDialogueLines(env, args, voices, shotIds) {
  if (args.project_id == null)
    return [];
  const project = await getProjectById(env, args.project_id);
  if (!project?.last_storyboard)
    return [];
  return buildDialogueLines(project.last_storyboard, voices, shotIds);
}
__name(resolveDialogueLines, "resolveDialogueLines");
async function startScatterRender(env, args) {
  const modules = await discoverModules(env);
  if (servingForHook(modules, "keyframe").length === 0) {
    throw new Error("no keyframe module installed (bind MODULE_KEYFRAME)");
  }
  if (servingForHook(modules, "motion.backend").length === 0) {
    throw new Error("no motion.backend module installed");
  }
  const { pretrained, voices, castIds, skipped, skippedDetail } = await resolveCastLoras(env, args.cast_loras);
  if (skipped.length) {
    throw new Error(untrainedCastMessage(skippedDetail));
  }
  const parsed = await readBundleScenes(env, args.bundle_key);
  const scenes = parsed.map((s) => ({
    shot_id: s.shot_id,
    prompt: s.prompt,
    seconds: s.seconds
  }));
  const expected = args.shot_ids.filter((s) => typeof s === "string" && s.length > 0);
  if (expected.length < 2)
    throw new Error("scatter requires >= 2 shots");
  const dialogueLines = await resolveDialogueLines(env, args, voices, expected);
  const shards = scatterShards({
    shotIds: expected,
    shardCount: args.shard_count,
    pretrainedLoras: pretrained
  });
  if (shards.length < 2)
    throw new Error("scatter requires >= 2 shards");
  const mapped = mapRenderOverridesToModuleConfigs(args.render_overrides, args.quality_tier, modules);
  const motionBackend = args.motion_backend ?? mapped.motion_backend ?? defaultGpuDoorModule(modules)?.name;
  if (!motionBackend)
    throw new Error('no gpu-door motion.backend module (ui.locality "byo"/"local") is installed');
  const scatterId = scatterParentJobId(crypto.randomUUID());
  const stagedAudio = await resolveStagedAudioKey(env, args.audio_key);
  const scatterJob = {
    scatter_id: scatterId,
    project: args.project,
    bundle_key: args.bundle_key,
    quality_tier: args.quality_tier,
    expected_shot_ids: expected,
    shard_film_ids: [],
    shard_shots: shards.map((s) => s.shots),
    motion_backend: motionBackend,
    audio_key: stagedAudio,
    has_dialogue: dialogueLines.length > 0,
    scenes,
    dialogue_lines: dialogueLines,
    film_titles: args.film_titles,
    film_finish_config: mapped.film_finish_config,
    project_id: args.project_id ?? null,
    render_overrides: args.render_overrides,
    phase: "shards",
    created_at: Date.now()
  };
  const shardRows = [];
  for (const shard of shards) {
    const shardScenes = filterScenesByShotIds(scenes, shard.shots);
    const shardShotSet = new Set(shard.shots);
    const shardDialogue = dialogueLines.filter((l) => shardShotSet.has(l.shot_id));
    const film = await startFilmJob(env, {
      project: args.project,
      bundle_key: args.bundle_key,
      scenes: shardScenes,
      motion_backend: motionBackend,
      keyframe_backend: mapped.keyframe_backend,
      keyframe_config: mapped.keyframe_config,
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      speech_config: mapped.speech_config,
      master_config: mapped.master_config,
      clips_only: true,
      pretrained_loras: shard.pretrainedLoras,
      cast_loras: castIds,
      dialogue_lines: shardDialogue
    });
    scatterJob.shard_film_ids.push(film.film_id);
    shardRows.push({ jobId: film.film_id, status: filmJobToPollView(film, null).status });
  }
  await finalizeScatterSubmit(env, scatterJob, shardRows);
  return scatterJob;
}
__name(startScatterRender, "startScatterRender");
async function finalizeScatterSubmit(env, scatterJob, shardRows) {
  await saveScatterJob(env, scatterJob);
  try {
    await withD1Retry(() => insertRender(env, {
      jobId: scatterJob.scatter_id,
      project: scatterJob.project,
      bundleKey: scatterJob.bundle_key,
      qualityTier: scatterJob.quality_tier,
      renderOverrides: scatterJob.render_overrides,
      status: "IN_QUEUE",
      mode: "full",
      projectId: scatterJob.project_id ?? null
    }), { label: "scatter.submit.parent" });
    const parentId = await getRenderIdByJobId(env, scatterJob.scatter_id);
    if (shardRows.length) {
      const stmts = shardRows.map((r) => buildInsertRenderStmt(env, {
        jobId: r.jobId,
        project: scatterJob.project,
        bundleKey: scatterJob.bundle_key,
        qualityTier: scatterJob.quality_tier,
        renderOverrides: scatterJob.render_overrides,
        status: r.status,
        mode: "full",
        projectId: scatterJob.project_id ?? null,
        parentId: parentId ?? void 0
      }));
      await withD1Retry(() => env.DB.batch(stmts), { label: "scatter.submit.shards" });
    }
  } catch (e) {
    console.log(JSON.stringify({
      ev: "d1.error",
      op: "scatter.submit.rows",
      scatter_id: scatterJob.scatter_id,
      code: d1ErrorCode(e)
    }));
  }
}
__name(finalizeScatterSubmit, "finalizeScatterSubmit");
async function muxScatterAudio(env, job) {
  const silentKey = job.silent_film_key;
  const audioKey = job.audio_key;
  if (!silentKey || !audioKey) {
    job.film_key = silentKey;
    job.phase = "done";
    return;
  }
  if (!env.VIDEO_FINISH_VPC) {
    job.phase = "failed";
    job.error = "video-finish VPC binding not configured";
    return;
  }
  const outKey = job.mux_output_key ?? scatterOutKey(job.scatter_id);
  job.mux_output_key = outKey;
  const resp = await callVideoFinish(env, {
    clips: [{ url: await presignR2Get(env, silentKey, 1800) }],
    outputUrl: await presignR2Put(env, outKey, 1800),
    outputKey: outKey,
    audioUrl: await presignR2Get(env, audioKey, 1800),
    remuxAudioOnly: true
  });
  if (!resp || !resp.ok) {
    job.phase = "failed";
    job.error = `scatter audio mux failed: HTTP ${resp?.status ?? "?"}`;
    return;
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    job.phase = "failed";
    job.error = "scatter mux returned non-JSON";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `scatter mux failed: ${body.error || "unknown"}`;
    return;
  }
  job.film_key = outKey;
  job.phase = "done";
}
__name(muxScatterAudio, "muxScatterAudio");
async function maybeFinalizeScatter(env, job) {
  if (job.phase !== "done" && job.phase !== "finishing" || !job.film_key)
    return;
  const st = await getFinishState(env, job.scatter_id);
  if (st?.finish_state === "done")
    return;
  const complete = await runScatterFilmFinish(env, job);
  if (!complete) {
    job.phase = "finishing";
    await saveScatterJob(env, job);
    return;
  }
  job.phase = "done";
  await finalizeScatterDone(env, job);
}
__name(maybeFinalizeScatter, "maybeFinalizeScatter");
async function runScatterFilmFinish(env, job) {
  if (job.film_finish || !job.film_key)
    return true;
  job.film_finish_dispatched ??= {};
  job.film_finish_polls ??= {};
  job.film_finish_attempts ??= {};
  job.film_finish_prepend ??= {};
  const r = await runFilmFinish(env, {
    film_key: job.film_key,
    // Caption scenes in the SAME order the gather assembles the clips (expected_shot_ids), NOT bundle
    // order, so buildCaptionCues' cumulative timeline matches the cut (the crux, #284/#285).
    scenes: orderScenesByShotIds(job.scenes ?? [], job.expected_shot_ids),
    dialogue_lines: job.dialogue_lines,
    film_titles: job.film_titles,
    film_finish_config: job.film_finish_config,
    bundle_key: job.bundle_key,
    project: job.project,
    job_id: job.scatter_id,
    actual_durations: job.actual_clip_durations
  }, void 0, {
    // #600 in-flight guard: persist a dispatch BEFORE it fires so a killed tick cannot re-dispatch a
    // duplicate encode of the same step.
    dispatched: job.film_finish_dispatched,
    persistDispatch: /* @__PURE__ */ __name(async (key, ts) => {
      job.film_finish_dispatched[key] = ts;
      await saveScatterJob(env, job);
    }, "persistDispatch"),
    // #602 async job+poll: persist the per-step module poll token + terminal-failure count so a long
    // single film.finish step survives across gather ticks instead of re-burning each tick.
    polls: job.film_finish_polls,
    attempts: job.film_finish_attempts,
    persistPoll: /* @__PURE__ */ __name(async (key, token) => {
      if (token === null)
        delete job.film_finish_polls[key];
      else
        job.film_finish_polls[key] = token;
      await saveScatterJob(env, job);
    }, "persistPoll"),
    // #663: persist title-card prepend offsets across gather ticks so the post-chain .srt re-time recovers
    // them even when the prepending step is adopted (not re-folded) on a later tick.
    prepends: job.film_finish_prepend,
    persistPrepend: /* @__PURE__ */ __name(async (key, seconds) => {
      job.film_finish_prepend[key] = seconds;
      await saveScatterJob(env, job);
    }, "persistPrepend")
  });
  if (!r.ran) {
    job.film_finish = { applied: [], errors: [] };
    return true;
  }
  if (r.errors.length > 0)
    console.warn(`scatter film.finish errors for ${job.scatter_id}: ${r.errors.join("; ")}`);
  if (r.degraded)
    console.warn(`scatter film.finish degraded for ${job.scatter_id}: ${r.degraded} -- film shipped WITHOUT cards`);
  if (!r.complete) {
    await saveScatterJob(env, job);
    return false;
  }
  job.film_finish = { applied: r.applied, adopted: r.adopted, errors: r.errors, steps: r.steps, degraded: r.degraded, sidecar_key: r.sidecar_key };
  job.film_key = r.film_key;
  await saveScatterJob(env, job);
  return true;
}
__name(runScatterFilmFinish, "runScatterFilmFinish");
async function assembleScatterClips(env, job, clips) {
  if (!env.VIDEO_FINISH_VPC) {
    job.phase = "failed";
    job.error = "video-finish VPC binding not configured";
    return;
  }
  const presigned = [];
  for (const c of clips) {
    presigned.push({ url: await presignR2Get(env, c.clip_key, 1800) });
  }
  const outputKey = scatterOutKey(job.scatter_id);
  const resp = await callVideoFinish(env, {
    clips: presigned,
    outputUrl: await presignR2Put(env, outputKey, 1800),
    outputKey,
    keepClipAudio: !!job.has_dialogue
  });
  const transport = classifyAssembleTransport(resp ? resp.status : null, job.assemble_attempts ?? 0, MAX_ASSEMBLE_ATTEMPTS2);
  job.assemble_attempts = transport.attempts;
  if (transport.state === "retry") {
    job.phase = "gather";
    job.error = transport.error;
    return;
  }
  if (transport.state === "exhausted") {
    job.phase = "failed";
    job.error = transport.error;
    return;
  }
  if (!resp || !resp.ok) {
    job.phase = "failed";
    job.error = `video-finish gather returned ${resp?.status ?? "?"}`;
    return;
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    job.phase = "failed";
    job.error = "video-finish gather returned non-JSON";
    return;
  }
  if (!body.ok) {
    job.phase = "failed";
    job.error = `video-finish gather failed: ${body.error || "unknown"}`;
    return;
  }
  const actual = mapClipDurationsToShots(clips, body.clipDurations);
  job.actual_clip_durations = Object.keys(actual).length > 0 ? actual : void 0;
  if (Object.keys(actual).length > 0) {
    const bundleDurations = await readShotDurationsFromBundle(env, job.bundle_key);
    const planned = resolvePlannedSeconds(job.scenes ?? [], bundleDurations);
    const fraction = resolveClipDurationFloor(typeof env.FILM_CLIP_DURATION_FLOOR === "string" ? env.FILM_CLIP_DURATION_FLOOR : void 0);
    const shortfalls = findClipDurationShortfalls(clips, actual, planned, fraction);
    if (shortfalls.length > 0) {
      job.phase = "failed";
      job.error = `duration gate: ${shortfalls.length} shot(s) delivered below ${Math.round(fraction * 100)}% of plan: ` + shortfalls.map((sf) => `${sf.shot_id} ${sf.actual.toFixed(2)}s vs planned ${sf.planned.toFixed(2)}s (floor ${sf.floor.toFixed(2)}s)`).join("; ");
      console.warn(`scatter ${job.scatter_id}: ${job.error}`);
      return;
    }
  }
  const expectedSeconds = (job.scenes ?? []).filter((s) => job.expected_shot_ids.includes(s.shot_id)).reduce((sum, s) => sum + (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : 0), 0);
  const assembledSeconds = typeof body.durationSeconds === "number" ? body.durationSeconds : 0;
  console.log(JSON.stringify({
    ev: "scatter.assemble.result",
    scatter_id: job.scatter_id,
    sent: clips.length,
    clipsReceived: body.clipsReceived,
    shots: body.shots,
    durationSeconds: body.durationSeconds,
    expectedSeconds
  }));
  if (expectedSeconds > 0 && assembledSeconds > 0 && assembledSeconds < expectedSeconds * 0.5) {
    job.phase = "failed";
    job.error = `assemble dropped clips: ${assembledSeconds.toFixed(1)}s assembled vs ~${expectedSeconds.toFixed(1)}s expected across ${job.expected_shot_ids.length} shots`;
    return;
  }
  job.silent_film_key = outputKey;
  if (job.audio_key) {
    job.phase = "mux";
    await muxScatterAudio(env, job);
  } else {
    job.film_key = outputKey;
    job.phase = "done";
  }
}
__name(assembleScatterClips, "assembleScatterClips");
async function finalizeScatterDone(env, job) {
  if (!job.film_key)
    return;
  await markFinishDone(env, job.scatter_id, job.film_key, JSON.stringify({
    output_key: job.film_key,
    project: job.project,
    mode: "full"
  }));
  await fireNotifyForScatter(env, job);
}
__name(finalizeScatterDone, "finalizeScatterDone");
async function advanceScatterGather(env, job) {
  const st = await getFinishState(env, job.scatter_id);
  const claimed = await claimFinish(env, job.scatter_id);
  if (!claimed && st?.finish_state !== "finishing")
    return;
  const clipMap = /* @__PURE__ */ new Map();
  for (const filmId of job.shard_film_ids) {
    const fj = await loadFilmJobDoc(env, filmId);
    if (!fj || fj.phase !== "done")
      continue;
    for (const [shotId, key] of (await clipKeysFromFilmJob(env, fj)).entries()) {
      clipMap.set(shotId, key);
    }
  }
  const clips = orderFinalClips(job.expected_shot_ids.map((shot_id) => ({ shot_id, prompt: "", seconds: 4 })), [...clipMap.entries()].map(([shot_id, clip_key]) => ({ shot_id, clip_key })));
  console.log(JSON.stringify({
    ev: "scatter.gather.assemble",
    scatter_id: job.scatter_id,
    shots_expected: job.expected_shot_ids.length,
    clips_gathered: clips.length,
    shot_ids: clips.map((c) => c.shot_id)
  }));
  if (clips.length !== job.expected_shot_ids.length) {
    const err = "gather: missing clips after finish decision";
    await markFinishFailed(env, job.scatter_id, err);
    job.phase = "failed";
    job.error = err;
    return;
  }
  await assembleScatterClips(env, job, clips);
  if (job.phase === "failed") {
    await markFinishFailed(env, job.scatter_id, job.error || "scatter gather failed");
  } else {
    await maybeFinalizeScatter(env, job);
  }
}
__name(advanceScatterGather, "advanceScatterGather");
function shardStatusForOutcome(outcome) {
  if (outcome.ok)
    return filmPhaseToShardStatus(outcome.job);
  return outcome.reason === "doc_missing" ? "FAILED" : "IN_PROGRESS";
}
__name(shardStatusForOutcome, "shardStatusForOutcome");
async function ensureScatterRenderRow(env, job, ctx) {
  try {
    const view = scatterJobToPollView(job);
    let parentId = await getRenderIdByJobId(env, job.scatter_id);
    if (parentId == null) {
      await insertRender(env, {
        jobId: job.scatter_id,
        project: job.project,
        bundleKey: job.bundle_key,
        qualityTier: job.quality_tier,
        renderOverrides: job.render_overrides,
        status: view.status,
        mode: "full",
        projectId: job.project_id ?? null
      });
      if (view.status !== "IN_PROGRESS")
        await updateRenderFromView(env, view, ctx);
      console.log(JSON.stringify({ ev: "scatter.selfheal.row", scatter_id: job.scatter_id, status: view.status }));
      parentId = await getRenderIdByJobId(env, job.scatter_id);
    }
    if (parentId != null && job.shard_film_ids.length) {
      const existing = new Set((await getScatterChildren(env, parentId)).map((c) => c.job_id));
      for (const shardFilmId of job.shard_film_ids) {
        if (existing.has(shardFilmId))
          continue;
        await insertRender(env, {
          jobId: shardFilmId,
          project: job.project,
          bundleKey: job.bundle_key,
          qualityTier: job.quality_tier,
          renderOverrides: job.render_overrides,
          status: "IN_PROGRESS",
          mode: "full",
          projectId: job.project_id ?? null,
          parentId
        });
        console.log(JSON.stringify({ ev: "scatter.selfheal.shard", scatter_id: job.scatter_id, shard: shardFilmId }));
      }
    }
  } catch (e) {
    if (!isTransientD1Error(e)) {
      console.log(JSON.stringify({ ev: "d1.error", op: "scatter.selfheal.row", scatter_id: job.scatter_id, code: d1ErrorCode(e) }));
    }
  }
}
__name(ensureScatterRenderRow, "ensureScatterRenderRow");
async function advanceScatterJob(env, scatterId, ctx) {
  const job = await loadScatterJob(env, scatterId);
  if (!job)
    return null;
  await ensureScatterRenderRow(env, job, ctx);
  if (job.cancelled)
    return scatterJobToPollView(job);
  if (job.phase === "done" || job.phase === "failed")
    return scatterJobToPollView(job);
  if (job.phase === "finishing") {
    await maybeFinalizeScatter(env, job);
    await saveScatterJob(env, job);
    const fview = scatterJobToPollView(job);
    if (fview.status !== "IN_PROGRESS")
      await updateRenderFromView(env, fview, ctx);
    return fview;
  }
  const shardStatuses = [];
  const present = /* @__PURE__ */ new Set();
  for (let i = 0; i < job.shard_film_ids.length; i++) {
    const filmId = job.shard_film_ids[i];
    const shots = job.shard_shots[i] ?? [];
    let status;
    try {
      const r = await advanceFilmJob(env, filmId);
      if (r) {
        await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob), ctx);
        status = shardStatusForOutcome({ ok: true, job: r.job });
        if (r.job.phase === "done") {
          for (const [shotId] of (await clipKeysFromFilmJob(env, r.job)).entries()) {
            present.add(shotId);
          }
        }
      } else {
        status = shardStatusForOutcome({ ok: false, reason: "doc_missing" });
      }
    } catch (e) {
      const kind = isTransientD1Error(e) ? "transient D1" : "advance error";
      console.warn(`scatter ${scatterId} shard ${filmId} undetermined (${kind}); treating as in-progress, will retry: ${e.message}`);
      status = shardStatusForOutcome({ ok: false, reason: "errored" });
    }
    shardStatuses.push({ status, shots });
  }
  if (job.phase === "shards") {
    const decision = gatherDecision([...present], job.expected_shot_ids, shardStatuses);
    if (decision.kind === "failed") {
      job.phase = "failed";
      job.error = decision.reason;
      await markRenderFailedByJobId(env, scatterId, decision.reason);
    } else if (decision.kind === "finish") {
      job.phase = "gather";
      await advanceScatterGather(env, job);
    }
  } else if (job.phase === "gather") {
    await advanceScatterGather(env, job);
  } else if (job.phase === "mux") {
    await muxScatterAudio(env, job);
    await maybeFinalizeScatter(env, job);
  }
  await saveScatterJob(env, job);
  const view = scatterJobToPollView(job);
  if (view.status !== "IN_PROGRESS")
    await updateRenderFromView(env, view, ctx);
  return view;
}
__name(advanceScatterJob, "advanceScatterJob");
function scatterJobToPollView(job) {
  let status;
  let output;
  if (job.cancelled) {
    status = "CANCELLED";
  } else if (job.phase === "done") {
    status = "COMPLETED";
    output = { output_key: job.film_key, project: job.project, mode: "full" };
  } else if (job.phase === "failed") {
    status = "FAILED";
  } else {
    status = "IN_PROGRESS";
    output = {
      phase: job.phase,
      project: job.project,
      shards: job.shard_film_ids.length,
      scene_total: job.expected_shot_ids.length
    };
  }
  return {
    jobId: job.scatter_id,
    status,
    statusRaw: job.phase,
    output,
    error: job.error,
    executionTimeMs: Math.max(0, Date.now() - job.created_at)
  };
}
__name(scatterJobToPollView, "scatterJobToPollView");
async function cancelScatterJob(env, scatterId) {
  const job = await loadScatterJob(env, scatterId);
  if (!job)
    return null;
  if (job.phase === "done" || job.phase === "failed")
    return scatterJobToPollView(job);
  job.cancelled = true;
  job.phase = "failed";
  job.error = "cancelled";
  for (const filmId of job.shard_film_ids) {
    await cancelFilmJob(env, filmId);
  }
  await saveScatterJob(env, job);
  return scatterJobToPollView(job);
}
__name(cancelScatterJob, "cancelScatterJob");

// node_modules/@skyphusion-labs/vivijure-core/dist/beat-analyze.js
function beatSyncScoreModules(modules) {
  return servingForHook(modules, "score").filter((m) => m.config_schema != null && m.config_schema.clip_seconds != null);
}
__name(beatSyncScoreModules, "beatSyncScoreModules");
function fetcherForModule(env, mod) {
  return resolveFetcher(env, mod.binding);
}
__name(fetcherForModule, "fetcherForModule");
function resolveBeatSyncModule(modules, moduleName) {
  const candidates = beatSyncScoreModules(modules);
  if (candidates.length === 0)
    return null;
  if (moduleName)
    return candidates.find((m) => m.name === moduleName) ?? null;
  return candidates[0];
}
__name(resolveBeatSyncModule, "resolveBeatSyncModule");
function beatPlanFromModuleOutput(output) {
  const plan = output?.beat_plan;
  if (!plan || plan.mode !== "beat" && plan.mode !== "duration")
    return null;
  return plan;
}
__name(beatPlanFromModuleOutput, "beatPlanFromModuleOutput");
function userConfigFromRequest(req) {
  const out = {};
  if (typeof req.clipSeconds === "number")
    out.clip_seconds = req.clipSeconds;
  if (req.mode === "beat" || req.mode === "duration")
    out.mode = req.mode;
  if (typeof req.minSceneS === "number")
    out.min_scene_s = req.minSceneS;
  if (typeof req.maxSceneS === "number")
    out.max_scene_s = req.maxSceneS;
  if (typeof req.forceShots === "number")
    out.force_shots = req.forceShots;
  return out;
}
__name(userConfigFromRequest, "userConfigFromRequest");
async function analyzeViaVpc(env, audioUrl, req) {
  const vpc = env.AUDIO_BEAT_SYNC_VPC;
  if (!vpc)
    return { ok: false, error: "AUDIO_BEAT_SYNC_VPC not configured" };
  const resp = await vpc.fetch("http://audio-beat-sync/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      audioUrl,
      audioKey: req.audioKey,
      clipSeconds: req.clipSeconds ?? 8,
      mode: req.mode ?? "beat",
      minSceneS: req.minSceneS ?? 2.5,
      maxSceneS: req.maxSceneS ?? 12,
      forceShots: req.forceShots
    })
  });
  const plan = parseAudioBeatPlan(await resp.json());
  if (!plan)
    return { ok: false, error: "beat-sync container returned an unrecognized plan" };
  return { ok: true, plan };
}
__name(analyzeViaVpc, "analyzeViaVpc");
async function analyzeAudioBeats(env, req, moduleName) {
  const audioKey = req.audioKey?.trim();
  if (!audioKey)
    return { ok: false, error: "audioKey required" };
  let audioUrl;
  try {
    audioUrl = await presignR2Get(env, audioKey, 300);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "could not presign audio: " + msg.slice(0, 200) };
  }
  const modules = await discoverModules(env);
  const mod = resolveBeatSyncModule(modules, moduleName?.trim() || void 0);
  if (mod) {
    const fetcher = fetcherForModule(env, mod);
    if (!fetcher) {
      return { ok: false, error: `beat-sync module "${mod.name}" binding ${mod.binding} is not reachable` };
    }
    const config = {
      ...validateConfig(mod.config_schema, userConfigFromRequest(req)),
      audio_url: audioUrl,
      audio_key: audioKey
    };
    const r = await invokeModule(fetcher, {
      hook: "score",
      input: { film_key: "beat-analyze/planner", seconds: 0 },
      config,
      context: { job_id: crypto.randomUUID(), project: "planner" }
    });
    if (!r.ok)
      return { ok: false, error: r.error || `${mod.name} invoke failed` };
    if (!("output" in r)) {
      return { ok: false, error: `${mod.name} returned async poll (beat analysis is synchronous)` };
    }
    const plan = beatPlanFromModuleOutput(r.output);
    if (!plan)
      return { ok: false, error: `${mod.name} finished but returned no beat plan` };
    return { ok: true, plan, module: mod.name };
  }
  const direct = await analyzeViaVpc(env, audioUrl, req);
  if (!direct.ok)
    return direct;
  return { ok: true, plan: direct.plan, module: "core-vpc" };
}
__name(analyzeAudioBeats, "analyzeAudioBeats");

// node_modules/@skyphusion-labs/vivijure-core/dist/render-sweep.js
var SWEEP_MAX_AGE_SECONDS = 24 * 3600;
async function sweepUnresolvedJobs(env, ctx) {
  const jobIds = await listUnresolvedNotifiableJobs(env, SWEEP_MAX_AGE_SECONDS);
  const seen = new Set(jobIds);
  const stranded = [];
  for (const id of await listStrandedPostClipsFilmJobs(env, SWEEP_MAX_AGE_SECONDS)) {
    if (!seen.has(id) && isFilmJobId(id) && await filmJobDocExists(env, id)) {
      seen.add(id);
      stranded.push(id);
    }
  }
  let n = 0;
  for (const jobId of [...jobIds, ...stranded]) {
    try {
      const handled = await resolveOneJob(env, jobId, ctx);
      if (handled)
        n += 1;
    } catch (e) {
      console.warn(`render sweep failed for ${jobId}: ${e.message}`);
    }
  }
  return n;
}
__name(sweepUnresolvedJobs, "sweepUnresolvedJobs");
async function filmJobDocExists(env, jobId) {
  try {
    return await env.R2_RENDERS.head(filmKey(jobId)) !== null;
  } catch {
    return false;
  }
}
__name(filmJobDocExists, "filmJobDocExists");
async function resolveOneJob(env, jobId, ctx) {
  if (isScatterParentJobId(jobId)) {
    const view = await advanceScatterJob(env, jobId, ctx);
    return view !== null;
  }
  if (isFilmJobId(jobId)) {
    const r = await advanceFilmJob(env, jobId);
    if (!r)
      return false;
    await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob), ctx);
    return true;
  }
  return false;
}
__name(resolveOneJob, "resolveOneJob");

// node_modules/@skyphusion-labs/vivijure-core/dist/render-adopt.js
function isSafeAdoptJobId(jobId) {
  return jobId.length > 0 && jobId.length <= 256 && !jobId.includes("/") && isSafeRelKey(jobId);
}
__name(isSafeAdoptJobId, "isSafeAdoptJobId");
function isSafeAdoptOutputKey(jobId, outputKey) {
  const prefix = `renders/${jobId}/`;
  return isSafeRelKey(outputKey) && outputKey.startsWith(prefix) && outputKey.length > prefix.length;
}
__name(isSafeAdoptOutputKey, "isSafeAdoptOutputKey");
function adoptConflictResponse() {
  return json2({ error: "adopt conflict" }, 409);
}
__name(adoptConflictResponse, "adoptConflictResponse");
function existingAdoptResponse(jobId, project, existing, outputKey) {
  if (outputKey && (existing.output_key !== outputKey || existing.status !== "COMPLETED")) {
    return adoptConflictResponse();
  }
  return json2({
    ok: true,
    jobId,
    project,
    adopted: true,
    completed: existing.status === "COMPLETED",
    deduped: true
  });
}
__name(existingAdoptResponse, "existingAdoptResponse");
async function selectExistingRender(env, jobId) {
  return env.DB.prepare("SELECT id, status, output_key FROM renders WHERE job_id = ? LIMIT 1").bind(jobId).first();
}
__name(selectExistingRender, "selectExistingRender");
async function handleAdoptRender(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json2({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.jobId !== "string" || body.jobId.trim().length === 0) {
    return json2({ error: "jobId is required (non-empty string)" }, 400);
  }
  const jobId = body.jobId.trim();
  if (!isSafeAdoptJobId(jobId)) {
    return json2({ error: "jobId must be a safe single path segment" }, 400);
  }
  const outputKey = typeof body.outputKey === "string" && body.outputKey.trim().length > 0 ? body.outputKey.trim() : null;
  if (outputKey && !isSafeAdoptOutputKey(jobId, outputKey)) {
    return json2({ error: "outputKey must be a safe relative key under renders/<jobId>/" }, 400);
  }
  if (body.seconds !== void 0 && (typeof body.seconds !== "number" || !Number.isFinite(body.seconds))) {
    return json2({ error: "seconds must be a finite number if provided" }, 400);
  }
  if (body.hasAudio !== void 0 && typeof body.hasAudio !== "boolean") {
    return json2({ error: "hasAudio must be a boolean if provided" }, 400);
  }
  if (body.qualityTier !== void 0 && coerceQualityTier(body.qualityTier) === void 0) {
    return json2({ error: "qualityTier must be 'draft' | 'standard' | 'final' if provided" }, 400);
  }
  if (body.mode !== void 0 && body.mode !== "full" && body.mode !== "keyframes-only") {
    return json2({ error: "mode must be 'full' | 'keyframes-only' if provided" }, 400);
  }
  const bundleKey = typeof body.bundleKey === "string" ? body.bundleKey : "";
  if (bundleKey && !isSafeBundleKey(bundleKey)) {
    return json2({ error: "bundleKey must be a plain relative key under bundles/" }, 400);
  }
  const project = typeof body.project === "string" && body.project.trim().length > 0 ? body.project.trim() : bundleKey ? deriveProjectFromBundleKey(bundleKey) : jobId;
  const outJson = /* @__PURE__ */ __name(() => {
    const out = { output_key: outputKey };
    if (typeof body.seconds === "number")
      out.seconds = body.seconds;
    if (typeof body.hasAudio === "boolean")
      out.has_audio = body.hasAudio;
    return JSON.stringify(out);
  }, "outJson");
  try {
    const existing = await selectExistingRender(env, jobId);
    if (existing) {
      return existingAdoptResponse(jobId, project, existing, outputKey);
    }
    const inserted = await insertRender(env, {
      jobId,
      project,
      bundleKey,
      qualityTier: coerceQualityTier(body.qualityTier) ?? "final",
      status: outputKey ? "COMPLETED" : "SUBMITTED",
      mode: body.mode ?? "full",
      projectId: null
    });
    if (!inserted) {
      const raced = await selectExistingRender(env, jobId);
      if (!raced) {
        return json2({ error: "could not adopt render" }, 500);
      }
      return existingAdoptResponse(jobId, project, raced, outputKey);
    }
    if (outputKey) {
      await markFinishDone(env, jobId, outputKey, outJson());
    }
  } catch (err) {
    console.error("adopt render insert failed:", err);
    return json2({ error: "could not adopt render" }, 500);
  }
  return json2({ ok: true, jobId, project, adopted: true, completed: !!outputKey });
}
__name(handleAdoptRender, "handleAdoptRender");
function json2(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json2, "json");

// node_modules/@skyphusion-labs/vivijure-core/dist/render-mux.js
var TERMINAL_OK = /* @__PURE__ */ new Set(["COMPLETED"]);
async function muxAudioOntoVideoKey(env, videoKey, audioKey) {
  if (!env.VIDEO_FINISH_VPC)
    return { ok: false, error: "video-finish VPC binding not configured" };
  let stagedKey;
  try {
    stagedKey = await stageAudioKeyForRenders(env, audioKey);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const outKey = videoKey.replace(/\.mp4$/i, "") + "-audio-" + crypto.randomUUID().slice(0, 8) + ".mp4";
  const [videoUrl, audioUrl, outputUrl] = await Promise.all([
    presignR2Get(env, videoKey, 1800),
    presignR2Get(env, stagedKey, 1800),
    presignR2Put(env, outKey, 1800)
  ]);
  const resp = await callVideoFinish(env, {
    clips: [{ url: videoUrl }],
    outputUrl,
    outputKey: outKey,
    audioUrl,
    remuxAudioOnly: true
  });
  if (!resp || !resp.ok) {
    const errBody = resp ? await resp.text().catch(() => "") : "video-finish unreachable";
    return {
      ok: false,
      error: "video-finish mux failed: " + (errBody.slice(0, 200) || String(resp?.status ?? "network"))
    };
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, error: "video-finish returned invalid JSON" };
  }
  if (!body.ok)
    return { ok: false, error: body.error || "video-finish mux failed" };
  if (body.hasAudio === false) {
    return {
      ok: false,
      error: "video-finish could not attach the audio bed (the bed exceeded the container audio cap or was undecodable); no audio track written"
    };
  }
  return { ok: true, output_key: outKey };
}
__name(muxAudioOntoVideoKey, "muxAudioOntoVideoKey");
async function muxAudioOntoRender(env, renderId, audioKey) {
  const row = await getRenderByIdForUser(env, renderId);
  if (!row)
    return { ok: false, error: "render not found" };
  if (!TERMINAL_OK.has(row.status))
    return { ok: false, error: "render is not completed" };
  if (!row.output_key)
    return { ok: false, error: "render has no output video" };
  const muxed = await muxAudioOntoVideoKey(env, row.output_key, audioKey);
  if (!muxed.ok)
    return muxed;
  const updated = await setRenderAudioOutput(env, renderId, muxed.output_key, null);
  if (!updated)
    return { ok: false, error: "could not update render row" };
  return { ok: true, output_key: muxed.output_key };
}
__name(muxAudioOntoRender, "muxAudioOntoRender");

// src/finalize-from-keyframes.ts
function resolveCloudModel(requested, allowed) {
  if (requested && allowed.includes(requested)) return requested;
  return allowed[0];
}
__name(resolveCloudModel, "resolveCloudModel");
async function resolvePreviewScenes(env, parent) {
  const fromOutput = normalizeFilmScenesFromOutput(parent.output);
  if (fromOutput.length) return fromOutput;
  const parsed = await readBundleScenes(env, parent.bundle_key);
  return parsed.map((s) => ({ shot_id: s.shot_id, prompt: s.prompt, seconds: s.seconds }));
}
__name(resolvePreviewScenes, "resolvePreviewScenes");
function normalizeFilmScenesFromOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const scenes = output.scenes;
  if (!Array.isArray(scenes)) return [];
  const out = [];
  for (const e of scenes) {
    if (!e || typeof e !== "object") continue;
    const o = e;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id.trim() : "";
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
    const seconds = typeof o.seconds === "number" && o.seconds > 0 ? o.seconds : 4;
    if (shot_id && prompt) out.push({ shot_id, prompt, seconds });
  }
  return out;
}
__name(normalizeFilmScenesFromOutput, "normalizeFilmScenesFromOutput");
function selectPreviewKeyframes(parent) {
  const kfs = parent.keyframes ?? [];
  const locked = parent.locked_shots;
  if (Array.isArray(locked) && locked.length > 0) {
    const allow = new Set(locked);
    return kfs.filter((k) => allow.has(k.shot_id)).map((k) => ({ shot_id: k.shot_id, keyframe_key: k.key }));
  }
  return kfs.map((k) => ({ shot_id: k.shot_id, keyframe_key: k.key }));
}
__name(selectPreviewKeyframes, "selectPreviewKeyframes");
function scenesForKeyframes(allScenes, keyframes) {
  const allow = new Set(keyframes.map((k) => k.shot_id));
  return allScenes.filter((s) => allow.has(s.shot_id));
}
__name(scenesForKeyframes, "scenesForKeyframes");
function perShotMotionFromHybrid(scenes, backends, defaultBackend, defaultCloud, gpuDoor) {
  const out = {};
  for (const sc of scenes) {
    const entry = backends[sc.shot_id];
    const wantsCloud = entry?.backend === "cloud" || entry?.backend !== "gpu" && defaultBackend === "cloud";
    if (wantsCloud) {
      const model = entry?.backend === "cloud" ? entry.model ?? defaultCloud : defaultCloud;
      if (!model) return { error: `shot "${sc.shot_id}": no cloud motion.backend module is installed` };
      out[sc.shot_id] = model;
    } else {
      if (!gpuDoor) {
        return { error: `shot "${sc.shot_id}": no gpu-door motion.backend module (ui.locality "byo"/"local") is installed` };
      }
      out[sc.shot_id] = gpuDoor;
    }
  }
  return { perShot: out };
}
__name(perShotMotionFromHybrid, "perShotMotionFromHybrid");
function perShotMotionFromCloud(scenes, defaultModel, perShot) {
  const out = {};
  for (const sc of scenes) {
    out[sc.shot_id] = perShot?.[sc.shot_id] ?? defaultModel;
  }
  return out;
}
__name(perShotMotionFromCloud, "perShotMotionFromCloud");
function validatePreviewParent(parent) {
  if (parent.mode !== "keyframes-only") return "parent render is not a keyframes-only preview";
  if (parent.status !== "COMPLETED") return "parent preview is not completed";
  if (!parent.bundle_key) return "parent render has no bundle_key";
  if (!parent.keyframes?.length) return "parent preview has no keyframes";
  return null;
}
__name(validatePreviewParent, "validatePreviewParent");
async function animateFromPreview(env, args) {
  const err = validatePreviewParent(args.parent);
  if (err) return { ok: false, error: err, status: 400 };
  const keyframes = selectPreviewKeyframes(args.parent);
  if (!keyframes.length) return { ok: false, error: "no keyframes selected (check locked shots)", status: 400 };
  const allScenes = await resolvePreviewScenes(env, args.parent);
  if (!allScenes.length) {
    return { ok: false, error: "could not resolve scene prompts from preview output or bundle", status: 400 };
  }
  const scenes = scenesForKeyframes(allScenes, keyframes);
  if (!scenes.length) return { ok: false, error: "no scenes match the selected keyframes", status: 400 };
  const tier = coerceQualityTier(args.parent.quality_tier) ?? "final";
  const modules = await discoverModules(env);
  const mapped = mapRenderOverridesToModuleConfigs(args.parent.render_overrides ?? void 0, tier, modules);
  const cloudAllowed = cloudMotionModules(modules).map((m) => m.name);
  const gpuDoor = defaultGpuDoorModule(modules)?.name;
  let motionBackend;
  let perShotMotion;
  if (args.hybridBackends !== void 0) {
    const defaultCloud = resolveCloudModel(args.defaultCloudModel, cloudAllowed);
    const hybrid = perShotMotionFromHybrid(
      scenes,
      args.hybridBackends,
      args.defaultBackend ?? "gpu",
      defaultCloud,
      gpuDoor
    );
    if ("error" in hybrid) return { ok: false, error: hybrid.error, status: 400 };
    perShotMotion = hybrid.perShot;
    motionBackend = gpuDoor ?? defaultCloud;
  } else if (args.deriveMode === "cloud-finalized") {
    const defaultCloud = resolveCloudModel(args.motionBackend ?? args.defaultCloudModel, cloudAllowed);
    if (!defaultCloud) return { ok: false, error: "no cloud motion.backend module is installed", status: 400 };
    const normalized = args.perShotModels ? normalizePerShotModels(args.perShotModels, new Set(cloudAllowed)) : { perShot: {}, errors: [] };
    if (normalized.errors.length) return { ok: false, error: normalized.errors.join("; "), status: 400 };
    motionBackend = defaultCloud;
    perShotMotion = perShotMotionFromCloud(scenes, defaultCloud, normalized.perShot);
  } else {
    motionBackend = mapped.motion_backend ?? gpuDoor;
    if (!motionBackend) {
      return { ok: false, error: 'no gpu-door motion.backend module (ui.locality "byo"/"local") is installed', status: 400 };
    }
  }
  const motionInstalled = new Set(servingForHook(modules, "motion.backend").map((m) => m.name));
  const need = new Set(Object.values(perShotMotion ?? {}));
  if (motionBackend) need.add(motionBackend);
  for (const n of need) {
    if (!motionInstalled.has(n)) {
      return { ok: false, error: `motion.backend module "${n}" is not installed`, status: 400 };
    }
  }
  const job = await startFilmFromKeyframes(
    env,
    {
      project: args.parent.project,
      bundle_key: args.parent.bundle_key,
      scenes,
      keyframes,
      motion_backend: motionBackend,
      per_shot_motion: perShotMotion,
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      speech_config: mapped.speech_config,
      film_finish_config: mapped.film_finish_config,
      master_config: mapped.master_config,
      derive_mode: args.deriveMode,
      parent_render_id: args.parent.id,
      audio_key: args.audioKey
    },
    modules
  );
  const view = filmJobToPollView(job, null);
  const row = {
    jobId: view.jobId,
    project: args.parent.project,
    bundleKey: args.parent.bundle_key,
    qualityTier: tier,
    renderOverrides: args.parent.render_overrides ?? void 0,
    status: view.status,
    mode: args.deriveMode,
    parentId: args.parent.id,
    projectId: args.parent.project_id
  };
  await insertRender(env, row);
  return { ok: true, view };
}
__name(animateFromPreview, "animateFromPreview");
function clipAnimateProgress(clipJob, gpuDoors) {
  let gpuDone = 0;
  let gpuTotal = 0;
  let cloudDone = 0;
  let cloudTotal = 0;
  for (const sh of clipJob.shots) {
    const mod = sh.motion_backend ?? clipJob.motion_backend;
    if (mod == null || gpuDoors.has(mod)) {
      gpuTotal++;
      if (sh.status === "done") gpuDone++;
    } else {
      cloudTotal++;
      if (sh.status === "done") cloudDone++;
    }
  }
  const done = clipJob.shots.filter((s) => s.status === "done").length;
  const gpuStatus = gpuTotal > 0 ? gpuDone >= gpuTotal ? "done" : "rendering" : "done";
  return {
    done,
    total: clipJob.shots.length,
    gpu: { done: gpuDone, total: gpuTotal, status: gpuStatus },
    cloud: { done: cloudDone, total: cloudTotal }
  };
}
__name(clipAnimateProgress, "clipAnimateProgress");

// src/shared.ts
function isPresignSafeKey2(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("://")) return false;
  if (/[^ -~]/.test(key)) return false;
  return !key.split("/").includes("..");
}
__name(isPresignSafeKey2, "isPresignSafeKey");
function parseByteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(.*)$/.exec(header.trim());
  if (!m) return null;
  const specs = m[1].split(",");
  if (specs.length !== 1) return null;
  const spec = specs[0].trim();
  const dash = spec.indexOf("-");
  if (dash === -1) return null;
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  const digits = /^[0-9]*$/;
  if (!digits.test(startStr) || !digits.test(endStr)) return null;
  if (size <= 0) return "unsatisfiable";
  if (startStr === "") {
    if (endStr === "") return null;
    const n = Number(endStr);
    if (n === 0) return "unsatisfiable";
    const start2 = n >= size ? 0 : size - n;
    const end2 = size - 1;
    return { offset: start2, length: end2 - start2 + 1, start: start2, end: end2 };
  }
  const start = Number(startStr);
  if (start >= size) return "unsatisfiable";
  if (endStr === "") {
    const end2 = size - 1;
    return { offset: start, length: end2 - start + 1, start, end: end2 };
  }
  let end = Number(endStr);
  if (end < start) return null;
  if (end >= size) end = size - 1;
  return { offset: start, length: end - start + 1, start, end };
}
__name(parseByteRange, "parseByteRange");

// src/r2-presign.ts
var ENC = new TextEncoder();
var MAX_EXPIRES_SECONDS = 604800;
function clampExpires(seconds) {
  const n = Math.floor(Number(seconds));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_EXPIRES_SECONDS, Math.max(1, n));
}
__name(clampExpires, "clampExpires");
function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
__name(toHex, "toHex");
async function sha256Hex3(data) {
  return toHex(await crypto.subtle.digest("SHA-256", ENC.encode(data)));
}
__name(sha256Hex3, "sha256Hex");
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, ENC.encode(data));
}
__name(hmac, "hmac");
function uriEncode(str, encodeSlash) {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      for (const byte of ENC.encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}
__name(uriEncode, "uriEncode");
async function configFromEnv(env) {
  const accessKeyId = await secretValue(env.R2_S3_ACCESS_KEY_ID);
  const secretAccessKey = await secretValue(env.R2_S3_SECRET_ACCESS_KEY);
  const endpoint = env.R2_S3_ENDPOINT;
  const bucket = env.R2_S3_BUCKET;
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error(
      "R2 presign needs R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_S3_BUCKET"
    );
  }
  return { accessKeyId, secretAccessKey, endpoint, bucket };
}
__name(configFromEnv, "configFromEnv");
async function presignR2WithConfig(cfg, method, key, expiresSeconds = 300, nowMs) {
  if (!isPresignSafeKey2(key)) {
    throw new Error("R2 presign: refusing to sign an unsafe object key");
  }
  expiresSeconds = clampExpires(expiresSeconds);
  const url = new URL(cfg.endpoint);
  const host = url.host;
  const region = "auto";
  const service = "s3";
  const now = new Date(nowMs ?? Date.now());
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = "/" + uriEncode(cfg.bucket, true) + "/" + uriEncode(key, false);
  const q = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host"
  };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${uriEncode(k, true)}=${uriEncode(q[k], true)}`).join("&");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}
`,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex3(canonicalRequest)
  ].join("\n");
  const kDate = await hmac(ENC.encode("AWS4" + cfg.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));
  return `${cfg.endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
__name(presignR2WithConfig, "presignR2WithConfig");
var FILM_DOWNLOAD_TTL_SECONDS2 = 6 * 60 * 60;
function presignR2Get2(env, key, expiresSeconds = 300) {
  return configFromEnv(env).then((cfg) => presignR2WithConfig(cfg, "GET", key, expiresSeconds));
}
__name(presignR2Get2, "presignR2Get");
function presignR2Put2(env, key, expiresSeconds = 300) {
  return configFromEnv(env).then((cfg) => presignR2WithConfig(cfg, "PUT", key, expiresSeconds));
}
__name(presignR2Put2, "presignR2Put");

// src/cast-image-orchestrator.ts
var REF_TTL = 1800;
var MAX_REFS = 4;
var castRefsJobKey = /* @__PURE__ */ __name((castId, jobId) => `cast-gen/${castId}/${jobId}.refs-job.json`, "castRefsJobKey");
function selectSeedKeys(portraitKey, sourceKeys, wantKeys, max = MAX_REFS) {
  const valid = new Set(sourceKeys.map((s) => s.key));
  const want = (wantKeys ?? []).filter((k) => valid.has(k));
  const out = [];
  if (portraitKey) out.push(portraitKey);
  for (const k of want) if (!out.includes(k)) out.push(k);
  return out.slice(0, max);
}
__name(selectSeedKeys, "selectSeedKeys");
function summarizeCastRefs(job) {
  return {
    job_id: job.job_id,
    cast_id: job.cast_public_id,
    phase: job.phase,
    module: job.module_name ?? void 0,
    registered: job.registered,
    images: job.images,
    error: job.error
  };
}
__name(summarizeCastRefs, "summarizeCastRefs");
var putJob = /* @__PURE__ */ __name((env, job) => env.R2_RENDERS.put(castRefsJobKey(job.cast_id, job.job_id), JSON.stringify(job), {
  httpMetadata: { contentType: "application/json" }
}), "putJob");
async function finalize(env, job, output) {
  const imgs = (output.images || []).filter((i) => i && i.key && i.mime);
  job.images = imgs;
  job.applied = output.applied || [];
  if (imgs.length) {
    const row = await addRefs(env, job.cast_id, imgs);
    job.registered = row ? imgs.length : 0;
  }
  job.phase = "done";
}
__name(finalize, "finalize");
async function startCastRefsJob(env, args) {
  const cast = await getCastById(env, args.castId);
  if (!cast) return null;
  const job = {
    job_id: "refs-" + crypto.randomUUID(),
    cast_id: args.castId,
    cast_public_id: cast.public_id,
    module_name: null,
    binding: null,
    phase: "generating",
    images: [],
    applied: [],
    registered: 0,
    created_at: Date.now()
  };
  const seedKeys = selectSeedKeys(cast.portrait_key, cast.source_keys, args.sourceKeys);
  if (!seedKeys.length) {
    job.phase = "failed";
    job.error = "cast member has no portrait or source photo to generate from";
    await putJob(env, job);
    return job;
  }
  const envRec = env;
  const modules = await discoverModules(envRec);
  const module = resolvePickOne(modules, "cast.image", args.choice);
  if (!module) {
    job.phase = "failed";
    job.error = args.choice ? `no cast.image module named "${args.choice}"` : "no cast.image module installed";
    await putJob(env, job);
    return job;
  }
  job.module_name = module.name;
  job.binding = module.binding;
  const fetcher = resolveFetcher(envRec, module.binding);
  if (!fetcher) {
    job.phase = "failed";
    job.error = `cast.image module ${module.name} (${module.binding}) is not bound`;
    await putJob(env, job);
    return job;
  }
  const urls = await Promise.all(seedKeys.map((k) => presignR2Get2(env, k, REF_TTL)));
  const input = {
    cast_id: args.castId,
    portrait_url: urls[0],
    portrait_key: seedKeys[0],
    source_urls: urls.slice(1),
    bible: cast.bible ?? void 0,
    art_style: args.artStyle
  };
  const config = validateConfig(module.config_schema, args.config);
  const r = await invokeModule(fetcher, {
    hook: "cast.image",
    input,
    config,
    context: { project: `cast-${args.castId}`, job_id: job.job_id }
  });
  if (!r.ok) {
    job.phase = "failed";
    job.error = r.error;
  } else if (r.pending) {
    job.module_poll = r.poll;
  } else if ("output" in r) {
    const out = r.output;
    const violation = hookOutputViolation(module.name, "cast.image", out);
    if (violation) {
      job.phase = "failed";
      job.error = violation;
    } else await finalize(env, job, out);
  } else {
    job.phase = "failed";
    job.error = "cast.image module returned neither output nor a poll token";
  }
  await putJob(env, job);
  return job;
}
__name(startCastRefsJob, "startCastRefsJob");
async function advanceCastRefsJob(env, castId, jobId) {
  const obj = await env.R2_RENDERS.get(castRefsJobKey(castId, jobId));
  if (!obj) return null;
  const job = JSON.parse(await obj.text());
  if (job.phase !== "generating" || !job.module_poll || !job.binding) return job;
  const envRec = env;
  const fetcher = resolveFetcher(envRec, job.binding);
  if (!fetcher) {
    job.phase = "failed";
    job.error = "cast.image module no longer bound";
    await putJob(env, job);
    return job;
  }
  const p = await pollModule(fetcher, { poll: job.module_poll });
  if (!p.ok) {
    job.phase = "failed";
    job.error = p.error;
  } else if (!p.pending) {
    const out = p.output;
    const violation = hookOutputViolation(job.module_name ?? "cast.image", "cast.image", out);
    if (violation) {
      job.phase = "failed";
      job.error = violation;
    } else await finalize(env, job, out);
  }
  await putJob(env, job);
  return job;
}
__name(advanceCastRefsJob, "advanceCastRefsJob");

// src/platform/orchestrator-vars.ts
var ORCHESTRATOR_VAR_KEYS = [
  "AUTH_MODE",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "ALLOW_UNAUTHENTICATED",
  "DEMO_RENDER_ENABLED",
  "DEMO_ARTIFACT_ORIGIN",
  "DEMO_ASSISTANT_MODEL",
  "DEMO_RENDER_PER_IP_DAILY",
  "DEMO_RENDER_GLOBAL_DAILY",
  "DEMO_RENDER_QUEUE_DEPTH",
  "DEMO_CHAT_PER_IP_DAILY",
  "DEMO_CHAT_GLOBAL_DAILY",
  "PLANNER_AI_MOCK",
  "SPEND_LIMIT_FAIL_CLOSED",
  "SPEND_DAILY_CEILING",
  "FILM_CLIP_DURATION_FLOOR",
  "R2_S3_ENDPOINT",
  "R2_S3_BUCKET"
];

// src/platform/cf-presigner.ts
function cfPresignerFromEnv(env) {
  return {
    presignGet(key, expiresSec) {
      return presignR2Get2(env, key, expiresSec);
    },
    presignPut(key, contentType, expiresSec) {
      void contentType;
      return presignR2Put2(env, key, expiresSec);
    }
  };
}
__name(cfPresignerFromEnv, "cfPresignerFromEnv");

// src/platform/cf-secrets.ts
function cfSecretStoreFromEnv(env) {
  return {
    async get(name) {
      const raw = env[name];
      if (raw === void 0) return void 0;
      const value = await secretValue(raw);
      return value || void 0;
    }
  };
}
__name(cfSecretStoreFromEnv, "cfSecretStoreFromEnv");

// src/platform/cf-module-transport.ts
function isFetcher2(v) {
  return !!v && typeof v.fetch === "function";
}
__name(isFetcher2, "isFetcher");
var CfModuleTransport = class {
  constructor(env) {
    this.env = env;
  }
  env;
  static {
    __name(this, "CfModuleTransport");
  }
  resolve(binding) {
    if (binding === DISPATCH_BINDING) return null;
    const v = this.env[binding];
    return isFetcher2(v) ? v : null;
  }
  listBindings() {
    const keys = [];
    for (const key of Object.keys(this.env)) {
      if (!key.startsWith("MODULE_") || key === DISPATCH_BINDING) continue;
      if (isFetcher2(this.env[key])) keys.push(key);
    }
    keys.sort();
    return keys;
  }
  /** WfP dispatch namespace when bound (registry resolves `dispatch:` refs). */
  dispatchNamespace() {
    return this.env.MODULE_DISPATCH;
  }
};
function cfModuleTransportFromEnv(env) {
  return new CfModuleTransport(env);
}
__name(cfModuleTransportFromEnv, "cfModuleTransportFromEnv");

// src/platform/cf-r2-store.ts
var CfR2ObjectStore = class {
  constructor(bucket) {
    this.bucket = bucket;
  }
  bucket;
  static {
    __name(this, "CfR2ObjectStore");
  }
  async get(key) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return obj.arrayBuffer();
  }
  async put(key, value, opts) {
    await this.bucket.put(key, value, opts?.httpMetadata ? { httpMetadata: opts.httpMetadata } : void 0);
  }
  async head(key) {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return {
      size: obj.size,
      etag: obj.etag,
      uploaded: obj.uploaded,
      httpMetadata: obj.httpMetadata
    };
  }
  async delete(key) {
    await this.bucket.delete(key);
  }
};
function cfObjectStoreFromR2(bucket) {
  return new CfR2ObjectStore(bucket);
}
__name(cfObjectStoreFromR2, "cfObjectStoreFromR2");

// src/platform/cf-platform.ts
function pickOrchestratorVars(env) {
  const vars = {};
  for (const key of ORCHESTRATOR_VAR_KEYS) {
    const v = env[key];
    if (typeof v === "string") vars[key] = v;
  }
  return vars;
}
__name(pickOrchestratorVars, "pickOrchestratorVars");
function pickHostBindings(env) {
  const out = {};
  if (env.VIDEO_FINISH_VPC) out.VIDEO_FINISH_VPC = env.VIDEO_FINISH_VPC;
  if (env.IMAGE_PREP_VPC) out.IMAGE_PREP_VPC = env.IMAGE_PREP_VPC;
  if (env.AUDIO_BEAT_SYNC_VPC) out.AUDIO_BEAT_SYNC_VPC = env.AUDIO_BEAT_SYNC_VPC;
  if (env.AUDIO_MIX_VPC) out.AUDIO_MIX_VPC = env.AUDIO_MIX_VPC;
  return out;
}
__name(pickHostBindings, "pickHostBindings");
function cfRateLimiterFromEnv(env) {
  const binding = env.SPEND_RATE_LIMITER;
  if (!binding) return void 0;
  return {
    limit(key) {
      return binding.limit({ key });
    }
  };
}
__name(cfRateLimiterFromEnv, "cfRateLimiterFromEnv");
function cfPlatformFromEnv(env) {
  const modules = cfModuleTransportFromEnv(env);
  const platform = {
    db: env.DB,
    renders: cfObjectStoreFromR2(env.R2_RENDERS),
    // Chat artifacts live in the SERVED bucket as of cf#140, so chatBucket points at the same
    // binding as renders. env.R2 (the separate chat bucket) is no longer where they land, and
    // pointing this at it would recreate the write/serve split through the Platform ICD.
    chatBucket: cfObjectStoreFromR2(env.R2_RENDERS),
    presigner: cfPresignerFromEnv(env),
    secrets: cfSecretStoreFromEnv(env),
    modules,
    rateLimiter: cfRateLimiterFromEnv(env),
    vars: pickOrchestratorVars(env),
    hostBindings: pickHostBindings(env)
  };
  if (env.MODULE_DISPATCH) {
    platform.vars.MODULE_DISPATCH = env.MODULE_DISPATCH;
  }
  return platform;
}
__name(cfPlatformFromEnv, "cfPlatformFromEnv");

// src/orchestrator-env.ts
function orchestratorEnv(env) {
  return orchestratorContextFromPlatform(cfPlatformFromEnv(env));
}
__name(orchestratorEnv, "orchestratorEnv");
function studioEnv(raw) {
  const { PRESIGNER } = orchestratorEnv(raw);
  return Object.assign(raw, { PRESIGNER });
}
__name(studioEnv, "studioEnv");

// src/utils.ts
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(base64ToBytes, "base64ToBytes");
function extFromMime(mime) {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("quicktime")) return "mov";
  if (m.includes("mov")) return "mov";
  if (m.includes("matroska") || m.includes("mkv")) return "mkv";
  if (m.includes("mp3")) return "mp3";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("m4a")) return "m4a";
  return "bin";
}
__name(extFromMime, "extFromMime");

// src/cast-media.ts
var CAST_IMAGE_MIME_RE = /^image\/(png|jpe?g|webp)$/i;
var CAST_MAX_BYTES = 16 * 1024 * 1024;
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
  static {
    __name(this, "HttpError");
  }
};
function sniffCastImageMime(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 4 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) {
    return "image/png";
  }
  if (b.length >= 12 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) {
    return "image/webp";
  }
  return null;
}
__name(sniffCastImageMime, "sniffCastImageMime");
function resolveCastImageMime(claimed, bytes) {
  const raw = (claimed || "").toLowerCase().split(";")[0].trim();
  if (!CAST_IMAGE_MIME_RE.test(raw)) {
    throw new Error(`mime ${raw || "<missing>"} not allowed (png/jpeg/webp only)`);
  }
  const mime = raw === "image/jpg" ? "image/jpeg" : raw;
  if (bytes !== void 0) {
    const sniffed = sniffCastImageMime(bytes);
    if (!sniffed) {
      throw new Error("bytes are not a recognizable png/jpeg/webp image");
    }
    if (sniffed !== mime) {
      throw new Error(`claimed mime ${mime} does not match content (${sniffed})`);
    }
  }
  return mime;
}
__name(resolveCastImageMime, "resolveCastImageMime");
function requireCastImageMime(claimed, bytes) {
  try {
    return resolveCastImageMime(claimed, bytes);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}
__name(requireCastImageMime, "requireCastImageMime");
function requireCastStagedKey(castId, key) {
  const prefix = `cast/${castId}/`;
  if (!isSafeRelKey(key) || !key.startsWith(prefix) || key.length <= prefix.length) {
    throw new HttpError(400, "key must be a safe staged path under this cast member");
  }
  return key;
}
__name(requireCastStagedKey, "requireCastStagedKey");
function json3(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json3, "json");
function wrap(fn) {
  return fn().catch((e) => {
    if (e instanceof HttpError) return json3({ error: e.message }, e.status);
    throw e;
  });
}
__name(wrap, "wrap");
async function copyChatArtifactToRenders(env, srcKey, destPrefix) {
  const obj = await env.R2_RENDERS.get(srcKey);
  if (!obj) throw new HttpError(404, `source artifact not found: ${srcKey}`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.length > CAST_MAX_BYTES) {
    throw new HttpError(413, "source image too large (16 MB max)");
  }
  const mime = requireCastImageMime(obj.httpMetadata?.contentType || "", bytes);
  const key = `${destPrefix}.${extFromMime(mime)}`;
  await env.R2_RENDERS.put(key, bytes, {
    httpMetadata: { contentType: mime }
  });
  return { key, mime };
}
__name(copyChatArtifactToRenders, "copyChatArtifactToRenders");
async function handleCastPortraitUpload(request, env, id) {
  return wrap(async () => {
    const cur = await getCastById(env, id);
    if (!cur) throw new HttpError(404, "cast not found");
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    if (contentType.startsWith("application/json")) {
      let body;
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      if (typeof body.from_chat_artifact === "string" && body.from_chat_artifact) {
        if (cur.portrait_key) {
          try {
            await env.R2_RENDERS.delete(cur.portrait_key);
          } catch {
          }
        }
        const { key: key3, mime: mime3 } = await copyChatArtifactToRenders(
          env,
          body.from_chat_artifact,
          `cast/${id}/portrait`
        );
        const row3 = await setPortrait(env, id, key3, mime3);
        return json3({ cast: row3 ? toPublicCast(row3) : null });
      }
      if (!body.key || !body.mime) throw new HttpError(400, "key and mime required");
      const mime2 = requireCastImageMime(body.mime);
      const key2 = requireCastStagedKey(id, body.key);
      const row2 = await setPortrait(env, id, key2, mime2);
      if (!row2) throw new HttpError(404, "cast not found");
      return json3({ cast: row2 ? toPublicCast(row2) : null });
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty body");
    if (buf.byteLength > CAST_MAX_BYTES) throw new HttpError(413, "image too large (16 MB max)");
    const mime = requireCastImageMime(contentType, buf);
    if (cur.portrait_key) {
      try {
        await env.R2_RENDERS.delete(cur.portrait_key);
      } catch {
      }
    }
    const key = `cast/${id}/portrait.${extFromMime(mime)}`;
    await env.R2_RENDERS.put(key, new Uint8Array(buf), {
      httpMetadata: { contentType: mime }
    });
    const row = await setPortrait(env, id, key, mime);
    return json3({ cast: row ? toPublicCast(row) : null });
  });
}
__name(handleCastPortraitUpload, "handleCastPortraitUpload");
async function handleCastRefAdd(request, env, id) {
  return wrap(async () => {
    const cur = await getCastById(env, id);
    if (!cur) throw new HttpError(404, "cast not found");
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    if (contentType.startsWith("application/json")) {
      let body;
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      if (typeof body.from_chat_artifact === "string" && body.from_chat_artifact) {
        const { key: key3, mime: mime3 } = await copyChatArtifactToRenders(
          env,
          body.from_chat_artifact,
          `cast/${id}/refs/${crypto.randomUUID()}`
        );
        const row3 = await addRef(env, id, { key: key3, mime: mime3 });
        return json3({ cast: row3 ? toPublicCast(row3) : null });
      }
      if (!body.key || !body.mime) throw new HttpError(400, "key and mime required");
      const mime2 = requireCastImageMime(body.mime);
      const key2 = requireCastStagedKey(id, body.key);
      const row2 = await addRef(env, id, { key: key2, mime: mime2 });
      if (!row2) throw new HttpError(404, "cast not found");
      return json3({ cast: row2 ? toPublicCast(row2) : null });
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty body");
    if (buf.byteLength > CAST_MAX_BYTES) throw new HttpError(413, "image too large (16 MB max)");
    const mime = requireCastImageMime(contentType, buf);
    const key = `cast/${id}/refs/${crypto.randomUUID()}.${extFromMime(mime)}`;
    await env.R2_RENDERS.put(key, new Uint8Array(buf), {
      httpMetadata: { contentType: mime }
    });
    const row = await addRef(env, id, { key, mime });
    return json3({ cast: row ? toPublicCast(row) : null });
  });
}
__name(handleCastRefAdd, "handleCastRefAdd");
async function handleCastRefRemove(env, id, refKey) {
  const result = await removeRef(env, id, refKey);
  if (!result.row) return json3({ error: "cast not found" }, 404);
  if (!result.removedKey) return json3({ error: "ref key not in this cast member's set" }, 404);
  try {
    await env.R2_RENDERS.delete(result.removedKey);
  } catch {
  }
  return json3({ cast: result.row ? toPublicCast(result.row) : null });
}
__name(handleCastRefRemove, "handleCastRefRemove");
async function handleCastSourceAdd(request, env, id) {
  return wrap(async () => {
    const cur = await getCastById(env, id);
    if (!cur) throw new HttpError(404, "cast not found");
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    if (contentType.startsWith("application/json")) {
      let body;
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      if (typeof body.from_chat_artifact === "string" && body.from_chat_artifact) {
        const { key: key3, mime: mime3 } = await copyChatArtifactToRenders(
          env,
          body.from_chat_artifact,
          `cast/${id}/sources/${crypto.randomUUID()}`
        );
        const row3 = await addSource(env, id, { key: key3, mime: mime3 });
        return json3({ cast: row3 ? toPublicCast(row3) : null });
      }
      if (!body.key || !body.mime) throw new HttpError(400, "key and mime required");
      const mime2 = requireCastImageMime(body.mime);
      const key2 = requireCastStagedKey(id, body.key);
      const row2 = await addSource(env, id, { key: key2, mime: mime2 });
      if (!row2) throw new HttpError(404, "cast not found");
      return json3({ cast: row2 ? toPublicCast(row2) : null });
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "empty body");
    if (buf.byteLength > CAST_MAX_BYTES) throw new HttpError(413, "image too large (16 MB max)");
    const mime = requireCastImageMime(contentType, buf);
    const key = `cast/${id}/sources/${crypto.randomUUID()}.${extFromMime(mime)}`;
    await env.R2_RENDERS.put(key, new Uint8Array(buf), {
      httpMetadata: { contentType: mime }
    });
    const row = await addSource(env, id, { key, mime });
    return json3({ cast: row ? toPublicCast(row) : null });
  });
}
__name(handleCastSourceAdd, "handleCastSourceAdd");
async function handleCastSourceRemove(env, id, srcKey) {
  const result = await removeSource(env, id, srcKey);
  if (!result.row) return json3({ error: "cast not found" }, 404);
  if (!result.removedKey) return json3({ error: "source key not in this cast member's set" }, 404);
  try {
    await env.R2_RENDERS.delete(result.removedKey);
  } catch {
  }
  return json3({ cast: result.row ? toPublicCast(result.row) : null });
}
__name(handleCastSourceRemove, "handleCastSourceRemove");
async function deleteCastArtifacts(env, cast) {
  const keys = [
    cast.portrait_key,
    ...cast.ref_keys.map((r) => r.key),
    ...cast.source_keys.map((s) => s.key),
    cast.lora_key
  ].filter((k) => typeof k === "string" && k.length > 0);
  for (const key of keys) {
    try {
      await env.R2_RENDERS.delete(key);
    } catch {
    }
  }
}
__name(deleteCastArtifacts, "deleteCastArtifacts");

// src/cast-bundle.ts
var CAST_BUNDLE_FORMAT = "vivijure-cast-bundle";
var CAST_BUNDLE_SCHEMA_VERSION = 1;
var CAST_BUNDLE_MEDIA_TYPE = "application/x-tar";
var CAST_BUNDLE_EXT = "vvcast";
var CAST_BUNDLE_MAX_IMPORT_BYTES = 80 * 1024 * 1024;
var MANIFEST_NAME = "manifest.json";
var BundleError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
  static {
    __name(this, "BundleError");
  }
};
function json4(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json4, "json");
function planExport(cast) {
  const entries = [];
  if (cast.portrait_key) {
    const ext = extFromMime(cast.portrait_mime || "image/png");
    entries.push({
      path: `assets/portrait.${ext}`,
      r2Key: cast.portrait_key,
      mime: cast.portrait_mime || "image/png"
    });
  }
  cast.ref_keys.forEach((r, i) => {
    entries.push({
      path: `assets/refs/${i}.${extFromMime(r.mime)}`,
      r2Key: r.key,
      mime: r.mime
    });
  });
  cast.source_keys.forEach((s, i) => {
    entries.push({
      path: `assets/sources/${i}.${extFromMime(s.mime)}`,
      r2Key: s.key,
      mime: s.mime
    });
  });
  if (cast.lora_key) {
    entries.push({
      path: "assets/lora.safetensors",
      r2Key: cast.lora_key,
      mime: "application/octet-stream"
    });
  }
  return entries;
}
__name(planExport, "planExport");
function buildManifest(cast, present, exportedAt) {
  const find = /* @__PURE__ */ __name((pred) => present.find(pred) || null, "find");
  const portrait = find((e) => e.path.startsWith("assets/portrait."));
  const lora = find((e) => e.path === "assets/lora.safetensors");
  const refs = present.filter((e) => e.path.startsWith("assets/refs/"));
  const sources = present.filter((e) => e.path.startsWith("assets/sources/"));
  const ref = /* @__PURE__ */ __name((e) => e ? { path: e.path, mime: e.mime } : null, "ref");
  return {
    format: CAST_BUNDLE_FORMAT,
    schema_version: CAST_BUNDLE_SCHEMA_VERSION,
    exported_at: exportedAt,
    creator: null,
    cast: {
      name: cast.name,
      slug: cast.slug,
      bible: cast.bible,
      voice_id: cast.voice_id,
      lora_status: cast.lora_status,
      lora_trained_at: cast.lora_trained_at
    },
    assets: {
      portrait: ref(portrait),
      refs: refs.map((e) => ({ path: e.path, mime: e.mime })),
      sources: sources.map((e) => ({ path: e.path, mime: e.mime })),
      lora: ref(lora)
    }
  };
}
__name(buildManifest, "buildManifest");
async function r2ObjectBytes(obj) {
  if (typeof obj.arrayBuffer === "function") {
    return new Uint8Array(await obj.arrayBuffer());
  }
  if (!obj.body) throw new Error("R2 object has no readable body");
  const reader = obj.body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
__name(r2ObjectBytes, "r2ObjectBytes");
async function exportCastBundle(env, id) {
  const cast = await getCastById(env, id);
  if (!cast) return json4({ error: "cast not found" }, 404);
  const planned = planExport(cast);
  const present = [];
  for (const e of planned) {
    const head = await env.R2_RENDERS.head(e.r2Key);
    if (!head) {
      console.warn(
        `cast ${id} export: artifact ${e.r2Key} (${e.path}) missing from R2 -- dropped from bundle`
      );
      continue;
    }
    present.push(e);
  }
  const exportedAt = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = buildManifest(cast, present, exportedAt);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const tarFiles = [{ name: MANIFEST_NAME, content: manifestBytes }];
  for (const e of present) {
    const obj = await env.R2_RENDERS.get(e.r2Key);
    if (!obj) {
      console.warn(`cast ${id} export: artifact ${e.r2Key} vanished before read -- skipped`);
      continue;
    }
    const bytes = await r2ObjectBytes(obj);
    tarFiles.push({ name: e.path, content: bytes });
  }
  const tar = emitTar(tarFiles);
  const filename = `${cast.slug || "cast"}.${CAST_BUNDLE_EXT}`;
  return new Response(tar, {
    status: 200,
    headers: {
      "content-type": CAST_BUNDLE_MEDIA_TYPE,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store"
    }
  });
}
__name(exportCastBundle, "exportCastBundle");
function validateManifest2(raw) {
  if (!raw || typeof raw !== "object") throw new BundleError(400, "bundle manifest is not an object");
  const m = raw;
  if (m.format !== CAST_BUNDLE_FORMAT) {
    throw new BundleError(400, `not a vivijure cast bundle (format=${JSON.stringify(m.format)})`);
  }
  if (typeof m.schema_version !== "number" || !Number.isInteger(m.schema_version)) {
    throw new BundleError(400, "bundle schema_version missing or not an integer");
  }
  if (m.schema_version > CAST_BUNDLE_SCHEMA_VERSION) {
    throw new BundleError(
      400,
      `bundle schema_version ${m.schema_version} is newer than this instance supports (${CAST_BUNDLE_SCHEMA_VERSION}); upgrade to import it`
    );
  }
  const cast = m.cast;
  if (!cast || typeof cast.name !== "string" || !cast.name.trim()) {
    throw new BundleError(400, "bundle cast.name missing");
  }
  const assets = m.assets;
  if (!assets || typeof assets !== "object") throw new BundleError(400, "bundle assets missing");
  const refList = /* @__PURE__ */ __name((v) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new BundleError(400, "bundle asset list is not an array");
    return v.map((a) => {
      if (!a || typeof a !== "object" || typeof a.path !== "string") {
        throw new BundleError(400, "bundle asset entry missing path");
      }
      const ar = a;
      return { path: ar.path, mime: typeof ar.mime === "string" ? ar.mime : "application/octet-stream" };
    });
  }, "refList");
  const single = /* @__PURE__ */ __name((v) => {
    if (v == null) return null;
    return refList([v])[0];
  }, "single");
  return {
    format: CAST_BUNDLE_FORMAT,
    schema_version: m.schema_version,
    exported_at: typeof m.exported_at === "string" ? m.exported_at : void 0,
    creator: typeof cast.creator === "string" ? cast.creator : typeof m.creator === "string" ? m.creator : null,
    cast: {
      name: cast.name,
      slug: typeof cast.slug === "string" ? cast.slug : void 0,
      bible: typeof cast.bible === "string" ? cast.bible : null,
      voice_id: typeof cast.voice_id === "string" ? cast.voice_id : null,
      lora_status: normalizeLoraStatus2(cast.lora_status),
      lora_trained_at: typeof cast.lora_trained_at === "string" ? cast.lora_trained_at : null
    },
    assets: {
      portrait: single(assets.portrait),
      refs: refList(assets.refs),
      sources: refList(assets.sources),
      lora: single(assets.lora)
    }
  };
}
__name(validateManifest2, "validateManifest");
function normalizeLoraStatus2(raw) {
  return raw === "training" || raw === "ready" || raw === "failed" ? raw : "idle";
}
__name(normalizeLoraStatus2, "normalizeLoraStatus");
async function importCastBundle(env, body) {
  return importInner(env, body).catch((e) => {
    if (e instanceof BundleError) return json4({ error: e.message }, e.status);
    throw e;
  });
}
__name(importCastBundle, "importCastBundle");
async function importInner(env, body) {
  if (body.length === 0) throw new BundleError(400, "empty bundle body");
  if (body.length > CAST_BUNDLE_MAX_IMPORT_BYTES) {
    throw new BundleError(
      413,
      `bundle too large (${body.length} bytes > ${CAST_BUNDLE_MAX_IMPORT_BYTES} cap)`
    );
  }
  let files;
  try {
    files = readTar(body);
  } catch (e) {
    throw new BundleError(400, `not a readable tar bundle: ${e.message}`);
  }
  const byName = new Map(files.map((f) => [f.name, f.content]));
  const manifestRaw = byName.get(MANIFEST_NAME);
  if (!manifestRaw) throw new BundleError(400, `bundle missing ${MANIFEST_NAME}`);
  let manifestJson;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    throw new BundleError(400, `bundle ${MANIFEST_NAME} is not valid JSON`);
  }
  const manifest = validateManifest2(manifestJson);
  const allRefs = [
    ...manifest.assets.portrait ? [manifest.assets.portrait] : [],
    ...manifest.assets.refs,
    ...manifest.assets.sources,
    ...manifest.assets.lora ? [manifest.assets.lora] : []
  ];
  for (const a of allRefs) {
    if (!byName.has(a.path)) {
      throw new BundleError(400, `bundle manifest references ${a.path} but the tar has no such entry`);
    }
  }
  const resolve2 = /* @__PURE__ */ __name((a) => {
    const data = byName.get(a.path);
    if (!data) {
      throw new BundleError(400, `bundle manifest references ${a.path} but the tar has no such entry`);
    }
    return data;
  }, "resolve");
  const resolveImage2 = /* @__PURE__ */ __name((a, label) => {
    const bytes = resolve2(a);
    try {
      return { bytes, mime: resolveCastImageMime(a.mime, bytes) };
    } catch (e) {
      throw new BundleError(400, `${label}: ${e.message}`);
    }
  }, "resolveImage");
  const portrait = manifest.assets.portrait ? resolveImage2(manifest.assets.portrait, "bundle portrait") : null;
  const refsIn = manifest.assets.refs.map((a) => resolveImage2(a, `bundle ref ${a.path}`));
  const sourcesIn = manifest.assets.sources.map((a) => resolveImage2(a, `bundle source ${a.path}`));
  const created = await createCast(env, { name: manifest.cast.name, bible: manifest.cast.bible });
  const id = created.id;
  if (portrait) {
    const key = `cast/${id}/portrait.${extFromMime(portrait.mime)}`;
    await env.R2_RENDERS.put(key, portrait.bytes, { httpMetadata: { contentType: portrait.mime } });
    await setPortrait(env, id, key, portrait.mime);
  }
  if (refsIn.length) {
    const refs = [];
    for (const img of refsIn) {
      const key = `cast/${id}/refs/${crypto.randomUUID()}.${extFromMime(img.mime)}`;
      await env.R2_RENDERS.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
      refs.push({ key, mime: img.mime });
    }
    await addRefs(env, id, refs);
  }
  for (const img of sourcesIn) {
    const key = `cast/${id}/sources/${crypto.randomUUID()}.${extFromMime(img.mime)}`;
    await env.R2_RENDERS.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    await addSource(env, id, { key, mime: img.mime });
  }
  if (manifest.assets.lora) {
    const bytes = resolve2(manifest.assets.lora);
    const key = `loras/cast-${id}-${crypto.randomUUID()}.safetensors`;
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    await markLoraReady(env, id, key);
  }
  if (manifest.cast.voice_id && isValidVoiceId(manifest.cast.voice_id)) {
    await updateCast(env, id, { voice_id: manifest.cast.voice_id });
  } else if (manifest.cast.voice_id) {
    console.warn(
      `cast import ${id}: bundle voice_id "${manifest.cast.voice_id}" unknown on this instance -- dropped`
    );
  }
  const row = await getCastById(env, id);
  return json4(
    { cast: row ? toPublicCast(row) : null, imported_from_schema: manifest.schema_version },
    201
  );
}
__name(importInner, "importInner");

// src/access-auth.ts
function accessConfig(env) {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || "").trim();
  const aud = (env.ACCESS_AUD || "").trim();
  if (!teamDomain || !aud) return null;
  return { teamDomain, aud };
}
__name(accessConfig, "accessConfig");
var ASSERTION_HEADER = "cf-access-jwt-assertion";
function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(base64UrlToBytes, "base64UrlToBytes");
function decodeJsonSegment(seg) {
  const json6 = new TextDecoder().decode(base64UrlToBytes(seg));
  const obj = JSON.parse(json6);
  if (!obj || typeof obj !== "object") throw new Error("segment is not a JSON object");
  return obj;
}
__name(decodeJsonSegment, "decodeJsonSegment");
var jwksCache = /* @__PURE__ */ new Map();
var JWKS_TTL_MS = 60 * 60 * 1e3;
var defaultCertsFetcher = /* @__PURE__ */ __name(async (teamDomain) => {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" }
  });
  if (!res.ok) throw new Error(`certs endpoint -> ${res.status}`);
  return await res.json();
}, "defaultCertsFetcher");
async function importRsaKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}
__name(importRsaKey, "importRsaKey");
async function loadKeys(teamDomain, fetcher, nowMs) {
  const cached = jwksCache.get(teamDomain);
  if (cached && nowMs - cached.fetchedAt < JWKS_TTL_MS) return cached;
  try {
    const doc = await fetcher(teamDomain);
    const byKid = /* @__PURE__ */ new Map();
    for (const jwk of doc.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
      byKid.set(jwk.kid, await importRsaKey(jwk));
    }
    if (byKid.size === 0) throw new Error("certs document had no usable RSA keys");
    const fresh = { byKid, fetchedAt: nowMs };
    jwksCache.set(teamDomain, fresh);
    return fresh;
  } catch (e) {
    if (cached) {
      console.warn(`access: JWKS refetch failed (${e.message}); using cached keys`);
      return cached;
    }
    throw e;
  }
}
__name(loadKeys, "loadKeys");
async function verifyAccessRequest(request, cfg, opts = {}) {
  const token = request.headers.get(ASSERTION_HEADER);
  if (!token) return { ok: false, status: 403, reason: "missing Cf-Access-Jwt-Assertion" };
  const nowMs = opts.nowMs ?? Date.now();
  const fetcher = opts.certsFetcher ?? defaultCertsFetcher;
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, reason: "malformed JWT" };
  const [headerSeg, payloadSeg, signatureSeg] = parts;
  let header;
  let payload;
  try {
    header = decodeJsonSegment(headerSeg);
    payload = decodeJsonSegment(payloadSeg);
  } catch {
    return { ok: false, status: 403, reason: "undecodable JWT segments" };
  }
  if (header.alg !== "RS256") return { ok: false, status: 403, reason: `unsupported alg ${String(header.alg)}` };
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) return { ok: false, status: 403, reason: "JWT header missing kid" };
  let keys;
  try {
    keys = await loadKeys(cfg.teamDomain, fetcher, nowMs);
  } catch (e) {
    return { ok: false, status: 503, reason: `cannot load Access keys: ${e.message}` };
  }
  const key = keys.byKid.get(kid);
  if (!key) return { ok: false, status: 403, reason: `unknown signing key (kid ${kid})` };
  const signed = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  let sig;
  try {
    sig = base64UrlToBytes(signatureSeg);
  } catch {
    return { ok: false, status: 403, reason: "undecodable signature" };
  }
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    sig,
    signed
  );
  if (!valid) return { ok: false, status: 403, reason: "bad signature" };
  const nowSec = Math.floor(nowMs / 1e3);
  const skew = 60;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
  if (exp === null || nowSec > exp + skew) return { ok: false, status: 403, reason: "token expired" };
  if (nbf !== null && nowSec + skew < nbf) return { ok: false, status: 403, reason: "token not yet valid" };
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (iss !== `https://${cfg.teamDomain}`) return { ok: false, status: 403, reason: "wrong issuer" };
  const audClaim = payload.aud;
  const auds = Array.isArray(audClaim) ? audClaim : typeof audClaim === "string" ? [audClaim] : [];
  if (!auds.includes(cfg.aud)) return { ok: false, status: 403, reason: "wrong audience" };
  return {
    ok: true,
    sub: typeof payload.sub === "string" ? payload.sub : null,
    email: typeof payload.email === "string" ? payload.email : null
  };
}
__name(verifyAccessRequest, "verifyAccessRequest");
var warnedOptOut = false;
async function gateApiRequest(request, env, opts = {}) {
  const cfg = accessConfig(env);
  if (cfg) return verifyAccessRequest(request, cfg, opts);
  if ((env.ALLOW_UNAUTHENTICATED || "").trim() === "true") {
    if (!warnedOptOut) {
      warnedOptOut = true;
      console.log(
        JSON.stringify({
          ev: "auth.allow_unauthenticated",
          msg: "in-Worker auth verification DISABLED (ALLOW_UNAUTHENTICATED=true; edge gate / own proxy only)"
        })
      );
      console.warn(
        "access: ALLOW_UNAUTHENTICATED=true -> in-Worker Access verification DISABLED (edge gate only). NOT for a public/multi-tenant deploy; arm ACCESS_TEAM_DOMAIN + ACCESS_AUD instead."
      );
    }
    return { ok: true, sub: null, email: null };
  }
  return {
    ok: false,
    status: 503,
    reason: "auth not configured: set ACCESS_TEAM_DOMAIN + ACCESS_AUD to arm the backstop, or ALLOW_UNAUTHENTICATED=true to consciously opt out (dev/own-proxy only)"
  };
}
__name(gateApiRequest, "gateApiRequest");

// src/auth-gate.ts
var TOKEN_COOKIE = "vivijure_token";
async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
function presentedToken(request) {
  const authz = (request.headers.get("authorization") || "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(authz);
  if (m) return m[1];
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === TOKEN_COOKIE) {
      const v = part.slice(eq + 1).trim();
      if (v.length === 0) return null;
      try {
        return decodeURIComponent(v);
      } catch {
        return null;
      }
    }
  }
  return null;
}
__name(presentedToken, "presentedToken");
async function sha256Hex4(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex4, "sha256Hex");
async function namedTokenConsumer(presented, env) {
  if (!env.DB) return null;
  try {
    const hash = await sha256Hex4(presented);
    const row = await env.DB.prepare(
      "SELECT name FROM api_tokens WHERE token_hash = ?1 AND revoked_at IS NULL"
    ).bind(hash).first();
    return row?.name ?? null;
  } catch {
    return null;
  }
}
__name(namedTokenConsumer, "namedTokenConsumer");
async function verifyTokenRequest(request, env) {
  const secret = (env.STUDIO_API_TOKEN || "").trim();
  if (!secret) {
    return {
      ok: false,
      status: 403,
      reason: "token mode: STUDIO_API_TOKEN secret is not set -- denying everything (fail closed). Set it: openssl rand -hex 32 | npx wrangler secret put STUDIO_API_TOKEN"
    };
  }
  const presented = presentedToken(request);
  if (presented === null) {
    return { ok: false, status: 403, reason: "missing API token: send Authorization: Bearer <your studio API token>" };
  }
  if (await constantTimeEqual(presented, secret)) {
    return { ok: true, sub: "studio-api-token", email: null };
  }
  const consumer = await namedTokenConsumer(presented, env);
  if (consumer !== null) {
    return { ok: true, sub: `api-token:${consumer}`, email: null };
  }
  return { ok: false, status: 403, reason: "bad API token" };
}
__name(verifyTokenRequest, "verifyTokenRequest");
function isDemoMode(env) {
  return (env.AUTH_MODE || "").trim() === "demo";
}
__name(isDemoMode, "isDemoMode");
function catalogForDeploy(env, catalog) {
  return isDemoMode(env) ? [] : catalog;
}
__name(catalogForDeploy, "catalogForDeploy");
var DEMO_WRITE_ROUTES = /* @__PURE__ */ new Set(["/api/demo/render", "/api/demo/chat"]);
function verifyDemoRequest(request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { ok: true, sub: "demo-visitor", email: null };
  }
  if (method === "POST" && DEMO_WRITE_ROUTES.has(new URL(request.url).pathname)) {
    return { ok: true, sub: "demo-visitor", email: null };
  }
  return {
    ok: false,
    status: 403,
    reason: "demo studio is read-only: mutations are disabled on this deployment. Run your own studio to render."
  };
}
__name(verifyDemoRequest, "verifyDemoRequest");
async function gateApi(request, env, opts = {}) {
  const mode = (env.AUTH_MODE || "").trim();
  if (mode === "token") return verifyTokenRequest(request, env);
  if (mode === "demo") return verifyDemoRequest(request);
  if (mode === "access" || mode === "") return gateApiRequest(request, env, opts);
  return {
    ok: false,
    status: 403,
    reason: `unknown AUTH_MODE ${JSON.stringify(mode)} (expected "access", "token", or "demo") -- denying (fail closed)`
  };
}
__name(gateApi, "gateApi");

// src/asset-response.ts
var STUDIO_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
var DEMO_MEDIA_ORIGIN = "https://assets.skyphusion.net";
var STUDIO_DEMO_CSP = STUDIO_CSP.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: " + DEMO_MEDIA_ORIGIN) + "; media-src 'self' " + DEMO_MEDIA_ORIGIN;
var LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
function companions(h) {
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("x-frame-options", "DENY");
  return h;
}
__name(companions, "companions");
function pageHeaders(h, csp) {
  companions(h);
  h.set("content-security-policy", csp);
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return h;
}
__name(pageHeaders, "pageHeaders");
function baselineHeaders(h) {
  companions(h);
  h.set("content-security-policy", LOCKED_CSP);
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return h;
}
__name(baselineHeaders, "baselineHeaders");
var STUDIO_PAGE_PATHS = /* @__PURE__ */ new Set([
  "/",
  "/index.html",
  "/planner",
  "/planner/",
  "/planner.html",
  "/cast",
  "/cast/",
  "/cast.html",
  "/modules",
  "/modules/",
  "/modules.html",
  "/settings",
  "/settings/",
  "/settings.html"
]);
function pageClass(pathname) {
  if (STUDIO_PAGE_PATHS.has(pathname)) return "studio";
  return null;
}
__name(pageClass, "pageClass");
function rebuild(res, headers, body) {
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
__name(rebuild, "rebuild");
function applyResponseSecurity(res, request, env) {
  const ct = res.headers.get("content-type") || "";
  const cls = ct.includes("text/html") ? pageClass(new URL(request.url).pathname) : null;
  if (cls === "studio") {
    let csp = STUDIO_CSP;
    if (env && isDemoMode(env)) {
      csp = STUDIO_DEMO_CSP;
      const artifact = env.DEMO_ARTIFACT_ORIGIN?.trim();
      if (artifact && artifact !== DEMO_MEDIA_ORIGIN) csp = STUDIO_DEMO_CSP + " " + artifact;
    }
    return rebuild(res, pageHeaders(new Headers(res.headers), csp), res.body);
  }
  return rebuild(res, baselineHeaders(new Headers(res.headers)), res.body);
}
__name(applyResponseSecurity, "applyResponseSecurity");

// src/ai-binding.ts
async function aiRun(env, model, params, returnRaw = false) {
  const opts = { gateway: { id: await secretValue(env.GATEWAY_ID) } };
  if (returnRaw) opts.returnRawResponse = true;
  return env.AI.run(model, params, opts);
}
__name(aiRun, "aiRun");

// src/demo-render.ts
var DEFAULT_DEMO_RENDER_CAPS = {
  queueDepth: 10,
  // D3 ruling
  perIpDaily: 3,
  // D4 ruling
  globalDaily: 2e3,
  // D4 ruling
  staleMs: 10 * 6e4,
  // 10 min; a single LTX clip is ~1-3 min, so this only trips on a crash
  etaSeconds: 120
  // honest-enough single-clip estimate
};
function buildClipUrl(artifactOrigin, clipKey) {
  return artifactOrigin.replace(/\/+$/, "") + "/" + clipKey.replace(/^\/+/, "");
}
__name(buildClipUrl, "buildClipUrl");
function honestWaitSeconds(position, etaSeconds) {
  return Math.max(0, position) * etaSeconds;
}
__name(honestWaitSeconds, "honestWaitSeconds");
function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}
__name(utcDay, "utcDay");
async function getRenderable(db, id) {
  const row = await db.prepare("SELECT id, title, description, keyframe_key, keyframe_url, prompt, seconds, quality FROM demo_renderable WHERE id = ? AND enabled = 1").bind(id).first();
  return row ?? null;
}
__name(getRenderable, "getRenderable");
async function listRenderables(db) {
  const { results } = await db.prepare("SELECT id, title, description, seconds FROM demo_renderable WHERE enabled = 1 ORDER BY ordr, id").all();
  return results ?? [];
}
__name(listRenderables, "listRenderables");
async function countActive(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM demo_render_queue WHERE status IN ('queued','running')").first();
  return row?.n ?? 0;
}
__name(countActive, "countActive");
async function getJob(db, id) {
  const row = await db.prepare("SELECT * FROM demo_render_queue WHERE id = ?").bind(id).first();
  return row ?? null;
}
__name(getJob, "getJob");
async function enqueueJob(db, job) {
  await db.prepare("INSERT INTO demo_render_queue (id, renderable_id, ip, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)").bind(job.id, job.renderableId, job.ip, job.now, job.now).run();
}
__name(enqueueJob, "enqueueJob");
async function releaseStale(db, now, staleMs) {
  await db.prepare("UPDATE demo_render_queue SET status = 'failed', error = 'render backend went silent (box restarted); please try again', updated_at = ? WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?").bind(now, now - staleMs).run();
}
__name(releaseStale, "releaseStale");
async function claimHead(db, now) {
  const row = await db.prepare(
    "UPDATE demo_render_queue SET status = 'running', claimed_at = ?, updated_at = ? WHERE id = (SELECT id FROM demo_render_queue WHERE status = 'queued' ORDER BY created_at, id LIMIT 1) AND (SELECT COUNT(*) FROM demo_render_queue WHERE status = 'running') = 0 RETURNING *"
  ).bind(now, now).first();
  return row ?? null;
}
__name(claimHead, "claimHead");
async function setRunningToken(db, id, poll, now) {
  await db.prepare("UPDATE demo_render_queue SET poll_token = ?, updated_at = ? WHERE id = ?").bind(poll, now, id).run();
}
__name(setRunningToken, "setRunningToken");
async function markDone(db, id, clipUrl, now) {
  await db.prepare("UPDATE demo_render_queue SET status = 'done', clip_url = ?, updated_at = ? WHERE id = ?").bind(clipUrl, now, id).run();
}
__name(markDone, "markDone");
async function markFailed(db, id, error, now) {
  await db.prepare("UPDATE demo_render_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error.slice(0, 300), now, id).run();
}
__name(markFailed, "markFailed");
async function queuePosition(db, row) {
  if (row.status === "running") return 0;
  const ahead = await db.prepare("SELECT COUNT(*) AS n FROM demo_render_queue WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id < ?))").bind(row.created_at, row.created_at, row.id).first();
  const running = await db.prepare("SELECT COUNT(*) AS n FROM demo_render_queue WHERE status = 'running'").first();
  return (ahead?.n ?? 0) + (running?.n ?? 0);
}
__name(queuePosition, "queuePosition");
async function bumpCounter(db, bucket, day) {
  const row = await db.prepare("INSERT INTO demo_counter (bucket, count, day) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count").bind(bucket, day).first();
  return row?.count ?? 1;
}
__name(bumpCounter, "bumpCounter");
async function peekCounter(db, bucket) {
  const row = await db.prepare("SELECT count FROM demo_counter WHERE bucket = ?").bind(bucket).first();
  return row?.count ?? 0;
}
__name(peekCounter, "peekCounter");
async function pump(deps) {
  await releaseStale(deps.db, deps.now, deps.caps.staleMs);
  for (let i = 0; i <= deps.caps.queueDepth; i++) {
    const claimed = await claimHead(deps.db, deps.now);
    if (!claimed) return;
    const renderable = await getRenderable(deps.db, claimed.renderable_id);
    if (!renderable) {
      await markFailed(deps.db, claimed.id, "scene no longer available", deps.now);
      continue;
    }
    const sub = await deps.backend.submit(renderable, claimed.id);
    if (sub.ok) {
      await setRunningToken(deps.db, claimed.id, sub.poll, deps.now);
      return;
    }
    await markFailed(deps.db, claimed.id, "render backend rejected the job: " + sub.error, deps.now);
  }
}
__name(pump, "pump");
async function submitDemoRender(deps, input) {
  if (!await deps.backend.reachable()) {
    return { ok: false, reason: "paused", message: "renders are paused right now -- the demo GPU is offline. Browse the catalog, or run your own studio to render." };
  }
  const renderable = await getRenderable(deps.db, input.renderableId);
  if (!renderable) {
    return { ok: false, reason: "unknown-scene", message: "that scene is not on the demo menu" };
  }
  if (await countActive(deps.db) >= deps.caps.queueDepth) {
    return { ok: false, reason: "queue-full", message: "the render queue is full right now -- try again in a few minutes" };
  }
  const day = utcDay(deps.now);
  const ipCount = await bumpCounter(deps.db, `render:ip:${input.ip}:${day}`, day);
  if (ipCount > deps.caps.perIpDaily) {
    return { ok: false, reason: "ip-cap", message: `you have used your ${deps.caps.perIpDaily} demo renders for today -- resets at UTC midnight` };
  }
  const globalCount = await bumpCounter(deps.db, `render:global:${day}`, day);
  if (globalCount > deps.caps.globalDaily) {
    return { ok: false, reason: "global-cap", message: "the demo has hit its daily render budget -- browse the catalog, or run your own studio" };
  }
  await enqueueJob(deps.db, { id: input.jobId, renderableId: input.renderableId, ip: input.ip, now: deps.now });
  await pump(deps);
  const row = await getJob(deps.db, input.jobId);
  const status = row?.status ?? "queued";
  const position = row ? await queuePosition(deps.db, row) : 0;
  return { ok: true, jobId: input.jobId, status, position, waitSeconds: honestWaitSeconds(position, deps.caps.etaSeconds) };
}
__name(submitDemoRender, "submitDemoRender");
async function pollDemoRender(deps, jobId) {
  await pump(deps);
  let row = await getJob(deps.db, jobId);
  if (!row) return { status: "not_found" };
  if (row.status === "done") return { status: "done", clipUrl: row.clip_url ?? "" };
  if (row.status === "failed") return { status: "failed", error: row.error ?? "render failed" };
  if (row.status === "queued") {
    const position = await queuePosition(deps.db, row);
    return { status: "queued", position, waitSeconds: honestWaitSeconds(position, deps.caps.etaSeconds) };
  }
  if (!row.poll_token) return { status: "running" };
  const p = await deps.backend.poll(row.poll_token);
  if (p.ok && "pending" in p) return { status: "running" };
  if (p.ok) {
    const clipUrl = buildClipUrl(deps.artifactOrigin, p.clipKey);
    await markDone(deps.db, jobId, clipUrl, deps.now);
    await pump(deps);
    return { status: "done", clipUrl };
  }
  await markFailed(deps.db, jobId, "render failed on the GPU box: " + p.error, deps.now);
  await pump(deps);
  row = await getJob(deps.db, jobId);
  return { status: "failed", error: row?.error ?? "render failed" };
}
__name(pollDemoRender, "pollDemoRender");

// src/demo-chat.ts
var DEFAULT_DEMO_CHAT_CAPS = {
  perIpDaily: 20,
  // D4 ruling
  globalDaily: 2e3,
  // D4 ruling
  maxTokens: 400,
  maxInputChars: 1500
};
var DEMO_CHAT_SYSTEM_PROMPT = "You are the assistant on the PUBLIC DEMO of Vivijure, an open-source AI film studio. You run on a free open-weights model here, so you are not as sharp as the studio's real brain. Be brief and friendly. Help the visitor understand what Vivijure is and how to use the demo: they can browse the seeded catalog and cast, and render ONE short clip from the seeded scene menu on a real GPU. You CANNOT render for them, change anything, or access private data -- the demo is read-only apart from the menu render. If asked for anything outside helping with this demo (general coding, unrelated questions, acting as a free chatbot), briefly decline and steer back to the demo. Encourage anyone who wants the full experience to run their own Vivijure studio (it is open source).";
async function runDemoChat(deps, input) {
  const message = (input.message ?? "").trim();
  if (!message) return { ok: false, reason: "empty", message: "type a question about the demo" };
  if (message.length > deps.caps.maxInputChars) {
    return { ok: false, reason: "too-long", message: "that message is too long for the demo assistant" };
  }
  const day = utcDay(deps.now);
  if (await peekCounter(deps.db, `chat:global:${day}`) >= deps.caps.globalDaily) {
    return { ok: false, reason: "exhausted", message: "the free demo assistant is out of capacity for today -- browse keeps working, and you can run your own studio for the full brain." };
  }
  const ipCount = await bumpCounter(deps.db, `chat:ip:${input.ip}:${day}`, day);
  if (ipCount > deps.caps.perIpDaily) {
    return { ok: false, reason: "exhausted", message: "you have used your demo assistant messages for today -- browse the catalog, or run your own studio for the full brain. Resets at UTC midnight." };
  }
  const globalCount = await bumpCounter(deps.db, `chat:global:${day}`, day);
  if (globalCount > deps.caps.globalDaily) {
    return { ok: false, reason: "exhausted", message: "the free demo assistant is out of capacity for today -- browse keeps working, and you can run your own studio for the full brain." };
  }
  try {
    const reply = (await deps.model({ system: DEMO_CHAT_SYSTEM_PROMPT, user: message, maxTokens: deps.caps.maxTokens })).trim();
    if (!reply) return { ok: false, reason: "error", message: "the demo assistant had nothing to say -- try rephrasing" };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, reason: "error", message: "the demo assistant is unavailable right now -- browse keeps working" };
  }
}
__name(runDemoChat, "runDemoChat");

// src/rate-limit.ts
var SPEND_RETRY_AFTER_SECONDS = 60;
var SPEND_PATTERNS = [
  /^\/api\/storyboard\/render$/,
  /^\/api\/render\/clips$/,
  /^\/api\/render\/film$/,
  /^\/api\/storyboard\/render\/scatter$/,
  /^\/api\/storyboard\/render-from-keyframes$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-cloud$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-hybrid$/,
  /^\/api\/cast\/[^/]+\/train-lora$/,
  /^\/api\/cast\/[^/]+\/train-wan-lora$/,
  /^\/api\/cast\/[^/]+\/generate-refs$/,
  /^\/api\/storyboard\/score-bed$/,
  /^\/api\/storyboard\/music-generate$/
];
function isSpendRoute(method, pathname) {
  if (method !== "POST") return false;
  return SPEND_PATTERNS.some((re) => re.test(pathname));
}
__name(isSpendRoute, "isSpendRoute");
var warnedUnbound = false;
function dailyCeiling(env) {
  const raw = env.SPEND_DAILY_CEILING;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
__name(dailyCeiling, "dailyCeiling");
function failClosed(env) {
  return env.SPEND_LIMIT_FAIL_CLOSED !== "false";
}
__name(failClosed, "failClosed");
function utcDay2(nowMs) {
  const d = new Date(nowMs);
  const day = d.toISOString().slice(0, 10);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return { day, secondsToReset: Math.max(1, Math.ceil((midnight - nowMs) / 1e3)) };
}
__name(utcDay2, "utcDay");
async function bumpDailyCount(db, day) {
  const row = await db.prepare(
    "INSERT INTO spend_counter (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(day).first();
  if (!row || typeof row.count !== "number") throw new Error("spend_counter increment returned no row");
  return row.count;
}
__name(bumpDailyCount, "bumpDailyCount");
async function enforceSpendLimit(request, env, nowMs = Date.now()) {
  const closed = failClosed(env);
  const limiter = env.SPEND_RATE_LIMITER;
  if (!limiter) {
    if (!warnedUnbound) {
      warnedUnbound = true;
      console.warn(
        `rate-limit: SPEND_RATE_LIMITER unbound -> ${closed ? "DENYING spend endpoints (fail closed)" : "spend endpoints are NOT rate-limited (fail open)"}. Bind it in wrangler.toml.`
      );
    }
    if (closed) return { ok: false, status: 503, message: "spend limiter unavailable (fail-closed posture); renders are blocked until the limiter binding is fixed" };
  } else {
    const key = request.headers.get("cf-connecting-ip") || "global";
    try {
      const { success } = await limiter.limit({ key });
      if (!success) {
        return { ok: false, status: 429, retryAfter: SPEND_RETRY_AFTER_SECONDS, message: "rate limited: too many render/spend requests; slow down" };
      }
    } catch (e) {
      console.warn(`rate-limit: limiter errored (${e.message}) -> ${closed ? "denying (fail closed)" : "allowing (fail open)"}`);
      if (closed) return { ok: false, status: 503, message: "spend limiter unavailable (fail-closed posture); renders are blocked until the limiter recovers" };
    }
  }
  const ceiling = dailyCeiling(env);
  if (ceiling !== null) {
    const { day, secondsToReset } = utcDay2(nowMs);
    if (!env.DB) {
      console.warn(`rate-limit: SPEND_DAILY_CEILING set but DB unbound -> ${closed ? "denying (fail closed)" : "ceiling NOT enforced (fail open)"}`);
      if (closed) return { ok: false, status: 503, message: "daily spend ceiling cannot be checked (no database); renders are blocked (fail-closed posture)" };
    } else {
      try {
        const count = await bumpDailyCount(env.DB, day);
        if (count > ceiling) {
          return { ok: false, status: 429, retryAfter: secondsToReset, message: `daily spend ceiling reached (${ceiling} submissions today); resets at UTC midnight` };
        }
      } catch (e) {
        console.warn(`rate-limit: daily ceiling check errored (${e.message}) -> ${closed ? "denying (fail closed)" : "allowing (fail open)"}`);
        if (closed) return { ok: false, status: 503, message: "daily spend ceiling check failed (fail-closed posture); renders are blocked until the database recovers" };
      }
    }
  }
  return { ok: true };
}
__name(enforceSpendLimit, "enforceSpendLimit");

// src/chat-artifacts.ts
async function putChatArtifact(env, mime, bytes) {
  const key = `out/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2_RENDERS.put(key, bytes, {
    httpMetadata: { contentType: mime }
  });
  return { key, mime, type: "image" };
}
__name(putChatArtifact, "putChatArtifact");

// src/module-catalog.ts
function moduleLabel(mod) {
  const label = mod.provides?.[0]?.label;
  return typeof label === "string" && label.trim() || mod.name;
}
__name(moduleLabel, "moduleLabel");
function modelValues(mod) {
  const field = mod.config_schema?.model;
  return field?.type === "enum" ? field.values.map(String) : [];
}
__name(modelValues, "modelValues");
function catalogFromModules(modules, hook, type, groupPrefix) {
  const out = [];
  for (const mod of servingForHook(modules, hook)) {
    const group = `${groupPrefix} \xB7 ${mod.name}`;
    const values = modelValues(mod);
    if (values.length > 0) {
      for (const id of values) {
        out.push({ id, label: `${moduleLabel(mod)} \xB7 ${id}`, group, type, capabilities: [] });
      }
      continue;
    }
    out.push({ id: mod.name, label: moduleLabel(mod), group, type, capabilities: [] });
  }
  return out;
}
__name(catalogFromModules, "catalogFromModules");
function resolveCatalogTarget(modules, hook, modelId) {
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
    const mod = serving[0];
    const values = modelValues(mod);
    return { moduleName: mod.name, modelId: trimmed, configModel: values[0] ?? mod.name };
  }
  return null;
}
__name(resolveCatalogTarget, "resolveCatalogTarget");
function imageModelsFromModules(modules) {
  return catalogFromModules(modules, "image.generate", "image", "Image Gen");
}
__name(imageModelsFromModules, "imageModelsFromModules");

// src/chat-image-module.ts
function attachmentDataUrls(args) {
  const out = [];
  for (const att of args.attachments ?? []) {
    if (att.type !== "image" || !att.data) continue;
    if (att.data.startsWith("data:")) out.push(att.data);
    else if (att.mime) out.push(`data:${att.mime};base64,${att.data}`);
  }
  return out;
}
__name(attachmentDataUrls, "attachmentDataUrls");
async function chatImageViaModule(env, modules, args) {
  const target = resolveCatalogTarget(modules, "image.generate", args.model);
  if (!target) {
    return {
      ok: false,
      error: `no image.generate module serves model "${args.model}" (install an image module)`,
      model: args.model
    };
  }
  const mod = modules.find((m) => m.name === target.moduleName);
  if (!mod) return { ok: false, error: `image module ${target.moduleName} not found`, model: args.model };
  const fetcher = resolveFetcher(env, mod.binding);
  if (!fetcher) {
    return { ok: false, error: `image module ${mod.name} (${mod.binding}) is not bound`, model: args.model };
  }
  const start = Date.now();
  const r = await invokeModule(fetcher, {
    hook: "image.generate",
    input: {
      prompt: args.user_input,
      // The chat composer's "system prompt" is the negative prompt on the image path; that is what
      // it always meant here, and the module contract now names it honestly.
      negative_prompt: args.system_prompt,
      refs: attachmentDataUrls(args)
    },
    config: {
      ...validateConfig(mod.config_schema, {}),
      model: target.configModel ?? target.modelId
    },
    context: { project: "chat", job_id: crypto.randomUUID() }
  });
  if (!r.ok) {
    return {
      ok: false,
      error: ("error" in r ? r.error : void 0) || "image module returned no output",
      model: args.model
    };
  }
  if ("pending" in r) {
    return {
      ok: false,
      error: `image module ${mod.name} answered asynchronously (pending/poll), which the chat image path does not support`,
      model: args.model
    };
  }
  const image = r.output?.image;
  if (!image?.bytes_b64 || !image.mime) {
    return { ok: false, error: `image module ${mod.name} returned no image bytes`, model: args.model };
  }
  let bytes;
  try {
    bytes = base64ToBytes(image.bytes_b64);
  } catch {
    return { ok: false, error: `image module ${mod.name} returned undecodable base64`, model: args.model };
  }
  if (!bytes.length) {
    return { ok: false, error: `image module ${mod.name} returned zero bytes`, model: args.model };
  }
  const output_artifact = await putChatArtifact(env, image.mime, bytes);
  return {
    ok: true,
    model: args.model,
    output: "",
    output_artifact,
    latency_ms: Date.now() - start,
    ai_gateway_log_id: null,
    module: mod.name
  };
}
__name(chatImageViaModule, "chatImageViaModule");

// src/bundle-keyframes.ts
var KF_PATH = /^clips\/(.+)_keyframe\.png$/;
function bundleKeyframeShotIds(tarNames) {
  const out = [];
  for (const name of tarNames) {
    const m = name.match(KF_PATH);
    if (m) out.push(m[1]);
  }
  return out;
}
__name(bundleKeyframeShotIds, "bundleKeyframeShotIds");
async function stageBundleInjectedKeyframes(env, bundleKey, project) {
  const obj = await env.R2_RENDERS.get(bundleKey);
  if (!obj) return [];
  const compressed = await obj.arrayBuffer();
  const tarStream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tarBuf = new Uint8Array(await new Response(tarStream).arrayBuffer());
  const names = listTarNames(tarBuf);
  const shotIds = bundleKeyframeShotIds(names);
  const out = [];
  const safeProject = project.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "project";
  for (const shot_id of shotIds) {
    const tarPath = `clips/${shot_id}_keyframe.png`;
    const bytes = extractTarBytes(tarBuf, tarPath);
    if (!bytes) continue;
    const keyframe_key = `renders/${safeProject}/bundle-kf/${shot_id}.png`;
    await env.R2_RENDERS.put(keyframe_key, bytes, {
      httpMetadata: { contentType: "image/png" }
    });
    out.push({ shot_id, keyframe_key });
  }
  return out;
}
__name(stageBundleInjectedKeyframes, "stageBundleInjectedKeyframes");

// src/render-progress.ts
function renderSlug(name) {
  const collapsed = String(name).trim().split(/\s+/).filter(Boolean).join("_").replace(/\//g, "_");
  return collapsed || "untitled";
}
__name(renderSlug, "renderSlug");
function progressSnapshotKey(project, jobId) {
  return `renders/${renderSlug(project)}/progress/${renderSlug(jobId)}.json`;
}
__name(progressSnapshotKey, "progressSnapshotKey");
async function readKeyframeDone(env, project, jobId) {
  try {
    const obj = await env.R2_RENDERS.get(progressSnapshotKey(project, jobId));
    if (!obj) return void 0;
    const snap = JSON.parse(await obj.text());
    const n = snap?.counts?.keyframe_done;
    return typeof n === "number" && n >= 0 ? n : void 0;
  } catch {
    return void 0;
  }
}
__name(readKeyframeDone, "readKeyframeDone");

// src/planning-models.ts
function moduleLabel2(mod) {
  const label = mod.provides?.[0]?.label;
  return typeof label === "string" && label.trim() || mod.name;
}
__name(moduleLabel2, "moduleLabel");
function modelValues2(mod) {
  const field = mod.config_schema?.model;
  return field?.type === "enum" ? field.values.map(String) : [];
}
__name(modelValues2, "modelValues");
function planningModelsFromModules(modules) {
  const out = [];
  for (const mod of servingForHook(modules, "plan.enhance")) {
    const values = modelValues2(mod);
    if (values.length > 0) {
      for (const id of values) {
        out.push({
          id,
          label: `${moduleLabel2(mod)} \xB7 ${id}`,
          group: `Planning \xB7 ${mod.name}`,
          type: "chat",
          capabilities: []
        });
      }
      continue;
    }
    out.push({
      id: mod.name,
      label: moduleLabel2(mod),
      group: `Planning \xB7 ${mod.name}`,
      type: "chat",
      capabilities: []
    });
  }
  return out;
}
__name(planningModelsFromModules, "planningModelsFromModules");
function resolvePlanningTarget(modules, modelId) {
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const serving = servingForHook(modules, "plan.enhance");
  for (const mod of serving) {
    if (modelValues2(mod).includes(trimmed)) {
      return { moduleName: mod.name, modelId: trimmed, configModel: trimmed };
    }
  }
  const byName = serving.find((m) => m.name === trimmed);
  if (byName) return { moduleName: byName.name, modelId: trimmed };
  if (serving.length === 1) {
    const mod = serving[0];
    const values = modelValues2(mod);
    const fallback = values[0] ?? mod.name;
    return { moduleName: mod.name, modelId: trimmed, configModel: fallback };
  }
  return null;
}
__name(resolvePlanningTarget, "resolvePlanningTarget");

// src/planner.ts
async function invokePlanningModule(env, opts) {
  const modEnv = env;
  const modules = await discoverModules(modEnv, { cacheTtlMs: 6e4 });
  const target = resolvePlanningTarget(modules, opts.model);
  if (!target) {
    return {
      ok: false,
      error: `no plan.enhance module serves model "${opts.model}" (install a planning module)`
    };
  }
  const mod = modules.find((m) => m.name === target.moduleName);
  if (!mod) {
    return { ok: false, error: `plan.enhance module ${target.moduleName} not found` };
  }
  const fetcher = resolveFetcher(modEnv, mod.binding);
  if (!fetcher) {
    return {
      ok: false,
      error: `plan.enhance module ${mod.name} (${mod.binding}) is not bound`,
      module: mod.name
    };
  }
  const config = {
    ...validateConfig(mod.config_schema, { intensity: "medium" }),
    mode: opts.mode,
    model: target.configModel ?? target.modelId,
    system_message: opts.systemMessage,
    message: opts.userMessage
  };
  const input = {
    storyboard: opts.mode === "plan" ? { scenes: [] } : opts.storyboard ?? { scenes: [] },
    brief: opts.brief
  };
  const r = await invokeModule(fetcher, {
    hook: "plan.enhance",
    input,
    config,
    context: { project: "planner", job_id: crypto.randomUUID() }
  });
  if (!r.ok) {
    return {
      ok: false,
      error: ("error" in r ? r.error : void 0) || "plan.enhance module returned no output",
      module: mod.name
    };
  }
  if (!("output" in r) || !r.output) {
    return { ok: false, error: "plan.enhance module returned no output", module: mod.name };
  }
  const raw = opts.mode === "chat" ? r.output.notes?.join("\n") ?? "" : JSON.stringify(r.output.storyboard ?? {});
  return { ok: true, output: r.output, module: mod.name, raw };
}
__name(invokePlanningModule, "invokePlanningModule");
async function planStoryboard(env, args) {
  const systemMessage = buildPlanningSystemPrompt();
  const userMessage = buildPlanningUserMessage(args.brief, args.characters, args.beatBlock);
  const r = await invokePlanningModule(env, {
    mode: "plan",
    model: args.model,
    brief: args.brief,
    systemMessage,
    userMessage
  });
  if (!r.ok) {
    return {
      ok: false,
      errors: [r.error],
      raw: null,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module
    };
  }
  const validation = validateStoryboard(r.output.storyboard);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: r.raw,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module
    };
  }
  return {
    ok: true,
    storyboard: validation.value,
    raw: r.raw,
    provider: "module",
    model: args.model,
    logId: null,
    module: r.module
  };
}
__name(planStoryboard, "planStoryboard");
async function refineStoryboard(env, args) {
  const systemMessage = buildRefinementSystemPrompt();
  const userMessage = buildRefinementUserMessage(args.storyboard, args.message);
  const r = await invokePlanningModule(env, {
    mode: "refine",
    model: args.model,
    storyboard: args.storyboard,
    systemMessage,
    userMessage
  });
  if (!r.ok) {
    return {
      ok: false,
      errors: [r.error],
      raw: null,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module
    };
  }
  const validation = validateStoryboard(r.output.storyboard);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      raw: r.raw,
      provider: "module",
      model: args.model,
      logId: null,
      module: r.module
    };
  }
  return {
    ok: true,
    storyboard: validation.value,
    raw: r.raw,
    provider: "module",
    model: args.model,
    logId: null,
    module: r.module
  };
}
__name(refineStoryboard, "refineStoryboard");
async function chatComplete(env, args) {
  const systemMessage = args.system_prompt?.trim() || "You are a helpful assistant.";
  const r = await invokePlanningModule(env, {
    mode: "chat",
    model: args.model,
    systemMessage,
    userMessage: args.user_input
  });
  if (!r.ok) {
    return { ok: false, error: r.error, model: args.model };
  }
  const output = (r.output.notes ?? []).join("\n").trim();
  if (!output) {
    return { ok: false, error: "plan.enhance module returned empty chat output", model: args.model };
  }
  return { ok: true, output, model: args.model, logId: null, module: r.module };
}
__name(chatComplete, "chatComplete");

// src/markers.ts
function formatTimecode(seconds, fps) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  if (!Number.isFinite(fps) || fps <= 0) fps = 24;
  const totalFrames = Math.round(seconds * fps);
  const totalSecondsWhole = Math.floor(totalFrames / fps);
  const frames = totalFrames - totalSecondsWhole * fps;
  const h = Math.floor(totalSecondsWhole / 3600);
  const m = Math.floor((totalSecondsWhole - h * 3600) / 60);
  const s = totalSecondsWhole - h * 3600 - m * 60;
  const pad = /* @__PURE__ */ __name((n) => n.toString().padStart(2, "0"), "pad");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}
__name(formatTimecode, "formatTimecode");
function buildMarkers(storyboard, defaultFps = 24) {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const fallback = typeof storyboard.clip_seconds === "number" && storyboard.clip_seconds > 0 ? storyboard.clip_seconds : 5;
  let cursor = 0;
  void defaultFps;
  return scenes.map((scene, idx) => {
    const dur = typeof scene.target_seconds === "number" && scene.target_seconds > 0 ? scene.target_seconds : fallback;
    const inSec = cursor;
    const outSec = cursor + dur;
    cursor = outSec;
    const id = scene.id || `scene_${(idx + 1).toString().padStart(2, "0")}`;
    const actLabel = scene.act ? `[${scene.act}] ` : "";
    const prompt = (scene.prompt || "").replace(/\s+/g, " ").trim();
    const cast = Array.isArray(scene.character_slots) && scene.character_slots.length > 0 ? ` (cast: ${scene.character_slots.join(", ")})` : "";
    const description = `${actLabel}${prompt}${cast}`;
    return {
      index: idx + 1,
      inSeconds: inSec,
      outSeconds: outSec,
      durationSeconds: dur,
      name: id,
      description
    };
  });
}
__name(buildMarkers, "buildMarkers");
function emitPremiereCsv(storyboard, fps = 24) {
  const rows = buildMarkers(storyboard);
  const header = [
    "Marker Name",
    "Description",
    "In",
    "Out",
    "Duration",
    "Marker Type"
  ].join("	");
  const lines = rows.map(
    (r) => [
      r.name,
      sanitize(r.description),
      formatTimecode(r.inSeconds, fps),
      formatTimecode(r.outSeconds, fps),
      formatTimecode(r.durationSeconds, fps),
      "Comment"
    ].join("	")
  );
  return [header, ...lines].join("\n") + "\n";
}
__name(emitPremiereCsv, "emitPremiereCsv");
var RESOLVE_ACT_COLORS = {
  opening: "Blue",
  rising: "Green",
  turn: "Yellow",
  climax: "Red",
  resolution: "Cyan"
};
function emitResolveCsv(storyboard, fps = 24) {
  const rows = buildMarkers(storyboard);
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const header = ["#", "Color", "Name", "Time"].join(",");
  const lines = rows.map((r, idx) => {
    const sceneAct = (scenes[idx]?.act || "").toLowerCase();
    const color = RESOLVE_ACT_COLORS[sceneAct] || "Blue";
    return [
      r.index,
      color,
      csvQuote(`${r.name} - ${r.description}`),
      formatTimecode(r.inSeconds, fps)
    ].join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}
__name(emitResolveCsv, "emitResolveCsv");
function sanitize(s) {
  return s.replace(/[\t\r\n]+/g, " ").trim();
}
__name(sanitize, "sanitize");
function csvQuote(s) {
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
__name(csvQuote, "csvQuote");
function emitMarkers(storyboard, format, fps = 24) {
  const title = storyboard.title || "storyboard";
  const safeTitle = slugForFilename(title);
  switch (format) {
    case "premiere_csv":
      return {
        body: emitPremiereCsv(storyboard, fps),
        contentType: "text/csv; charset=utf-8",
        filename: `${safeTitle}-premiere-markers.csv`
      };
    case "resolve_csv":
      return {
        body: emitResolveCsv(storyboard, fps),
        contentType: "text/csv; charset=utf-8",
        filename: `${safeTitle}-resolve-markers.csv`
      };
  }
}
__name(emitMarkers, "emitMarkers");
function slugForFilename(name) {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]+/g, "").trim().replace(/[\s-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "storyboard";
}
__name(slugForFilename, "slugForFilename");

// src/wan-lora-projection.ts
var WAN_LORA_BACKEND = "alibaba-wan-lora";
var WAN_LORA_DEFAULT_SCALE = 1.5;
var WAN_LORA_PRESIGN_TTL_SECONDS = 6 * 60 * 60;
var MAX_LORAS_PER_PASS = 8;
function parseExistingLoras(value) {
  if (typeof value !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e) => !!e && typeof e === "object" && typeof e.path === "string"
  );
}
__name(parseExistingLoras, "parseExistingLoras");
function shouldProjectWanLoras(motionBackend, wanPretrained) {
  return (motionBackend ?? "").trim() === WAN_LORA_BACKEND && Object.keys(wanPretrained).length > 0;
}
__name(shouldProjectWanLoras, "shouldProjectWanLoras");
function ensureModuleOverrideConfig(overrides, moduleName) {
  const base = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  const cfgBag = base.config && typeof base.config === "object" && !Array.isArray(base.config) ? base.config : {};
  const existing = cfgBag[moduleName];
  const moduleCfg = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  cfgBag[moduleName] = moduleCfg;
  base.config = cfgBag;
  return { overrides: base, config: moduleCfg };
}
__name(ensureModuleOverrideConfig, "ensureModuleOverrideConfig");
async function projectWanLorasIntoModuleConfig(env, motionBackend, wanPretrained, motionConfig, scale = WAN_LORA_DEFAULT_SCALE) {
  if (!shouldProjectWanLoras(motionBackend, wanPretrained)) {
    return { injected: 0, dropped: 0, applied: false };
  }
  const high = parseExistingLoras(motionConfig.high_noise_loras);
  const low = parseExistingLoras(motionConfig.low_noise_loras);
  const preExisting = high.length;
  const slots = Object.keys(wanPretrained).sort();
  let injected = 0;
  let dropped = 0;
  for (const slot of slots) {
    if (high.length >= MAX_LORAS_PER_PASS || low.length >= MAX_LORAS_PER_PASS) {
      dropped += 1;
      continue;
    }
    const pair = wanPretrained[slot];
    const [highUrl, lowUrl] = await Promise.all([
      presignR2Get2(env, pair.high, WAN_LORA_PRESIGN_TTL_SECONDS),
      presignR2Get2(env, pair.low, WAN_LORA_PRESIGN_TTL_SECONDS)
    ]);
    high.push({ path: highUrl, scale });
    low.push({ path: lowUrl, scale });
    injected += 1;
  }
  if (dropped) {
    console.warn(
      "[wan-lora] bound cast has " + slots.length + " Wan adapter(s) but the pass caps at " + MAX_LORAS_PER_PASS + (preExisting ? " (" + preExisting + " already in config)" : "") + "; dropped " + dropped + "."
    );
  }
  if (injected > 0) {
    motionConfig.high_noise_loras = JSON.stringify(high);
    motionConfig.low_noise_loras = JSON.stringify(low);
  }
  return { injected, dropped, applied: injected > 0 };
}
__name(projectWanLorasIntoModuleConfig, "projectWanLorasIntoModuleConfig");

// src/user-prefs.ts
var DEFAULT_USER_PREFS = {
  emailNotifications: false
};
function normalizeUserPrefs(raw) {
  const out = { ...DEFAULT_USER_PREFS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw;
    if (typeof r.emailNotifications === "boolean") {
      out.emailNotifications = r.emailNotifications;
    }
  }
  return out;
}
__name(normalizeUserPrefs, "normalizeUserPrefs");
function mergeUserPrefs(current, patch) {
  const patchObj = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  return normalizeUserPrefs({ ...current, ...patchObj });
}
__name(mergeUserPrefs, "mergeUserPrefs");
async function getUserPrefs(env) {
  const row = await env.DB.prepare("SELECT prefs_json FROM user_prefs WHERE id = 1").first();
  if (!row) return { ...DEFAULT_USER_PREFS };
  let parsed = null;
  try {
    parsed = JSON.parse(row.prefs_json);
  } catch {
    parsed = null;
  }
  return normalizeUserPrefs(parsed);
}
__name(getUserPrefs, "getUserPrefs");
async function setUserPrefs(env, patch) {
  const current = await getUserPrefs(env);
  const next = mergeUserPrefs(current, patch);
  const now = Math.floor(Date.now() / 1e3);
  await env.DB.prepare(
    `INSERT INTO user_prefs (id, prefs_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(next), now).run();
  return next;
}
__name(setUserPrefs, "setUserPrefs");

// src/score-bed.ts
function musicScoreModules(modules) {
  return servingForHook(modules, "score").filter(
    (m) => m.config_schema != null && m.config_schema.prompt != null
  );
}
__name(musicScoreModules, "musicScoreModules");
function narrationScoreModules(modules) {
  return servingForHook(modules, "score").filter(
    (m) => m.config_schema != null && m.config_schema.text != null
  );
}
__name(narrationScoreModules, "narrationScoreModules");
function scoreModuleLabel(mod) {
  const label = mod.provides?.[0]?.label;
  return typeof label === "string" && label.trim() ? label.trim() : mod.name;
}
__name(scoreModuleLabel, "scoreModuleLabel");
function fetcherForModule2(env, mod) {
  return resolveFetcher(env, mod.binding);
}
__name(fetcherForModule2, "fetcherForModule");
function candidatesForKind(modules, kind) {
  return kind === "music" ? musicScoreModules(modules) : narrationScoreModules(modules);
}
__name(candidatesForKind, "candidatesForKind");
function resolveScoreModule(modules, kind, moduleName) {
  const candidates = candidatesForKind(modules, kind);
  if (candidates.length === 0) return null;
  if (moduleName) return candidates.find((m) => m.name === moduleName) ?? null;
  return candidates[0];
}
__name(resolveScoreModule, "resolveScoreModule");
function resolveScoreModuleByName(modules, moduleName) {
  return servingForHook(modules, "score").find((m) => m.name === moduleName) ?? null;
}
__name(resolveScoreModuleByName, "resolveScoreModuleByName");
function audioKeyFromApplied(applied) {
  for (const tag of applied) {
    if (!tag.startsWith("audio:")) continue;
    const key = tag.slice("audio:".length).trim();
    if (!key) continue;
    const ext = key.split(".").pop()?.toLowerCase();
    const mime = ext === "wav" ? "audio/wav" : "audio/mpeg";
    return { key, mime };
  }
  return null;
}
__name(audioKeyFromApplied, "audioKeyFromApplied");
async function startScoreBedGenerate(env, args) {
  const kind = args.kind === "narration" ? "narration" : "music";
  const modules = await discoverModules(env);
  const mod = resolveScoreModule(modules, kind, args.module?.trim() || void 0);
  if (!mod) {
    const wanted = args.module?.trim();
    const hint = kind === "music" ? "config_schema.prompt" : "config_schema.text";
    return {
      ok: false,
      error: wanted ? `score module "${wanted}" is not installed or is not a ${kind} module` : `no ${kind} score module installed (bind a score module with ${hint})`
    };
  }
  const fetcher = fetcherForModule2(env, mod);
  if (!fetcher) {
    return { ok: false, error: `score module "${mod.name}" binding ${mod.binding} is not reachable` };
  }
  const seconds = typeof args.seconds === "number" && args.seconds > 0 ? args.seconds : 60;
  let userConfig = { ...args.config ?? {} };
  if (kind === "music") {
    const prompt = (args.prompt ?? "").trim();
    if (!prompt) return { ok: false, error: "prompt required" };
    userConfig = { ...userConfig, prompt };
  } else {
    const text = (args.text ?? "").trim();
    if (!text && !args.storyboard) {
      return { ok: false, error: "text or storyboard required for narration" };
    }
    userConfig = { ...userConfig, text };
  }
  const config = validateConfig(mod.config_schema, userConfig);
  const r = await invokeModule(fetcher, {
    hook: "score",
    input: {
      film_key: "audio-bed/planner",
      seconds,
      storyboard: args.storyboard
    },
    config,
    context: { job_id: crypto.randomUUID(), project: "planner" }
  });
  if (!r.ok) return { ok: false, error: r.error || `${mod.name} invoke failed` };
  if (r.ok && r.pending === true && typeof r.poll === "string") {
    return {
      ok: true,
      status: "pending",
      id: r.poll,
      module: mod.name,
      label: scoreModuleLabel(mod)
    };
  }
  return { ok: false, error: `${mod.name} returned an unexpected synchronous response` };
}
__name(startScoreBedGenerate, "startScoreBedGenerate");
async function pollScoreBedGenerate(env, pollToken, moduleName) {
  const name = moduleName.trim();
  if (!name) return { status: "failed", job_error: "module name required" };
  const modules = await discoverModules(env);
  const mod = resolveScoreModuleByName(modules, name);
  if (!mod) return { status: "failed", job_error: `score module "${name}" not found` };
  const fetcher = fetcherForModule2(env, mod);
  if (!fetcher) {
    return { status: "failed", job_error: `score module "${name}" binding is not reachable` };
  }
  const token = pollToken.trim();
  if (!token) return { status: "failed", job_error: "poll token required" };
  const p = await pollModule(fetcher, { poll: token });
  if (!p.ok) return { status: "failed", job_error: p.error || "poll failed" };
  if (p.ok && p.pending === true) return { status: "pending" };
  const output = p.output;
  const violation = hookOutputViolation(name, "score", output);
  if (violation) return { status: "failed", job_error: violation };
  const artifact = audioKeyFromApplied(output.applied ?? []);
  if (!artifact) {
    return { status: "failed", job_error: `${name} finished but returned no audio artifact` };
  }
  return { status: "done", output_artifact: artifact };
}
__name(pollScoreBedGenerate, "pollScoreBedGenerate");

// src/index.ts
var json5 = /* @__PURE__ */ __name((body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }), "json");
var HttpError2 = class extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
  status;
  static {
    __name(this, "HttpError");
  }
};
var badRequest = /* @__PURE__ */ __name((m) => new HttpError2(400, m), "badRequest");
var notFound = /* @__PURE__ */ __name((m = "not found") => new HttpError2(404, m), "notFound");
async function resolveCastId(env, raw) {
  const id = isPublicId(raw) ? await getCastIdByPublicId(env, raw) : null;
  if (id === null) throw notFound("cast member");
  return id;
}
__name(resolveCastId, "resolveCastId");
async function resolveProjectId(env, raw) {
  const id = isPublicId(raw) ? await getProjectIdByPublicId(env, raw) : null;
  if (id === null) throw notFound("project");
  return id;
}
__name(resolveProjectId, "resolveProjectId");
async function resolveRenderId(env, raw) {
  const id = isPublicId(raw) ? await getRenderIdByPublicId(env, raw) : null;
  if (id === null) throw notFound("render");
  return id;
}
__name(resolveRenderId, "resolveRenderId");
async function resolveProjectRef(env, raw) {
  return isPublicId(raw) ? await getProjectIdByPublicId(env, raw) : null;
}
__name(resolveProjectRef, "resolveProjectRef");
async function readBody(req) {
  try {
    return await req.json();
  } catch {
    throw badRequest("invalid JSON body");
  }
}
__name(readBody, "readBody");
function match(routes, method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.pattern.split("/"), sp = pathname.split("/");
    const star = pp.findIndex((seg) => seg[0] === "*");
    if (star === -1 ? pp.length !== sp.length : sp.length < pp.length) continue;
    const p = {};
    let ok2 = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i][0] === "*") {
        p[pp[i].slice(1)] = sp.slice(i).map(decodeURIComponent).join("/");
        break;
      } else if (pp[i][0] === ":") p[pp[i].slice(1)] = decodeURIComponent(sp[i]);
      else if (pp[i] !== sp[i]) {
        ok2 = false;
        break;
      }
    }
    if (ok2) return { handler: r.handler, params: p };
  }
  return null;
}
__name(match, "match");
var hListProjects = /* @__PURE__ */ __name(async (req, env) => json5({ projects: (await listProjects(env)).map(toPublicProject) }), "hListProjects");
var hCreateProject = /* @__PURE__ */ __name(async (req, env) => {
  const b = await readBody(req);
  if (!b.name) throw badRequest("name required");
  return json5({ project: toPublicProject(await createProject(env, { name: b.name, prefs: b.prefs })) }, 201);
}, "hCreateProject");
var hGetProject = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const row = await getProjectById(env, await resolveProjectId(env, p.id));
  if (!row) throw notFound("project");
  return json5({ project: toPublicProject(row) });
}, "hGetProject");
var hPatchProject = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const id = await resolveProjectId(env, p.id);
  const b = await readBody(req);
  const row = b.storyboard !== void 0 ? await setLastStoryboard(env, id, b.storyboard) : await updateProjectMeta(env, id, { name: b.name, prefs: b.prefs });
  if (!row) throw notFound("project");
  return json5({ project: toPublicProject(row) });
}, "hPatchProject");
var hDeleteProject = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const row = await deleteProject(env, await resolveProjectId(env, p.id));
  if (!row) throw notFound("project");
  return json5({ ok: true, deleted: row.public_id });
}, "hDeleteProject");
var hSaveProjectStoryboard = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req);
  if (b.storyboard === void 0) throw badRequest("storyboard required");
  const row = await setLastStoryboard(env, await resolveProjectId(env, p.id), b.storyboard);
  if (!row) throw notFound("project");
  return json5({ project: toPublicProject(row) });
}, "hSaveProjectStoryboard");
var hListCast = /* @__PURE__ */ __name(async (_req, env) => json5({ cast: (await listCast(env)).map(toPublicCast) }), "hListCast");
var hListVoices = /* @__PURE__ */ __name(async (_req, env) => json5({ voices: catalogForDeploy(env, VOICE_CATALOG) }), "hListVoices");
var hCreateCast = /* @__PURE__ */ __name(async (req, env) => {
  const b = await readBody(req);
  if (!b.name) throw badRequest("name required");
  return json5({ cast: toPublicCast(await createCast(env, { name: b.name, bible: b.bible })) }, 201);
}, "hCreateCast");
var hGetCast = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const row = await getCastById(env, await resolveCastId(env, p.id));
  if (!row) throw notFound("cast member");
  return json5({ cast: toPublicCast(row) });
}, "hGetCast");
var hPatchCast = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req);
  const patch = {
    name: b.name,
    bible: b.bible
  };
  if (b.voice_id !== void 0) {
    if (b.voice_id === null || b.voice_id === "") patch.voice_id = null;
    else if (isValidVoiceId(b.voice_id)) patch.voice_id = b.voice_id;
    else throw badRequest(`voice_id must be one of: ${VOICE_IDS.join(", ")}`);
  }
  const row = await updateCast(env, await resolveCastId(env, p.id), patch);
  if (!row) throw notFound("cast member");
  return json5({ cast: toPublicCast(row) });
}, "hPatchCast");
var hDeleteCast = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const row = await deleteCast(env, await resolveCastId(env, p.id));
  if (!row) throw notFound("cast member");
  await deleteCastArtifacts(env, row);
  return json5({ ok: true, deleted: row.public_id });
}, "hDeleteCast");
var hSetPortrait = /* @__PURE__ */ __name(async (req, env, _c, p) => handleCastPortraitUpload(req, env, await resolveCastId(env, p.id)), "hSetPortrait");
var hClearPortrait = /* @__PURE__ */ __name(async (_req, env, _c, p) => {
  const id = await resolveCastId(env, p.id);
  const cur = await getCastById(env, id);
  if (!cur) throw notFound("cast member");
  if (cur.portrait_key) {
    try {
      await env.R2_RENDERS.delete(cur.portrait_key);
    } catch {
    }
  }
  const row = await clearPortrait(env, id);
  return json5({ cast: row ? toPublicCast(row) : null });
}, "hClearPortrait");
var hAddRef = /* @__PURE__ */ __name(async (req, env, _c, p) => handleCastRefAdd(req, env, await resolveCastId(env, p.id)), "hAddRef");
var hRemoveRef = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req).catch(() => ({}));
  const key = b.key || p.refKey;
  if (!key) throw badRequest("key required");
  return handleCastRefRemove(env, await resolveCastId(env, p.id), key);
}, "hRemoveRef");
var hAddSource = /* @__PURE__ */ __name(async (req, env, _c, p) => handleCastSourceAdd(req, env, await resolveCastId(env, p.id)), "hAddSource");
var hRemoveSource = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req).catch(() => ({}));
  const key = b.key || p.sourceKey;
  if (!key) throw badRequest("key required");
  return handleCastSourceRemove(env, await resolveCastId(env, p.id), key);
}, "hRemoveSource");
var hGenerateCastRefs = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const id = await resolveCastId(env, p.id);
  const b = await readBody(req);
  const job = await startCastRefsJob(env, {
    castId: id,
    config: b.config,
    artStyle: b.art_style,
    sourceKeys: b.source_keys,
    choice: b.choice
  });
  if (!job) throw notFound("cast member");
  return json5({ ok: true, ...summarizeCastRefs(job) }, 201);
}, "hGenerateCastRefs");
var hPollCastRefs = /* @__PURE__ */ __name(async (_req, env, _c, p) => {
  const id = await resolveCastId(env, p.id);
  const job = await advanceCastRefsJob(env, id, p.jobId);
  if (!job) throw notFound("cast refs job");
  return json5({ ok: true, ...summarizeCastRefs(job) });
}, "hPollCastRefs");
var hExportCast = /* @__PURE__ */ __name(async (_req, env, _c, p) => exportCastBundle(env, await resolveCastId(env, p.id)), "hExportCast");
var hImportCast = /* @__PURE__ */ __name(async (req, env) => {
  const buf = new Uint8Array(await req.arrayBuffer());
  return importCastBundle(env, buf);
}, "hImportCast");
var UPLOAD_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
var MAX_AUDIO_UPLOAD_BYTES = 32 * 1024 * 1024;
var AUDIO_UPLOAD_EXT = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "webm"
};
var hStoryboardAudioUpload = /* @__PURE__ */ __name(async (req, env) => {
  const mime = (req.headers.get("content-type") || "").split(";")[0].trim() || "audio/mpeg";
  const ext = AUDIO_UPLOAD_EXT[mime];
  if (!ext) throw badRequest(`unsupported audio content-type ${mime || "<missing>"}`);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw badRequest("empty upload body");
  if (bytes.byteLength > MAX_AUDIO_UPLOAD_BYTES) throw badRequest("upload too large (max 32MB)");
  const key = `audio/${crypto.randomUUID()}.${ext}`;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return json5({ key, mime, size: bytes.byteLength }, 201);
}, "hStoryboardAudioUpload");
var hStoryboardCharacterRef = /* @__PURE__ */ __name(async (req, env) => {
  const mime = (req.headers.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
  const ext = UPLOAD_EXT[mime];
  if (!ext) throw badRequest(`unsupported content-type ${mime || "<missing>"} (png/jpeg/webp/gif only)`);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw badRequest("empty upload body");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("upload too large (max 25MB)");
  const key = `character-refs/${crypto.randomUUID()}.${ext}`;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return json5({ key, mime, size: bytes.byteLength }, 201);
}, "hStoryboardCharacterRef");
var hUpload = /* @__PURE__ */ __name(async (req, env) => {
  const mime = (req.headers.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
  const ext = UPLOAD_EXT[mime];
  if (!ext) throw badRequest(`unsupported content-type ${mime || "<missing>"} (png/jpeg/webp/gif only)`);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw badRequest("empty upload body");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("upload too large (max 25MB)");
  const key = `uploads/${crypto.randomUUID()}.${ext}`;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  return json5({ key, mime, size: bytes.byteLength }, 201);
}, "hUpload");
var ARTIFACT_PREFIXES = [
  "audio/",
  "bundles/",
  "cast/",
  "cast-clean/",
  "cast-gen/",
  "character-refs/",
  "characters/",
  "clips/",
  "loras/",
  "out/",
  "renders/",
  "uploads/"
];
var ARTIFACT_SAFE_CT_RE = /^(image\/(png|jpe?g|webp|gif)|video\/(mp4|webm|quicktime)|audio\/[\w.+-]+|application\/(octet-stream|json|x-tar|zip|safetensors))$/i;
function safeArtifactContentType(contentType) {
  const t = (contentType || "").split(";")[0].trim();
  if (ARTIFACT_SAFE_CT_RE.test(t)) return t === "image/jpg" ? "image/jpeg" : t;
  return "application/octet-stream";
}
__name(safeArtifactContentType, "safeArtifactContentType");
function artifactHeaders(contentType, key) {
  const h = new Headers();
  h.set("content-type", safeArtifactContentType(contentType));
  h.set("cache-control", "private, max-age=300");
  h.set("accept-ranges", "bytes");
  h.set("x-content-type-options", "nosniff");
  const base = (key || "artifact").split("/").pop() || "artifact";
  const safeName = base.replace(/[^\w.\-]+/g, "_").slice(0, 180) || "artifact";
  h.set("content-disposition", `attachment; filename="${safeName}"`);
  return h;
}
__name(artifactHeaders, "artifactHeaders");
var hServeArtifact = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  if (!env.R2_RENDERS) throw notFound("the artifact store is not available on this deployment");
  const key = p.key;
  if (!key || !isSafeRelKey(key) || !ARTIFACT_PREFIXES.some((pre) => key.startsWith(pre))) {
    throw notFound("artifact");
  }
  const isHead = req.method === "HEAD";
  const rangeHeader = req.headers.get("range");
  if (isHead || rangeHeader) {
    const meta = await env.R2_RENDERS.head(key);
    if (!meta) throw notFound("artifact");
    const ct = meta.httpMetadata?.contentType || "application/octet-stream";
    const parsed = parseByteRange(rangeHeader, meta.size);
    if (parsed === "unsatisfiable") {
      const h3 = artifactHeaders(ct, key);
      h3.set("content-range", `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers: h3 });
    }
    if (parsed) {
      const h3 = artifactHeaders(ct, key);
      h3.set("content-range", `bytes ${parsed.start}-${parsed.end}/${meta.size}`);
      h3.set("content-length", String(parsed.length));
      if (isHead) return new Response(null, { status: 206, headers: h3 });
      const obj3 = await env.R2_RENDERS.get(key, { range: { offset: parsed.offset, length: parsed.length } });
      if (!obj3) throw notFound("artifact");
      return new Response(obj3.body, { status: 206, headers: h3 });
    }
    const h2 = artifactHeaders(ct, key);
    h2.set("content-length", String(meta.size));
    if (isHead) return new Response(null, { status: 200, headers: h2 });
    const obj2 = await env.R2_RENDERS.get(key);
    if (!obj2) throw notFound("artifact");
    return new Response(obj2.body, { status: 200, headers: h2 });
  }
  const obj = await env.R2_RENDERS.get(key);
  if (!obj) throw notFound("artifact");
  const h = artifactHeaders(obj.httpMetadata?.contentType || "application/octet-stream", key);
  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h });
}, "hServeArtifact");
var hListRenders = /* @__PURE__ */ __name(async (req, env) => {
  const url = new URL(req.url);
  const projectId = await resolveProjectRef(env, url.searchParams.get("project_id"));
  const limitParam = url.searchParams.get("limit");
  const limitNum = limitParam === null || limitParam.trim() === "" ? DEFAULT_RENDERS_LIMIT : Number(limitParam);
  const limit = Number.isFinite(limitNum) ? limitNum : DEFAULT_RENDERS_LIMIT;
  const renders = await listRendersForUser(env, limit, projectId);
  return json5({ renders: renders.map(toPublicRenderRow) });
}, "hListRenders");
var hListTags = /* @__PURE__ */ __name(async (_req, env) => json5({ tags: await listUserTags(env) }), "hListTags");
var hPatchRender = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const id = await resolveRenderId(env, p.id);
  const b = await readBody(req);
  let ok2 = false;
  if ("label" in b) ok2 = await setRenderLabel(env, id, b.label ?? null) || ok2;
  if ("lockedShots" in b) ok2 = await setRenderLockedShots(env, id, normalizeLockedShots(b.lockedShots)) || ok2;
  if ("folderPath" in b) ok2 = await setRenderFolder(env, id, normalizeFolderPath(b.folderPath)) || ok2;
  if ("tags" in b) ok2 = await setRenderTags(env, id, normalizeTags(b.tags)) || ok2;
  if (!ok2) throw notFound("render");
  const updated = await getRenderByIdForUser(env, id);
  return json5(updated ? toPublicRenderRow(updated) : null);
}, "hPatchRender");
var hDeleteRender = /* @__PURE__ */ __name(async (_req, env, _c, p) => {
  if (!await deleteRenderRow(env, await resolveRenderId(env, p.id))) throw notFound("render");
  return json5({ ok: true });
}, "hDeleteRender");
var hAddRenderAudio = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req);
  if (!b.audioKey?.trim()) throw badRequest("audioKey required");
  const r = await muxAudioOntoRender(env, await resolveRenderId(env, p.id), b.audioKey.trim());
  if (!r.ok) return json5({ error: r.error }, 422);
  return json5({ ok: true, output_key: r.output_key });
}, "hAddRenderAudio");
var hAddRenderNarration = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req);
  if (!b.text?.trim()) throw badRequest("text required");
  const started = await startScoreBedGenerate(env, {
    kind: "narration",
    text: b.text,
    module: b.module,
    config: b.config
  });
  if (!started.ok) return json5({ error: started.error }, 422);
  for (let i = 0; i < 40; i++) {
    const polled = await pollScoreBedGenerate(env, started.id, started.module);
    if (polled.status === "done" && polled.output_artifact?.key) {
      const muxed = await muxAudioOntoRender(env, await resolveRenderId(env, p.id), polled.output_artifact.key);
      if (!muxed.ok) return json5({ error: muxed.error }, 422);
      return json5({ ok: true, output_key: muxed.output_key, module: started.module, label: started.label });
    }
    if (polled.status === "failed") return json5({ error: polled.job_error || "narration failed" }, 422);
    await new Promise((res) => setTimeout(res, 3e3));
  }
  return json5({ error: "narration timed out; try again later" }, 504);
}, "hAddRenderNarration");
async function animatePreviewHandler(env, renderId, args) {
  const parent = await getRenderByIdForUser(env, renderId);
  if (!parent) throw notFound("render");
  const r = await animateFromPreview(env, { parent, ...args });
  if (!r.ok) return json5({ ok: false, error: r.error }, r.status ?? 400);
  return json5({ ok: true, ...r.view }, 201);
}
__name(animatePreviewHandler, "animatePreviewHandler");
var hFinalizePreview = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  let audioKey;
  try {
    const b = await readBody(req);
    audioKey = b.audioKey;
  } catch {
  }
  return animatePreviewHandler(env, await resolveRenderId(env, p.id), {
    deriveMode: "finalized",
    audioKey
  });
}, "hFinalizePreview");
var hAnimateCloud = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req);
  return animatePreviewHandler(env, await resolveRenderId(env, p.id), {
    deriveMode: "cloud-finalized",
    motionBackend: b.model,
    perShotModels: b.perShot,
    audioKey: b.audioKey
  });
}, "hAnimateCloud");
var hAnimateHybrid = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const b = await readBody(req);
  const modules = await discoverModules(env);
  const allowed = new Set(cloudMotionModules(modules).map((m) => m.name));
  const normalized = normalizeHybridBackends(b.backends, allowed);
  if (normalized.errors.length) throw badRequest(normalized.errors.join("; "));
  return animatePreviewHandler(env, await resolveRenderId(env, p.id), {
    deriveMode: "cloud-finalized",
    hybridBackends: normalized.backends,
    defaultBackend: b.defaultBackend === "cloud" ? "cloud" : "gpu",
    defaultCloudModel: b.defaultCloudModel,
    audioKey: b.audioKey
  });
}, "hAnimateHybrid");
function assertConfigMapShape(label, value) {
  if (value === void 0) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const actual = describeJsonType(value);
    throw badRequest(label + " must be a JSON object (a { key: value } map), not " + (/^[aeiou]/.test(actual) ? "an " : "a ") + actual);
  }
}
__name(assertConfigMapShape, "assertConfigMapShape");
function describeJsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
__name(describeJsonType, "describeJsonType");
function assertModuleConfigMap(label, value) {
  assertConfigMapShape(label, value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, cfg] of Object.entries(value)) {
      assertConfigMapShape(`${label}.${name}`, cfg);
    }
  }
}
__name(assertModuleConfigMap, "assertModuleConfigMap");
var hSubmitRender = /* @__PURE__ */ __name(async (req, env) => {
  const b = await readBody(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  if (!isSafeBundleKey(b.bundleKey)) throw badRequest("bundleKey must be a plain relative key under bundles/");
  assertConfigMapShape("renderOverrides", b.renderOverrides);
  assertModuleConfigMap("renderOverrides.config", b.renderOverrides?.config);
  const tier = coerceQualityTier(b.qualityTier) ?? "final";
  const project = b.project ?? deriveProjectFromBundleKey(b.bundleKey);
  const modules = await discoverModules(env);
  if (servingForHook(modules, "keyframe").length === 0) {
    return json5({ error: "no keyframe module installed (bind MODULE_KEYFRAME)" }, 503);
  }
  const scenes = filterScenesByShotIds(normalizeFilmScenes(b.scenes), b.processShotIds);
  if (!scenes.length) throw badRequest("scenes[] required (storyboard shots with prompt and duration)");
  if (!b.keyframesOnly) {
    const parsedOverrides = parseModuleRenderOverrides(b.renderOverrides);
    const explicitMotionBackend = b.motion_backend ?? parsedOverrides.motion_backend;
    const motionErr = motionBackendPreflightError(modules, explicitMotionBackend);
    if (motionErr) throw badRequest(motionErr);
    const cfgErr = motionConfigPreflightError(modules, explicitMotionBackend, parsedOverrides.config?.[(explicitMotionBackend ?? "").trim()]);
    if (cfgErr) throw badRequest(cfgErr);
  }
  const { pretrained, wanPretrained, castIds, skipped, skippedDetail } = await resolveCastLoras(env, b.castLoras);
  if (skipped.length) throw badRequest(untrainedCastMessage(skippedDetail));
  const mapped = mapRenderOverridesToModuleConfigs(b.renderOverrides, tier, modules);
  const motionBackend = b.keyframesOnly ? void 0 : b.motion_backend ?? mapped.motion_backend;
  if (!b.keyframesOnly) {
    const kfErr = localGpuKeyframePreflightError(modules, motionBackend, mapped.keyframe_backend);
    if (kfErr) throw badRequest(kfErr);
  }
  await projectWanLorasIntoModuleConfig(env, motionBackend, wanPretrained, mapped.motion_config);
  const job = await startFilmJob(env, {
    project,
    bundle_key: b.bundleKey,
    scenes,
    motion_backend: motionBackend,
    keyframe_backend: mapped.keyframe_backend,
    keyframe_config: mapped.keyframe_config,
    motion_config: mapped.motion_config,
    finish_config: mapped.finish_config,
    speech_config: mapped.speech_config,
    film_finish_config: mapped.film_finish_config,
    master_config: mapped.master_config,
    keyframes_only: !!b.keyframesOnly,
    audio_key: b.keyframesOnly ? void 0 : b.audioKey,
    // Opening title + end-credit card TEXT (FilmTitleSpec / FilmCreditSpec); the film.finish chain
    // reads it off the job. Mirrors hStartFilm. Skipped on a keyframes-only preview (no assembled
    // film to card), exactly like audio_key above.
    film_titles: b.keyframesOnly ? void 0 : b.film_titles,
    pretrained_loras: Object.keys(pretrained).length ? pretrained : void 0,
    cast_loras: Object.keys(castIds).length ? castIds : void 0
  }, modules);
  const view = filmJobToPollView(job, null);
  const row = {
    jobId: view.jobId,
    project,
    bundleKey: b.bundleKey,
    qualityTier: tier,
    renderOverrides: b.renderOverrides,
    status: view.status,
    mode: b.keyframesOnly ? "keyframes-only" : "full",
    projectId: await resolveProjectRef(env, b.projectId)
  };
  await insertRenderBestEffort(env, row);
  return json5(view, 201);
}, "hSubmitRender");
var hRenderFromKeyframes = /* @__PURE__ */ __name(async (req, env) => {
  const b = await readBody(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  if (!isSafeBundleKey(b.bundleKey)) throw badRequest("bundleKey must be a plain relative key under bundles/");
  const project = b.project ?? deriveProjectFromBundleKey(b.bundleKey);
  const tier = coerceQualityTier(b.qualityTier) ?? "final";
  const modules = await discoverModules(env);
  if (servingForHook(modules, "motion.backend").length === 0) {
    return json5({ error: "no motion.backend module installed" }, 503);
  }
  const parsedScenes = await readBundleScenes(env, b.bundleKey);
  if (!parsedScenes.length) {
    return json5({ error: "bundle has no storyboard scenes" }, 400);
  }
  const scenes = parsedScenes.map((s) => ({
    shot_id: s.shot_id,
    prompt: s.prompt,
    seconds: s.seconds
  }));
  const staged = await stageBundleInjectedKeyframes(env, b.bundleKey, project);
  if (!staged.length) {
    return json5({ error: "bundle has no injected keyframes (clips/<id>_keyframe.png)" }, 400);
  }
  const mapped = mapRenderOverridesToModuleConfigs(b.renderOverrides, tier, modules);
  const motionBackend = b.motion_backend ?? mapped.motion_backend ?? defaultGpuDoorModule(modules)?.name;
  if (!motionBackend) {
    return json5({ error: 'no gpu-door motion.backend module (ui.locality "byo"/"local") is installed' }, 400);
  }
  const job = await startFilmFromKeyframes(env, {
    project,
    bundle_key: b.bundleKey,
    scenes,
    keyframes: staged,
    motion_backend: motionBackend,
    motion_config: mapped.motion_config,
    finish_config: mapped.finish_config,
    speech_config: mapped.speech_config,
    film_finish_config: mapped.film_finish_config,
    master_config: mapped.master_config,
    derive_mode: "finalized",
    audio_key: b.audioKey
  }, modules);
  if (job.phase === "failed") {
    return json5({ error: job.error || "render from keyframes failed" }, 422);
  }
  const view = filmJobToPollView(job, null);
  await insertRenderBestEffort(env, {
    jobId: view.jobId,
    project,
    bundleKey: b.bundleKey,
    qualityTier: tier,
    renderOverrides: b.renderOverrides,
    status: view.status,
    mode: "finalized",
    projectId: await resolveProjectRef(env, b.projectId)
  });
  return json5(view, 201);
}, "hRenderFromKeyframes");
var hRegenShot = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const renderId = await resolveRenderId(env, p.id);
  const b = await readBody(req);
  const shotId = typeof b.shotId === "string" ? b.shotId.trim() : "";
  if (!shotId) throw badRequest("shotId required");
  const row = await getRenderByIdForUser(env, renderId);
  if (!row) throw notFound("render");
  if (row.status !== "COMPLETED") throw badRequest("render must be COMPLETED");
  if (!row.bundle_key) throw badRequest("render has no bundle_key");
  if (!isSafeBundleKey(row.bundle_key)) throw badRequest("render bundle_key is not a usable bundles/ key");
  const scenes = await readBundleScenes(env, row.bundle_key);
  const scene = scenes.find((s) => s.shot_id === shotId);
  if (!scene) throw badRequest(`shot ${shotId} not in bundle storyboard`);
  const modules = await discoverModules(env);
  if (servingForHook(modules, "keyframe").length === 0) {
    return json5({ ok: false, error: "no keyframe module installed (bind MODULE_KEYFRAME)" }, 503);
  }
  const tier = coerceQualityTier(row.quality_tier) ?? "final";
  const mapped = mapRenderOverridesToModuleConfigs(row.render_overrides, tier, modules);
  const job = await startFilmJob(env, {
    project: row.project,
    bundle_key: row.bundle_key,
    scenes: [{ shot_id: scene.shot_id, prompt: scene.prompt, seconds: scene.seconds }],
    keyframe_backend: mapped.keyframe_backend,
    keyframe_config: mapped.keyframe_config,
    keyframes_only: true
  }, modules);
  if (job.phase === "failed") {
    return json5({ ok: false, error: job.error || "regen submit failed" }, 422);
  }
  const view = filmJobToPollView(job, null);
  return json5({ ok: true, jobId: view.jobId, status: view.status });
}, "hRegenShot");
var hPollRender = /* @__PURE__ */ __name(async (_req, env, ctx, p) => {
  if (isScatterParentJobId(p.jobId)) {
    const view2 = await advanceScatterJob(env, p.jobId, ctx);
    if (!view2) throw notFound("render job");
    return json5(view2);
  }
  if (!isFilmJobId(p.jobId)) {
    return json5({ error: "unknown or legacy render job id (film-* or scatter-* only)", jobId: p.jobId }, 404);
  }
  const r = await advanceFilmJob(env, p.jobId);
  if (!r) throw notFound("render job");
  const kfDone = r.job.phase === "keyframe" && r.job.keyframe_job_id ? await readKeyframeDone(env, r.job.project, r.job.keyframe_job_id) : void 0;
  const view = filmJobToPollView(r.job, r.clipJob, kfDone);
  await updateRenderFromView(env, view, ctx);
  if (r.job.derive_mode === "cloud-finalized" && r.clipJob && r.job.phase !== "done" && r.job.phase !== "failed" && !r.job.cancelled) {
    const modules = await discoverModules(env);
    const gpuDoors = new Set(gpuDoorMotionModules(modules).map((m) => m.name));
    const prog = clipAnimateProgress(r.clipJob, gpuDoors);
    if (prog.gpu.total > 0 && prog.cloud.total > 0) {
      await setHybridProgress(env, p.jobId, { gpu: prog.gpu, cloud: prog.cloud });
    } else if (prog.cloud.total > 0) {
      await setCloudAnimateProgress(env, p.jobId, prog.done, prog.total);
    }
  }
  return json5(view);
}, "hPollRender");
var hCancelRender = /* @__PURE__ */ __name(async (_req, env, _c, p) => {
  if (isScatterParentJobId(p.jobId)) {
    const view2 = await cancelScatterJob(env, p.jobId);
    if (!view2) throw notFound("render job");
    await updateRenderFromView(env, view2);
    return json5(view2);
  }
  if (!isFilmJobId(p.jobId)) {
    return json5({ error: "unknown or legacy render job id (film-* or scatter-* only)", jobId: p.jobId }, 404);
  }
  const job = await cancelFilmJob(env, p.jobId);
  if (!job) throw notFound("render job");
  const view = filmJobToPollView(job, null);
  await updateRenderFromView(env, view);
  return json5(view);
}, "hCancelRender");
var hScatterRender = /* @__PURE__ */ __name(async (req, env) => {
  const b = await readBody(req);
  if (!b.bundleKey) throw badRequest("bundleKey required");
  if (!isSafeBundleKey(b.bundleKey)) throw badRequest("bundleKey must be a plain relative key under bundles/");
  if (!Array.isArray(b.shotIds) || b.shotIds.length < 2) throw badRequest("shotIds[] required (>= 2)");
  const shardCount = typeof b.shardCount === "number" ? b.shardCount : 2;
  const project = b.project ?? deriveProjectFromBundleKey(b.bundleKey);
  const tier = coerceQualityTier(b.qualityTier) ?? "final";
  const scatterModules = await discoverModules(env);
  const scatterOverrides = parseModuleRenderOverrides(b.renderOverrides);
  const scatterBackend = b.motion_backend ?? scatterOverrides.motion_backend;
  const scatterMotionErr = motionBackendPreflightError(scatterModules, scatterBackend);
  if (scatterMotionErr) throw badRequest(scatterMotionErr);
  const scatterCfgErr = motionConfigPreflightError(scatterModules, scatterBackend, scatterOverrides.config?.[(scatterBackend ?? "").trim()]);
  if (scatterCfgErr) throw badRequest(scatterCfgErr);
  const scatterMapped = mapRenderOverridesToModuleConfigs(b.renderOverrides, tier, scatterModules);
  const scatterKfErr = localGpuKeyframePreflightError(
    scatterModules,
    scatterBackend,
    scatterMapped.keyframe_backend
  );
  if (scatterKfErr) throw badRequest(scatterKfErr);
  const scatterCast = await resolveCastLoras(env, b.castLoras ?? {});
  if (scatterCast.skipped.length) throw badRequest(untrainedCastMessage(scatterCast.skippedDetail));
  if (shouldProjectWanLoras(scatterBackend, scatterCast.wanPretrained)) {
    const injected = ensureModuleOverrideConfig(b.renderOverrides, WAN_LORA_BACKEND);
    b.renderOverrides = injected.overrides;
    await projectWanLorasIntoModuleConfig(env, scatterBackend, scatterCast.wanPretrained, injected.config);
  }
  try {
    const job = await startScatterRender(env, {
      project,
      bundle_key: b.bundleKey,
      quality_tier: tier,
      shot_ids: b.shotIds,
      shard_count: shardCount,
      cast_loras: b.castLoras ?? {},
      render_overrides: b.renderOverrides,
      motion_backend: b.motion_backend,
      audio_key: b.audioKey,
      film_titles: b.film_titles,
      project_id: await resolveProjectRef(env, b.projectId)
    });
    const view = scatterJobToPollView(job);
    return json5({ ok: true, jobId: view.jobId, status: view.status }, 201);
  } catch (e) {
    const msg = e.message || "scatter submit failed";
    return json5({ ok: false, error: msg }, 422);
  }
}, "hScatterRender");
var hTrainCastLora = /* @__PURE__ */ __name(async (req, env, _c, p) => handleCastTrainLora(req, env, await resolveCastId(env, p.id)), "hTrainCastLora");
var hTrainCastWanLora = /* @__PURE__ */ __name(async (req, env, _c, p) => handleCastTrainWanLora(req, env, await resolveCastId(env, p.id)), "hTrainCastWanLora");
var hCastLoraStatus = /* @__PURE__ */ __name(async (_req, env, _c, p) => handleCastLoraStatus(env, await resolveCastId(env, p.id)), "hCastLoraStatus");
var hAdoptRender = /* @__PURE__ */ __name(async (req, env) => handleAdoptRender(req, env), "hAdoptRender");
var hPreflight = /* @__PURE__ */ __name(async (req, env) => {
  const body = await readBody(req);
  const envelope = body && typeof body === "object" ? body : {};
  const validated = validateStoryboard(envelope.storyboard);
  if (!validated.ok) {
    const issues2 = validated.errors.map((message) => ({
      level: "error",
      scope: "storyboard",
      message
    }));
    return json5(summarize(issues2), 200);
  }
  const issues = [...checkStoryboardShape(validated.value)];
  const bindings = envelope.castBindings && typeof envelope.castBindings === "object" ? envelope.castBindings : null;
  if (bindings && Object.keys(bindings).length > 0) {
    const kfModules = servingForHook(
      await discoverModules(env, { cacheTtlMs: 6e4 }),
      "keyframe"
    );
    const keyframeLabel = kfModules.map((m) => m.keyframe_label).find((l) => typeof l === "string" && l.trim()) || "SDXL";
    const catalog = await listCast(env);
    const { resolved, unresolved } = resolveCastBindings(bindings, catalog);
    issues.push(...unresolved);
    issues.push(...checkCastBindingsReady(resolved, catalog, keyframeLabel));
  }
  const motionBackend = typeof envelope.motionBackend === "string" ? envelope.motionBackend : null;
  if (motionBackend) {
    const quality = typeof envelope.quality === "string" ? envelope.quality : null;
    const motionModules = servingForHook(
      await discoverModules(env, { cacheTtlMs: 6e4 }),
      "motion.backend"
    );
    const mod = motionModules.find((m) => m.name === motionBackend);
    if (mod?.duration_grid) {
      const floorFraction = resolveClipDurationFloor(env.FILM_CLIP_DURATION_FLOOR);
      issues.push(...checkDurationGrid(validated.value, mod.duration_grid, quality, mod.name, floorFraction));
    }
  }
  return json5(summarize(issues), 200);
}, "hPreflight");
var hPlan = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!a.brief || !a.model) throw badRequest("brief and model required");
  if (!Array.isArray(a.characters)) a.characters = [];
  const r = await planStoryboard(env, a);
  return json5(r, r.ok ? 200 : 422);
}, "hPlan");
var hRefine = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (a.storyboard === void 0 || !a.message || !a.model) throw badRequest("storyboard, message, model required");
  const r = await refineStoryboard(env, a);
  return json5(r, r.ok ? 200 : 422);
}, "hRefine");
var hChat = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!a.model || !a.user_input) throw badRequest("model and user_input required");
  const modules = await discoverModules(env, { cacheTtlMs: 6e4 });
  if (resolveCatalogTarget(modules, "image.generate", a.model)) {
    const r2 = await chatImageViaModule(env, modules, a);
    if (!r2.ok) return json5({ error: r2.error, model: r2.model }, 502);
    return json5({
      model: r2.model,
      model_type: "image",
      output: r2.output,
      output_artifact: r2.output_artifact,
      latency_ms: r2.latency_ms,
      ai_gateway_log_id: r2.ai_gateway_log_id
    });
  }
  const r = await chatComplete(env, a);
  if (!r.ok) return json5({ error: r.error, model: r.model }, 422);
  return json5({ output: r.output, model: r.model, logId: r.logId });
}, "hChat");
var hScoreBedGenerate = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (a.kind === "narration") {
    if (!a.text?.trim() && !a.storyboard) throw badRequest("text or storyboard required");
  } else if (!a.prompt?.trim()) {
    throw badRequest("prompt required");
  }
  const r = await startScoreBedGenerate(env, {
    kind: a.kind === "narration" ? "narration" : "music",
    prompt: a.prompt,
    text: a.text,
    module: a.module,
    storyboard: a.storyboard,
    seconds: a.seconds,
    config: a.config
  });
  if (!r.ok) return json5({ error: r.error }, 422);
  return json5({ status: r.status, id: r.id, module: r.module, label: r.label });
}, "hScoreBedGenerate");
var hPollScoreBed = /* @__PURE__ */ __name(async (req, env, _c, p) => {
  const module = new URL(req.url).searchParams.get("module")?.trim() || "";
  if (!module) throw badRequest("module query param required");
  return json5(await pollScoreBedGenerate(env, p.id, module));
}, "hPollScoreBed");
var hRenderPlan = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  const modules = await discoverModules(env);
  return json5({ ok: true, plan: resolveRenderPipeline(modules, a.selection ?? {}) });
}, "hRenderPlan");
var hStartClips = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!Array.isArray(a.shots) || a.shots.length === 0) throw badRequest("shots[] required");
  const job = await startClipJob(env, { project: a.project ?? "clips", shots: a.shots, motion_backend: a.motion_backend, config: a.config });
  return json5({
    ok: true,
    job_id: job.job_id,
    motion_backend: job.motion_backend,
    ...summarizeJob(job),
    shots: job.shots.map((sh) => ({ shot_id: sh.shot_id, status: sh.status, error: sh.error }))
  });
}, "hStartClips");
var hPollClips = /* @__PURE__ */ __name(async (_req, env, _c, p) => {
  const job = await advanceClipJob(env, p.id);
  if (!job) throw notFound("clip job");
  return json5({
    ok: true,
    job_id: job.job_id,
    motion_backend: job.motion_backend,
    ...summarizeJob(job),
    shots: job.shots.map((sh) => ({ shot_id: sh.shot_id, status: sh.status, clip_key: sh.clip_key, error: sh.error }))
  });
}, "hPollClips");
async function withFilmDownloadUrl(env, summary) {
  if (summary.phase === "done" && summary.film_key) {
    return { ...summary, download_url: await presignR2Get2(env, summary.film_key, FILM_DOWNLOAD_TTL_SECONDS2) };
  }
  const u = summary.finish_unavailable;
  if (summary.phase === "done" && u?.at === "assemble" && u.clips?.length) {
    const clip_urls = await Promise.all(u.clips.map(async (c) => ({
      shot_id: c.shot_id,
      download_url: await presignR2Get2(env, c.clip_key, FILM_DOWNLOAD_TTL_SECONDS2)
    })));
    return { ...summary, clip_urls };
  }
  return summary;
}
__name(withFilmDownloadUrl, "withFilmDownloadUrl");
async function insertRenderBestEffort(env, row) {
  try {
    await insertRender(env, row);
  } catch (e) {
    console.log(JSON.stringify({
      ev: "render.bookkeeping_deferred",
      op: "insertRender",
      job_id: row.jobId,
      project: row.project,
      reason: e instanceof Error ? e.message : String(e)
    }));
  }
}
__name(insertRenderBestEffort, "insertRenderBestEffort");
async function withFilmDownloadUrlBestEffort(env, summary) {
  try {
    return await withFilmDownloadUrl(env, summary);
  } catch (e) {
    console.log(JSON.stringify({
      ev: "render.bookkeeping_deferred",
      op: "withFilmDownloadUrl",
      film_id: summary.film_id,
      reason: e instanceof Error ? e.message : String(e)
    }));
    return summary;
  }
}
__name(withFilmDownloadUrlBestEffort, "withFilmDownloadUrlBestEffort");
var hStartFilm = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!a.bundle_key) throw badRequest("bundle_key required");
  if (!isSafeBundleKey(a.bundle_key)) throw badRequest("bundle_key must be a plain relative key under bundles/");
  if (!Array.isArray(a.scenes) || a.scenes.length === 0) throw badRequest("scenes[] required");
  assertConfigMapShape("keyframe_config", a.keyframe_config);
  assertConfigMapShape("motion_config", a.motion_config);
  assertModuleConfigMap("finish_config", a.finish_config);
  assertModuleConfigMap("speech_config", a.speech_config);
  assertModuleConfigMap("film_finish_config", a.film_finish_config);
  assertModuleConfigMap("master_config", a.master_config);
  const filmModules = await discoverModules(env);
  const filmMotionErr = motionBackendPreflightError(filmModules, a.motion_backend);
  if (filmMotionErr) throw badRequest(filmMotionErr);
  const filmCfgErr = motionConfigPreflightError(filmModules, a.motion_backend, a.motion_config);
  if (filmCfgErr) throw badRequest(filmCfgErr);
  const filmKfErr = localGpuKeyframePreflightError(filmModules, a.motion_backend, a.keyframe_backend);
  if (filmKfErr) throw badRequest(filmKfErr);
  const resolvedLoras = a.cast_loras && Object.keys(a.cast_loras).length ? await resolveCastLoras(env, a.cast_loras) : null;
  if (resolvedLoras && resolvedLoras.skipped.length) {
    throw badRequest(untrainedCastMessage(resolvedLoras.skippedDetail));
  }
  const castIds = resolvedLoras && Object.keys(resolvedLoras.castIds).length ? resolvedLoras.castIds : void 0;
  let dialogue_lines = a.dialogue_lines;
  if (!dialogue_lines || !dialogue_lines.length) {
    const bundleScenes = await readBundleScenes(env, a.bundle_key);
    if (bundleScenes.some((s) => s.dialogue)) {
      dialogue_lines = dialogueLinesFromBundleScenes(bundleScenes, resolvedLoras?.voices ?? {});
    }
  } else if (
    // #582: EXPLICIT lines used to skip voice resolution entirely, so a line without a voice_id fell
    // to DEFAULT_VOICE_ID even when the shot's speaking slot is bound to a cast member WITH a voice
    // (Wren spoke as angus, film-08dd5777). When any line lacks a voice and the caller's cast_loras
    // resolved to at least one voice, resolve shot -> slot (bundle storyboard) -> cast voice. A line
    // that CARRIES a voice_id is never touched (explicit always wins); no cast voices -> nothing to
    // resolve, the downstream default stands.
    resolvedLoras && Object.keys(resolvedLoras.voices).length && dialogue_lines.some((l) => !(typeof l.voice_id === "string" && l.voice_id.trim()))
  ) {
    const bundleScenes = await readBundleScenes(env, a.bundle_key);
    dialogue_lines = resolveExplicitLineVoices(dialogue_lines, bundleScenes, resolvedLoras.voices);
  }
  const project = a.project ?? deriveProjectFromBundleKey(a.bundle_key);
  if (shouldProjectWanLoras(a.motion_backend, resolvedLoras?.wanPretrained ?? {})) {
    const filmMotionConfig = a.motion_config && typeof a.motion_config === "object" && !Array.isArray(a.motion_config) ? a.motion_config : {};
    await projectWanLorasIntoModuleConfig(env, a.motion_backend, resolvedLoras.wanPretrained, filmMotionConfig);
    a.motion_config = filmMotionConfig;
  }
  const job = await startFilmJob(env, {
    project,
    bundle_key: a.bundle_key,
    scenes: a.scenes,
    motion_backend: a.motion_backend,
    keyframe_backend: a.keyframe_backend,
    keyframe_config: a.keyframe_config,
    motion_config: a.motion_config,
    // audio_key: a staged bed (score-bed music/narration) to mux after assemble. startFilmJob runs it
    // through resolveStagedAudioKey; without forwarding it here the mux phase is skipped and the film is
    // silent even when the caller supplied a bed (the scored/narrated render path).
    finish_config: a.finish_config,
    speech_config: a.speech_config,
    film_finish_config: a.film_finish_config,
    master_config: a.master_config,
    audio_key: a.audio_key,
    film_titles: a.film_titles,
    // dialogue_lines (#296 explicit arg, #313 bundle-derived): the per-shot lines for the dialogue/
    // TTS+lip-sync stage (enterDialogueOrFinish) and the subtitle module (buildCaptionCues), both of
    // which read job.dialogue_lines. cast_loras carries the speaking cast (slot -> cast id) so the
    // LoRA write-back + voice resolution have it.
    dialogue_lines,
    cast_loras: castIds,
    // #762 Bug 1: forward the ALREADY-RESOLVED, ready cast adapters as pretrained_loras, exactly the
    // way hSubmitRender does (the render route). Dropping this made the keyframe worker RETRAIN every
    // ready cast LoRA from scratch (~20 min, no signal) on the film path -- film-09d40b28 sat 23 min in
    // keyframe retraining Wren + the Salvage Robot, both already lora_status:ready. resolvedLoras.pretrained
    // holds the banked adapter R2 keys; startFilmJob already threads them into the keyframe worker input.
    pretrained_loras: resolvedLoras && Object.keys(resolvedLoras.pretrained).length ? resolvedLoras.pretrained : void 0,
    // #762 Bug 2: carry the caller's requested quality tier so the recorded renders-row LABEL is HONEST
    // (filmRowFromJob read a hardcoded "final", so a draft film mislabeled as final in history). The
    // ACTUAL render tier is driven by the baked keyframe_config.quality_tier (read by the keyframe module)
    // + motion_config, unchanged here; this only makes the row match what was asked. An absent/invalid
    // value coerces to undefined -> filmRowFromJob defaults "final" (pre-#762 behavior preserved).
    quality_tier: coerceQualityTier(a.qualityTier)
  }, filmModules);
  await insertRenderBestEffort(env, filmRowFromJob(job));
  return json5({ ok: true, ...await withFilmDownloadUrlBestEffort(env, summarizeFilm(job, null)) }, 201);
}, "hStartFilm");
var hPollFilm = /* @__PURE__ */ __name(async (_req, env, ctx, p) => {
  const r = await advanceFilmJob(env, p.id);
  if (!r) throw notFound("film job");
  await insertRender(env, filmRowFromJob(r.job));
  const kfDone = r.job.phase === "keyframe" && r.job.keyframe_job_id ? await readKeyframeDone(env, r.job.project, r.job.keyframe_job_id) : void 0;
  await updateRenderFromView(env, filmJobToPollView(r.job, r.clipJob, kfDone), ctx);
  return json5({ ok: true, ...await withFilmDownloadUrl(env, summarizeFilm(r.job, r.clipJob)) });
}, "hPollFilm");
var hEnhance = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!a.storyboard || !Array.isArray(a.storyboard.scenes)) {
    throw badRequest("storyboard with scenes required");
  }
  const envRec = env;
  const modules = await discoverModules(envRec);
  const seed = { storyboard: a.storyboard, brief: a.brief };
  const result = await dispatchChain(
    envRec,
    modules,
    "plan.enhance",
    seed,
    { project: a.project || "enhance", job_id: crypto.randomUUID() },
    {
      nextInput: /* @__PURE__ */ __name((prev) => ({ storyboard: prev.storyboard, brief: a.brief }), "nextInput"),
      configFor: /* @__PURE__ */ __name(() => a.config, "configFor")
    }
  );
  return json5({
    ok: true,
    storyboard: result.output?.storyboard ?? a.storyboard,
    applied: result.applied,
    errors: result.errors,
    notes: result.output?.notes ?? []
  });
}, "hEnhance");
var hModels = /* @__PURE__ */ __name(async (_req, env) => {
  const modules = await discoverModules(env, {
    cacheTtlMs: 6e4
  });
  return json5({ models: catalogForDeploy(env, planningModelsFromModules(modules)) });
}, "hModels");
var hAllModels = /* @__PURE__ */ __name(async (_req, env) => {
  const modules = await discoverModules(env, {
    cacheTtlMs: 6e4
  });
  const models = [...planningModelsFromModules(modules), ...imageModelsFromModules(modules)];
  return json5({ models: catalogForDeploy(env, models) });
}, "hAllModels");
var hYaml = /* @__PURE__ */ __name(async (req) => {
  const a = await readBody(req);
  if (!a.storyboard) throw badRequest("storyboard required");
  const v = validateStoryboard(a.storyboard);
  if (!v.ok) throw badRequest(`storyboard invalid: ${v.errors.join("; ")}`);
  return json5({ ok: true, yaml: serializeStoryboardYaml(v.value) });
}, "hYaml");
var MARKERS_FORMATS = ["premiere_csv", "resolve_csv"];
var hMarkers = /* @__PURE__ */ __name(async (req) => {
  const a = await readBody(req);
  if (!a.storyboard || !a.format) throw badRequest("storyboard and format required");
  if (!MARKERS_FORMATS.includes(a.format)) {
    throw badRequest(`format must be one of: ${MARKERS_FORMATS.join(", ")}`);
  }
  const out = emitMarkers(a.storyboard, a.format, a.fps);
  return new Response(out.body, {
    headers: { "content-type": out.contentType, "content-disposition": 'attachment; filename="' + out.filename + '"' }
  });
}, "hMarkers");
var hBundle = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!a.storyboard || !a.characterRefs) throw badRequest("storyboard and characterRefs required");
  const r = await assembleBundle(env, a);
  return json5(r, r.ok ? 201 : 400);
}, "hBundle");
var hAudioAnalyze = /* @__PURE__ */ __name(async (req, env) => {
  const a = await readBody(req);
  if (!a.audioKey) throw badRequest("audioKey required");
  const result = await analyzeAudioBeats(env, a, a.module?.trim() || void 0);
  if (!result.ok) return json5({ ok: false, error: result.error }, 502);
  return json5({ ok: true, output: result.plan, module: result.module });
}, "hAudioAnalyze");
var hWhoami = /* @__PURE__ */ __name(async () => json5({ user: "studio" }), "hWhoami");
var hGetPrefs = /* @__PURE__ */ __name(async (req, env) => {
  const prefs = await getUserPrefs(env);
  return json5({ ok: true, prefs });
}, "hGetPrefs");
var hPatchPrefs = /* @__PURE__ */ __name(async (req, env) => {
  const body = await readBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a prefs object");
  const prefs = await setUserPrefs(env, body);
  return json5({ ok: true, prefs });
}, "hPatchPrefs");
async function resolveModuleByName(env, name) {
  const modules = await discoverModules(env);
  return modules.find((m) => m.name === name) ?? null;
}
__name(resolveModuleByName, "resolveModuleByName");
var hGetModuleConfig = /* @__PURE__ */ __name(async (_req, env, _ctx, p) => {
  const mod = await resolveModuleByName(env, p.name);
  if (!mod) throw notFound("module");
  if (!hasInstallConfig(mod.config_schema)) throw notFound("module has no install-scope config");
  const config = await loadInstallConfig(env, mod.name, mod.config_schema);
  return json5({ ok: true, module: mod.name, config });
}, "hGetModuleConfig");
var hPatchModuleConfig = /* @__PURE__ */ __name(async (req, env, _ctx, p) => {
  const mod = await resolveModuleByName(env, p.name);
  if (!mod) throw notFound("module");
  if (!hasInstallConfig(mod.config_schema)) throw notFound("module has no install-scope config");
  const body = await readBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a config object");
  const config = await setInstallConfig(env, mod.name, mod.config_schema, body);
  return json5({ ok: true, module: mod.name, config });
}, "hPatchModuleConfig");
var hListInstalledModules = /* @__PURE__ */ __name(async (_req, env) => {
  return json5({ ok: true, modules: await listInstalledModules(env) });
}, "hListInstalledModules");
var hInstallModule = /* @__PURE__ */ __name(async (req, env) => {
  if (!env.MODULE_DISPATCH) throw badRequest("dispatch is not enabled on this host (no MODULE_DISPATCH namespace bound)");
  const body = await readBody(req);
  const script = typeof body?.script_name === "string" ? body.script_name.trim() : "";
  if (!script) throw badRequest("script_name required");
  let fetcher;
  try {
    fetcher = env.MODULE_DISPATCH.get(script);
  } catch (e) {
    throw badRequest(`script "${script}" is not resident in the namespace: ${e.message}`);
  }
  let manifestText;
  try {
    const res = await fetcher.fetch("https://module/module.json");
    if (!res.ok) throw badRequest(`GET /module.json -> ${res.status}`);
    manifestText = await res.text();
  } catch (e) {
    if (e instanceof HttpError2) throw e;
    throw badRequest(`module unreachable: ${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    throw badRequest("module.json is not valid JSON");
  }
  const manifest = validateManifest(raw);
  if (typeof manifest === "string") return json5({ ok: false, error: `invalid manifest: ${manifest}` }, 422);
  const checks = await runLiveConformance(fetcher);
  if (!allPass(checks)) return json5({ ok: false, error: "conformance failed", checks: failures(checks) }, 422);
  await installModuleRow(env, {
    name: manifest.name,
    script_name: script,
    manifest_json: manifestText,
    api: manifest.api,
    installed_at: Date.now()
  });
  return json5({ ok: true, module: manifest.name, script_name: script, checks }, 201);
}, "hInstallModule");
var hUninstallModule = /* @__PURE__ */ __name(async (_req, env, _ctx, p) => {
  const removed = await uninstallModuleRow(env, p.name);
  if (!removed) throw notFound("module not installed");
  return json5({ ok: true, module: p.name, removed: true });
}, "hUninstallModule");
var hSetModuleEnabled = /* @__PURE__ */ __name(async (req, env, _ctx, p) => {
  const body = await readBody(req);
  if (typeof body?.enabled !== "boolean") throw badRequest("body needs a boolean `enabled`");
  const matched = await setModuleEnabled(env, p.name, body.enabled);
  if (!matched) throw notFound("module not installed");
  return json5({ ok: true, module: p.name, enabled: body.enabled });
}, "hSetModuleEnabled");
var DEMO_ASSISTANT_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
var DEMO_ASSISTANT_NOTE = "running on a free open-weights model here -- not as sharp as the full studio brain; run your own Vivijure for the good one.";
function demoIp(req) {
  return req.headers.get("cf-connecting-ip") || "global";
}
__name(demoIp, "demoIp");
function positiveIntVar(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}
__name(positiveIntVar, "positiveIntVar");
function demoRenderCaps(env) {
  return {
    ...DEFAULT_DEMO_RENDER_CAPS,
    perIpDaily: positiveIntVar(env.DEMO_RENDER_PER_IP_DAILY, DEFAULT_DEMO_RENDER_CAPS.perIpDaily),
    globalDaily: positiveIntVar(env.DEMO_RENDER_GLOBAL_DAILY, DEFAULT_DEMO_RENDER_CAPS.globalDaily),
    queueDepth: positiveIntVar(env.DEMO_RENDER_QUEUE_DEPTH, DEFAULT_DEMO_RENDER_CAPS.queueDepth)
  };
}
__name(demoRenderCaps, "demoRenderCaps");
function demoChatCaps(env) {
  return {
    ...DEFAULT_DEMO_CHAT_CAPS,
    perIpDaily: positiveIntVar(env.DEMO_CHAT_PER_IP_DAILY, DEFAULT_DEMO_CHAT_CAPS.perIpDaily),
    globalDaily: positiveIntVar(env.DEMO_CHAT_GLOBAL_DAILY, DEFAULT_DEMO_CHAT_CAPS.globalDaily)
  };
}
__name(demoChatCaps, "demoChatCaps");
function demoRenderEnabled(env) {
  return (env.DEMO_RENDER_ENABLED || "").trim() === "true" && !!resolveFetcher(env, "MODULE_LOCAL_GPU");
}
__name(demoRenderEnabled, "demoRenderEnabled");
function demoBackend(env) {
  const envRec = env;
  return {
    async reachable() {
      return demoRenderEnabled(env);
    },
    async submit(r, jobId) {
      const f = resolveFetcher(envRec, "MODULE_LOCAL_GPU");
      if (!f) return { ok: false, error: "local-gpu door not bound" };
      const input = {
        shot_id: jobId,
        keyframe_url: r.keyframe_url,
        keyframe_key: r.keyframe_key,
        prompt: r.prompt,
        seconds: r.seconds
      };
      const resp = await invokeModule(f, {
        hook: "motion.backend",
        input,
        config: { quality: r.quality },
        context: { project: "demo", job_id: jobId }
      });
      if (resp.ok && resp.pending) return { ok: true, poll: resp.poll };
      if (!resp.ok) return { ok: false, error: resp.error || "submit failed" };
      return { ok: false, error: "local-gpu returned no poll token" };
    },
    async poll(token) {
      const f = resolveFetcher(envRec, "MODULE_LOCAL_GPU");
      if (!f) return { ok: false, error: "local-gpu door not bound" };
      const p = await pollModule(f, { poll: token });
      if (p.ok && p.pending) return { ok: true, pending: true };
      if (p.ok) {
        const clip = p.output?.clip_key;
        return clip ? { ok: true, clipKey: clip } : { ok: false, error: "backend returned no clip_key" };
      }
      return { ok: false, error: p.error || "poll failed" };
    }
  };
}
__name(demoBackend, "demoBackend");
function demoRenderDeps(env) {
  return {
    db: env.DB,
    backend: demoBackend(env),
    artifactOrigin: (env.DEMO_ARTIFACT_ORIGIN || DEMO_MEDIA_ORIGIN).trim(),
    caps: demoRenderCaps(env),
    now: Date.now()
  };
}
__name(demoRenderDeps, "demoRenderDeps");
var hDemoMenu = /* @__PURE__ */ __name(async (req, env) => {
  if (!isDemoMode(env)) throw notFound("route");
  const scenes = await listRenderables(env.DB);
  return json5({ available: demoRenderEnabled(env), scenes });
}, "hDemoMenu");
var hDemoRender = /* @__PURE__ */ __name(async (req, env) => {
  if (!isDemoMode(env)) throw notFound("route");
  const rl = await enforceSpendLimit(req, env);
  if (!rl.ok) return json5({ error: rl.message }, rl.status);
  const b = await readBody(req);
  const r = await submitDemoRender(demoRenderDeps(env), {
    renderableId: String(b.scene || ""),
    ip: demoIp(req),
    jobId: crypto.randomUUID()
  });
  if (!r.ok) {
    const status = r.reason === "paused" ? 503 : r.reason === "unknown-scene" ? 400 : 429;
    return json5({ error: r.message, reason: r.reason }, status);
  }
  return json5({ jobId: r.jobId, status: r.status, position: r.position, waitSeconds: r.waitSeconds });
}, "hDemoRender");
var hDemoPoll = /* @__PURE__ */ __name(async (req, env, ctx, p) => {
  if (!isDemoMode(env)) throw notFound("route");
  const r = await pollDemoRender(demoRenderDeps(env), p.id);
  if (r.status === "not_found") throw notFound("render");
  return json5(r);
}, "hDemoPoll");
var hDemoChat = /* @__PURE__ */ __name(async (req, env) => {
  if (!isDemoMode(env)) throw notFound("route");
  const b = await readBody(req);
  const model = /* @__PURE__ */ __name(async ({ system, user, maxTokens }) => {
    const modelId = env.DEMO_ASSISTANT_MODEL || DEMO_ASSISTANT_DEFAULT_MODEL;
    const out = await aiRun(env, modelId, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens
    });
    const resp = out.response;
    return typeof resp === "string" ? resp : "";
  }, "model");
  const r = await runDemoChat(
    { db: env.DB, model, caps: demoChatCaps(env), now: Date.now() },
    { ip: demoIp(req), message: String(b.message || "") }
  );
  if (!r.ok) {
    const status = r.reason === "exhausted" ? 429 : r.reason === "error" ? 503 : 400;
    return json5({ error: r.message, reason: r.reason, model: "oss" }, status);
  }
  return json5({ reply: r.reply, model: "oss" });
}, "hDemoChat");
var API_ROUTES = [
  { method: "GET", pattern: "/api/demo/menu", handler: hDemoMenu },
  { method: "POST", pattern: "/api/demo/render", handler: hDemoRender },
  { method: "GET", pattern: "/api/demo/render/:id", handler: hDemoPoll },
  { method: "POST", pattern: "/api/demo/chat", handler: hDemoChat },
  { method: "GET", pattern: "/api/storyboard/projects", handler: hListProjects },
  { method: "POST", pattern: "/api/storyboard/projects", handler: hCreateProject },
  { method: "GET", pattern: "/api/storyboard/projects/:id", handler: hGetProject },
  { method: "PATCH", pattern: "/api/storyboard/projects/:id", handler: hPatchProject },
  { method: "POST", pattern: "/api/storyboard/projects/:id/storyboard", handler: hSaveProjectStoryboard },
  { method: "DELETE", pattern: "/api/storyboard/projects/:id", handler: hDeleteProject },
  { method: "GET", pattern: "/api/voices", handler: hListVoices },
  { method: "GET", pattern: "/api/cast", handler: hListCast },
  { method: "POST", pattern: "/api/cast", handler: hCreateCast },
  { method: "GET", pattern: "/api/cast/export/:id", handler: hExportCast },
  { method: "POST", pattern: "/api/cast/export/:id", handler: hExportCast },
  { method: "POST", pattern: "/api/cast/import", handler: hImportCast },
  { method: "GET", pattern: "/api/cast/:id", handler: hGetCast },
  { method: "PATCH", pattern: "/api/cast/:id", handler: hPatchCast },
  { method: "DELETE", pattern: "/api/cast/:id", handler: hDeleteCast },
  { method: "POST", pattern: "/api/cast/:id/portrait", handler: hSetPortrait },
  { method: "DELETE", pattern: "/api/cast/:id/portrait", handler: hClearPortrait },
  { method: "POST", pattern: "/api/cast/:id/ref", handler: hAddRef },
  { method: "DELETE", pattern: "/api/cast/:id/ref", handler: hRemoveRef },
  { method: "DELETE", pattern: "/api/cast/:id/refs/*refKey", handler: hRemoveRef },
  { method: "POST", pattern: "/api/cast/:id/source", handler: hAddSource },
  { method: "DELETE", pattern: "/api/cast/:id/source", handler: hRemoveSource },
  { method: "DELETE", pattern: "/api/cast/:id/source/*sourceKey", handler: hRemoveSource },
  { method: "POST", pattern: "/api/cast/:id/generate-refs", handler: hGenerateCastRefs },
  { method: "GET", pattern: "/api/cast/:id/refs-job/:jobId", handler: hPollCastRefs },
  { method: "POST", pattern: "/api/cast/:id/train-lora", handler: hTrainCastLora },
  { method: "POST", pattern: "/api/cast/:id/train-wan-lora", handler: hTrainCastWanLora },
  { method: "GET", pattern: "/api/cast/:id/lora-status", handler: hCastLoraStatus },
  { method: "POST", pattern: "/api/upload", handler: hUpload },
  { method: "GET", pattern: "/api/artifact/*key", handler: hServeArtifact },
  { method: "HEAD", pattern: "/api/artifact/*key", handler: hServeArtifact },
  { method: "POST", pattern: "/api/storyboard/preflight", handler: hPreflight },
  { method: "POST", pattern: "/api/storyboard/plan", handler: hPlan },
  { method: "POST", pattern: "/api/storyboard/refine", handler: hRefine },
  { method: "POST", pattern: "/api/chat", handler: hChat },
  { method: "POST", pattern: "/api/storyboard/score-bed", handler: hScoreBedGenerate },
  { method: "POST", pattern: "/api/storyboard/music-generate", handler: hScoreBedGenerate },
  { method: "GET", pattern: "/api/job/:id", handler: hPollScoreBed },
  { method: "POST", pattern: "/api/storyboard/enhance", handler: hEnhance },
  { method: "GET", pattern: "/api/models", handler: hAllModels },
  { method: "GET", pattern: "/api/storyboard/models", handler: hModels },
  { method: "POST", pattern: "/api/storyboard/yaml", handler: hYaml },
  { method: "POST", pattern: "/api/storyboard/markers", handler: hMarkers },
  { method: "POST", pattern: "/api/storyboard/bundle", handler: hBundle },
  { method: "POST", pattern: "/api/storyboard/audio-upload", handler: hStoryboardAudioUpload },
  { method: "POST", pattern: "/api/storyboard/character-ref", handler: hStoryboardCharacterRef },
  { method: "POST", pattern: "/api/audio/analyze", handler: hAudioAnalyze },
  { method: "POST", pattern: "/api/storyboard/render", handler: hSubmitRender },
  { method: "POST", pattern: "/api/storyboard/render-plan", handler: hRenderPlan },
  { method: "POST", pattern: "/api/render/clips", handler: hStartClips },
  { method: "GET", pattern: "/api/render/clips/:id", handler: hPollClips },
  { method: "POST", pattern: "/api/render/film", handler: hStartFilm },
  { method: "GET", pattern: "/api/render/film/:id", handler: hPollFilm },
  { method: "POST", pattern: "/api/storyboard/renders/:id/regen-shot", handler: hRegenShot },
  { method: "POST", pattern: "/api/storyboard/render/scatter", handler: hScatterRender },
  { method: "POST", pattern: "/api/storyboard/render-from-keyframes", handler: hRenderFromKeyframes },
  { method: "GET", pattern: "/api/storyboard/render/:jobId", handler: hPollRender },
  { method: "DELETE", pattern: "/api/storyboard/render/:jobId", handler: hCancelRender },
  { method: "GET", pattern: "/api/storyboard/renders", handler: hListRenders },
  { method: "GET", pattern: "/api/storyboard/renders/tags", handler: hListTags },
  { method: "PATCH", pattern: "/api/storyboard/renders/:id", handler: hPatchRender },
  { method: "DELETE", pattern: "/api/storyboard/renders/:id", handler: hDeleteRender },
  { method: "POST", pattern: "/api/storyboard/renders/:id/add-audio", handler: hAddRenderAudio },
  { method: "POST", pattern: "/api/storyboard/renders/:id/add-narration", handler: hAddRenderNarration },
  { method: "POST", pattern: "/api/storyboard/renders/:id/finalize", handler: hFinalizePreview },
  { method: "POST", pattern: "/api/storyboard/renders/:id/animate-cloud", handler: hAnimateCloud },
  { method: "POST", pattern: "/api/storyboard/renders/:id/animate-hybrid", handler: hAnimateHybrid },
  { method: "POST", pattern: "/api/storyboard/renders/adopt", handler: hAdoptRender },
  { method: "GET", pattern: "/api/whoami", handler: hWhoami },
  { method: "GET", pattern: "/api/prefs", handler: hGetPrefs },
  { method: "PATCH", pattern: "/api/prefs", handler: hPatchPrefs },
  { method: "GET", pattern: "/api/modules/installed", handler: hListInstalledModules },
  { method: "POST", pattern: "/api/modules/install", handler: hInstallModule },
  { method: "DELETE", pattern: "/api/modules/install/:name", handler: hUninstallModule },
  { method: "PATCH", pattern: "/api/modules/install/:name", handler: hSetModuleEnabled },
  { method: "GET", pattern: "/api/modules/:name/config", handler: hGetModuleConfig },
  { method: "PATCH", pattern: "/api/modules/:name/config", handler: hPatchModuleConfig }
];
var WELCOME_REDIRECT_PATHS = /* @__PURE__ */ new Set(["/welcome", "/welcome/", "/welcome.html"]);
var WELCOME_REDIRECT_TARGET = "https://vivijure.com/";
var STUDIO_PAGE_ASSETS = {
  // index.html was a byte-identical copy of modules.html (removed in the 2026-07 truth pass);
  // the modules/pipeline page IS the landing page, served from the single source file.
  "/": "/modules.html",
  "/index.html": "/modules.html",
  "/planner": "/planner.html",
  "/planner/": "/planner.html",
  "/cast": "/cast.html",
  "/cast/": "/cast.html",
  "/modules": "/modules.html",
  "/modules/": "/modules.html",
  "/settings": "/settings.html",
  "/settings/": "/settings.html"
};
function serveStudioAsset(env, request, url, assetPath) {
  return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
}
__name(serveStudioAsset, "serveStudioAsset");
var index_default = {
  // Single security-header chokepoint: EVERY response routeRequest returns is stamped with the right
  // headers for its class (CF's zone-wide managed transform is off; the worker owns headers, #370).
  async fetch(request, raw, ctx) {
    const env = studioEnv(raw);
    return applyResponseSecurity(await routeRequest(request, env, ctx), request, env);
  },
  async scheduled(_event, raw, ctx) {
    const env = studioEnv(raw);
    ctx.waitUntil(sweepUnresolvedJobs(env, ctx));
  }
};
async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json5({ ok: true, service: "vivijure-studio", phase: 1 });
  if (url.pathname.startsWith("/api/")) {
    const gate = await gateApi(request, env);
    if (!gate.ok) return json5({ error: gate.reason }, gate.status);
  }
  if (url.pathname === "/api/modules" && request.method === "GET") {
    const modules = await discoverModules(env, { cacheTtlMs: 6e4 });
    return json5(
      modulesResponse(modules, renderConfigProjection(), {
        dispatch: !!env.MODULE_DISPATCH,
        ...isDemoMode(env) ? {
          readonly: true,
          render: { available: demoRenderEnabled(env) },
          // Assistant capability only when the AI binding is present (Phase B provisioned); a
          // Phase-A demo (no AI) simply omits it, so the UI never advertises a chat it cannot serve.
          ...env.AI ? { assistant: { model: "oss", note: DEMO_ASSISTANT_NOTE } } : {}
        } : {}
      })
    );
  }
  if (WELCOME_REDIRECT_PATHS.has(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
    return Response.redirect(WELCOME_REDIRECT_TARGET, 301);
  }
  const studioPage = resolveStudioPage(env, url.pathname);
  if (studioPage && (request.method === "GET" || request.method === "HEAD")) {
    return serveStudioAsset(env, request, url, studioPage);
  }
  if (isSpendRoute(request.method, url.pathname)) {
    const rl = await enforceSpendLimit(request, env);
    if (!rl.ok) {
      const headers = { "content-type": "application/json; charset=utf-8" };
      if (rl.retryAfter !== void 0) headers["retry-after"] = String(rl.retryAfter);
      return new Response(JSON.stringify({ error: rl.message }), { status: rl.status, headers });
    }
  }
  const hit = match(API_ROUTES, request.method, url.pathname);
  if (hit) {
    try {
      return await hit.handler(request, env, ctx, hit.params);
    } catch (e) {
      if (e instanceof HttpError2) return json5({ error: e.message }, e.status);
      console.error("router error", url.pathname, e);
      return json5({ error: "internal error" }, 500);
    }
  }
  return env.ASSETS.fetch(request);
}
__name(routeRequest, "routeRequest");
function resolveStudioPage(env, pathname) {
  const asset = STUDIO_PAGE_ASSETS[pathname];
  if (asset && isDemoMode(env) && (pathname === "/" || pathname === "/index.html")) {
    return "/planner.html";
  }
  return asset;
}
__name(resolveStudioPage, "resolveStudioPage");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
