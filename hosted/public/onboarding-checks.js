// Pure onboarding helpers for the hosted-tier front door (#58).
//
// NO DOM access on purpose: these unit-test under plain Node
// (tests/onboarding-checks.test.ts) and also load as a classic <script> on
// onboarding.html, exposing `window.onboardingChecks`. The UMD-ish wrapper
// picks CommonJS when `module` exists (the test harness) and a global
// otherwise (the browser), so one file serves both with no build step. This
// mirrors public/render-eta.js and public/lora-preflight.js.
//
// PRINCIPLE: none of these functions hardcode the provisioning plan. The plan
// (which endpoints, what max_workers each pins) is DATA supplied by the
// control plane and owned by the provisioner (#54). The UI is a projection of
// that plan, exactly like the planner is a projection of the module registry:
// add an endpoint to the plan and the review screen grows a row on its own.
//
// SECRET HYGIENE: the pasted RunPod key never reaches these helpers except in
// keyShapeHint, which inspects only the PREFIX and length and never returns,
// stores, or logs the value.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.onboardingChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The onboarding steps, in order. The stepper renders from this list.
  // Two-phase key custody (ruled on #52): RunPod keys are console-minted only,
  // and a per-endpoint invoke scope can only name endpoints that ALREADY exist.
  // So the tenant necessarily mints twice: key A (transient, graphql R/W)
  // creates the 4 endpoints, then key B (invoke-only, scoped to exactly those
  // 4) is what we keep. The "invoke" step is that second mint. It cannot be
  // collapsed into one paste, and account-wide invoke as a shortcut was
  // rejected for launch: we hold other people's keys, so minimal stored blast
  // radius beats one screen of friction.
  const STEPS = [
    { key: "what", title: "What you get" },
    { key: "rules", title: "The rules" },
    { key: "key", title: "Setup key" },
    { key: "capacity", title: "Your capacity" },
    { key: "review", title: "Review" },
    { key: "build", title: "Building" },
    { key: "invoke", title: "Render key" },
    { key: "done", title: "Done" },
  ];

  // RunPod re-issued its API keys in 2024-11 with an `rpa_` prefix; older keys
  // carry different permission semantics and cannot express the Restricted
  // graphql-R/W shape this flow asks for (spike delta 4). This is a courtesy
  // hint at paste time, NOT authorization: only RunPod can say if a key works,
  // and the capacity probe is what actually proves it.
  const KEY_PREFIX = "rpa_";

  function keyShapeHint(raw) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) {
      return { level: "empty", message: "" };
    }
    if (!key.startsWith(KEY_PREFIX)) {
      return {
        level: "warn",
        message:
          "This does not look like a current RunPod key. Newer keys start with " +
          KEY_PREFIX +
          " and are the ones this setup expects. An older key may not have the right permissions. You can try it anyway; we check with RunPod either way.",
      };
    }
    if (key.length < 16) {
      return {
        level: "warn",
        message: "That key looks too short to be complete. Check you copied all of it.",
      };
    }
    return { level: "ok", message: "Key shape looks right. We check it with RunPod next." };
  }

  // Sum the max_workers a provisioning plan asks for. The plan is the control
  // plane's data, not ours.
  function planWorkerTotal(plan) {
    if (!Array.isArray(plan)) return 0;
    return plan.reduce(function (sum, ep) {
      const n = ep && typeof ep.max_workers === "number" ? ep.max_workers : 0;
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
  }

  // Does the plan fit the account's REAL worker quota?
  //
  // RunPod enforces the quota account-wide, at config time, against the sum of
  // max_workers across ALL endpoints on the account (#60, proven against the
  // real validation error). So the room we have is quota minus what the
  // account already spends on its existing endpoints.
  //
  // `quota` and `existingWorkerSum` are the REAL numbers the provisioner read
  // back from RunPod. We never derive them from the published balance table:
  // that table is stale (a $50 account was observed with the full quota of 10),
  // and quoting a funding tier at someone whose account disagrees is exactly
  // the sort of confident wrong number this flow exists to avoid.
  function quotaFit(quota, existingWorkerSum, plan) {
    const q = Number(quota);
    const used = Number(existingWorkerSum) || 0;
    const needed = planWorkerTotal(plan);

    if (!Number.isFinite(q) || q <= 0) {
      return {
        fits: false,
        known: false,
        needed: needed,
        available: null,
        quota: null,
        message:
          "We could not read your account's worker quota from RunPod. We will not guess it, so setup stops here rather than half-building your studio.",
      };
    }

    const available = q - used;
    const fits = available >= needed;

    return {
      fits: fits,
      known: true,
      needed: needed,
      available: available,
      quota: q,
      message: fits
        ? "Your account's real worker quota is " +
          q +
          ". Your existing endpoints use " +
          used +
          ", which leaves " +
          available +
          ". This setup needs " +
          needed +
          ", so it fits."
        : "Your account's real worker quota is " +
          q +
          ". Your existing endpoints already use " +
          used +
          ", which leaves only " +
          available +
          ". This setup needs " +
          needed +
          ". Setup stops here so you do not end up with a half-built studio.",
      // Honest, specific guidance instead of a funding-tier sales pitch.
      guidance: fits
        ? []
        : [
            "Lower the max workers on endpoints you already have, to free up " +
              Math.max(0, needed - available) +
              " more.",
            "Delete RunPod endpoints you no longer use.",
            "Ask RunPod support to raise your account's worker quota.",
          ],
    };
  }

  // Cost ceiling for a render, from wall-clock time and an hourly GPU rate.
  //
  // Deliberately a CEILING and labelled as one everywhere it is shown: the
  // wall-clock we have includes queue time and model-load time, while RunPod
  // bills active worker seconds. The real bill is at or under this. Quoting
  // the number we can actually prove beats quoting a prettier one we cannot.
  function costCeilingUsd(wallClockMs, hourlyRateUsd) {
    const ms = Number(wallClockMs);
    const rate = Number(hourlyRateUsd);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return (ms / 3600000) * rate;
  }

  function formatUsd(amount) {
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    if (amount < 0.01) return "under $0.01";
    return "$" + amount.toFixed(2);
  }

  // Turn the control plane's live scope probe of key B into a verdict.
  //
  // The probes are the #60-proven ones: GET /health must succeed on each of the
  // 4 endpoints we created, AND a graphql call must be DENIED. Both halves
  // matter and they catch different mistakes:
  //   - graphql NOT denied  => they pasted a full/graphql key. It would work
  //     fine, which is exactly the danger: we would be storing account-wide
  //     power forever to save one screen of friction.
  //   - a health failure    => the key is scoped to the wrong endpoints (403).
  // Either way we refuse and never store it. "It works" is not the bar; "it can
  // do only what it needs" is.
  function scopeVerdict(probe) {
    const p = probe || {};
    const health = p.health && typeof p.health === "object" ? p.health : null;
    const failures = [];

    if (p.graphql_denied !== true) {
      failures.push(
        "That key can do more than run your renders: it still has account access. " +
          "This is the one thing we will not store, so we have not kept it. Mint a key with " +
          "the invoke surface only, and api.runpod.io/graphql set to None.",
      );
    }

    if (!health) {
      failures.push("We could not check that key against your endpoints, so we have not stored it.");
    } else {
      const unreachable = Object.keys(health).filter(function (id) { return health[id] !== true; });
      if (unreachable.length) {
        failures.push(
          "That key cannot reach " +
            (unreachable.length === 1 ? "this endpoint" : "these endpoints") +
            ": " +
            unreachable.join(", ") +
            ". Check you gave it Read/Write on all four of the endpoints we just created.",
        );
      }
    }

    return {
      ok: failures.length === 0,
      failures: failures,
      message: failures.length === 0
        ? "That key checks out: it can run jobs on your four endpoints, and nothing else."
        : failures[0],
    };
  }

  function stepIndex(key) {
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i].key === key) return i;
    }
    return -1;
  }

  // Can the flow advance past `key` given what the user has done so far?
  // Gates are honest: the rules gate is blocking (#57), and the review gate
  // will not open on a capacity check that failed or never ran.
  function canAdvance(key, state) {
    const s = state || {};
    if (key === "rules") return s.rulesAccepted === true;
    if (key === "key") return typeof s.keyPresent === "boolean" ? s.keyPresent : false;
    if (key === "capacity") return !!(s.capacity && s.capacity.fits === true);
    if (key === "review") return s.confirmed === true;
    // Nothing goes live on a key whose scope we did not verify.
    if (key === "invoke") return !!(s.invokeVerified === true);
    return true;
  }

  return {
    STEPS: STEPS,
    KEY_PREFIX: KEY_PREFIX,
    keyShapeHint: keyShapeHint,
    scopeVerdict: scopeVerdict,
    planWorkerTotal: planWorkerTotal,
    quotaFit: quotaFit,
    costCeilingUsd: costCeilingUsd,
    formatUsd: formatUsd,
    stepIndex: stepIndex,
    canAdvance: canAdvance,
  };
});
