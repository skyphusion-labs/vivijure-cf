// Make a video (cf#1242): the DEFAULT-STYLE RULE. Which motion door the one-screen page uses, which
// shapes it may offer, and what it tells the person about price. Pure: no DOM, no fetch. It loads as
// a classic <script> on make.html (window.makeStyle) and under plain Node for vitest (module.exports),
// the same wrapper as render-eta.js. docs/make-a-video.md is the prose copy of this rule.
//
// THE RULE, as Conrad ruled it: face CONSISTENCY first, not price.
//
//   1. Only installed motion.backend doors count (GET /api/modules hooks["motion.backend"]).
//   2. Each door gets a face grade, highest wins:
//        3  HOLD   the door itself holds the face, by its own manifest and docs/motion-door-limits.md
//        2  TWO    the door takes a start AND an end still (usage.first_last), so the face is pinned
//                  at both ends of every clip by stills drawn from the cast photos
//        1  ONE    the door animates one start still; the face can wander inside the clip
//        0  DRIFT  docs/motion-door-limits.md says faces drift on this door
//      Only grade 2 and 3 are "consistency grade". A shape that no consistency-grade door can make is
//      not offered at all, rather than silently handed to a grade 1 door.
//   3. A VOICE-FILE door (usage.driving_audio, no usage.native_audio: the mouth follows the person's
//      own Cast voice on every line) is graded HOLD for a plan that talks. The picture is our still,
//      drawn from the cast photos, and only the mouth moves; the voice is the person's own, where the
//      native-audio doors invent one ("Cannot lock the Cast voice sample"). A shot with no line still
//      works: core mints silence for it (core#342, wantsPreClipDialogue). It is NOT eligible before
//      the plan exists or for a plan with no lines, because an all-silent video on it is a still
//      picture. No voice-file door declares an aspect choice and none has proven a frame other than
//      wide (one is "480p only (832x464)", the other says its shape "is unknown until a real
//      render"), so a voice-file door is offered for Wide only. That retires when a door declares an
//      aspect enum.
//   4. When the video has spoken lines, only doors that can speak are eligible. Before the plan
//      exists nobody knows, so the pick is made on face grade alone and redone once the plan is back.
//   5. Ties: the stronger voice lock (the person's own voice, then everything else), then a door
//      that can speak (only while talking is unknown), then ui.order, then name. Price never breaks
//      a tie.
//
// SHAPES. An image-to-video door makes the clip at the shape of its start still (the keyframe
// manifests say so: "Image-to-video backends conform the clip to the KEYFRAME's aspect ratio"). So a
// shape is possible when (a) the stills door can draw at that size inside its declared width/height
// range, and (b) the motion door either declares an aspect enum (ratio / aspect_ratio) that contains
// the shape, or declares none and therefore follows the still.
//
// THE FACE GRADE IS THE DOOR'S OWN WORD (cf#1246). Each motion door declares usage.face_hold
// ("hold" | "two" | "one" | "drift"), so the grade is read, not computed from door names. A door that
// predates the field falls back to the generic facts below (a voice-file door holds, first_last is two,
// else one). The one name left is alibaba-wan-lora's NEED for a trained Wan look, which no manifest
// field states yet; it is declared debt in tests/panel-no-hardcoded-modules.test.ts.
//
// PRICES ARE AT COST (Conrad, 2026-11-05): ui.cost_usd_per_second [low, high] or ui.cost_usd_per_clip
// [{usd, resolution?, seconds?}], the provider's price with nothing added, until an end-user markup is
// set. Each scene is priced at the length the door will really make (clamped to its bounds, rounded up
// to its duration_steps). A missing price is "price unknown", never a guess.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.makeStyle = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var GRADE = { DRIFT: 0, ONE: 1, TWO: 2, HOLD: 3 };
  var CONSISTENT = GRADE.TWO;

  var FACE_HOLD = { hold: GRADE.HOLD, two: GRADE.TWO, one: GRADE.ONE, drift: GRADE.DRIFT };
  // The one door that needs a trained Wan look before it can hold a face. No manifest field says so yet.
  var NEEDS = { "alibaba-wan-lora": "wan_lora" };

  // The three places a video gets posted. Sizes sit inside every stills door's declared range today
  // (512..1536) and the check below re-reads that range rather than trusting it.
  var SHAPES = [
    { id: "vertical", label: "Vertical", hint: "TikTok, Reels, Shorts", ratio: "9:16", width: 768, height: 1344 },
    { id: "square", label: "Square", hint: "Instagram feed", ratio: "1:1", width: 1024, height: 1024 },
    { id: "wide", label: "Wide", hint: "YouTube, TV", ratio: "16:9", width: 1344, height: 768 },
  ];
  var DEFAULT_SHAPE = "vertical";

  // Plain names for the core quality tiers (render.quality_tiers on GET /api/modules).
  var QUALITIES = [
    { id: "draft", label: "Draft", tier: "draft", res: "low" },
    { id: "good", label: "Good", tier: "standard", res: "default" },
    { id: "best", label: "Best", tier: "final", res: "high" },
  ];

  var ASPECT_FIELDS = ["aspect_ratio", "ratio"];
  var RESOLUTION_FIELDS = ["resolution", "size"];

  function usage(mod) {
    return (mod && mod.usage) || {};
  }

  function canSpeak(mod) {
    var u = usage(mod);
    return u.native_audio === true || u.driving_audio === true;
  }

  function voiceFileOnly(mod) {
    var u = usage(mod);
    return u.driving_audio === true && u.native_audio !== true;
  }

  function faceGrade(mod) {
    if (!mod) return GRADE.DRIFT;
    var declared = FACE_HOLD[usage(mod).face_hold];
    if (typeof declared === "number") return declared;
    if (voiceFileOnly(mod)) return GRADE.HOLD;
    return usage(mod).first_last === true ? GRADE.TWO : GRADE.ONE;
  }

  // 1 when the door speaks in the person's own Cast voice (usage.driving_audio), else 0.
  function voiceLock(mod) {
    return usage(mod).driving_audio === true ? 1 : 0;
  }

  function evidence(mod) {
    if (!mod) return "";
    if (typeof FACE_HOLD[usage(mod).face_hold] === "number") return "usage.face_hold: " + usage(mod).face_hold;
    if (voiceFileOnly(mod)) return "usage.driving_audio: our still, mouth only, in the person's own voice";
    return usage(mod).first_last === true
      ? "usage.first_last: a start and an end still on every clip"
      : "one start still per clip";
  }

  function needs(mod) {
    return (mod && NEEDS[mod.name]) || null;
  }

  function schemaField(mod, names) {
    var schema = (mod && mod.config_schema) || {};
    for (var i = 0; i < names.length; i++) {
      var f = schema[names[i]];
      if (f && f.type === "enum" && Array.isArray(f.values)) return { name: names[i], field: f };
    }
    return null;
  }

  function shapeById(id) {
    for (var i = 0; i < SHAPES.length; i++) if (SHAPES[i].id === id) return SHAPES[i];
    return null;
  }

  function inRange(field, n) {
    if (!field || field.type !== "int") return false;
    if (typeof field.min === "number" && n < field.min) return false;
    if (typeof field.max === "number" && n > field.max) return false;
    return true;
  }

  // The stills door that draws the cast. A door that trains the cast's look (trains_loras) keeps faces
  // closest to the photos, so it wins; otherwise the first installed one. Generic, no names.
  function stillsDoor(reg) {
    var mods = modulesFor(reg, "keyframe");
    for (var i = 0; i < mods.length; i++) if (mods[i].trains_loras === true) return mods[i];
    return mods[0] || null;
  }

  function stillsCanDraw(still, shape) {
    if (!still || !shape) return false;
    var schema = still.config_schema || {};
    if (!schema.width || !schema.height) {
      // A stills door with no size knobs draws its own default, so only that default shape works.
      return false;
    }
    return inRange(schema.width, shape.width) && inRange(schema.height, shape.height);
  }

  function doorCanShape(mod, shape) {
    if (!mod || !shape) return false;
    var aspect = schemaField(mod, ASPECT_FIELDS);
    if (!aspect && voiceFileOnly(mod)) return shape.id === "wide"; // see rule 3
    if (!aspect) return true; // follows the still
    return aspect.field.values.indexOf(shape.ratio) !== -1;
  }

  function modulesFor(reg, hook) {
    var names = (reg && reg.hooks && reg.hooks[hook]) || [];
    var mods = (reg && reg.modules) || [];
    var out = [];
    for (var i = 0; i < names.length; i++) {
      for (var j = 0; j < mods.length; j++) {
        if (mods[j] && mods[j].name === names[i]) {
          out.push(mods[j]);
          break;
        }
      }
    }
    return out;
  }

  // host.wanTrainable: GET /api/cast wan_lora_trainable. host.wanReady: every chosen person already
  // has the trained look for that door. Either one makes the door usable.
  // host.voicesReady === false: some person cannot be bound to the video, so the studio would speak
  // their line in its one default voice; a voice-file door then loses its whole point and is skipped.
  function usable(mod, host) {
    if (voiceFileOnly(mod) && host && host.voicesReady === false) return false;
    if (needs(mod) === "wan_lora") {
      var h = host || {};
      return h.wanTrainable === true || h.wanReady === true;
    }
    return true;
  }

  function candidates(reg, opts) {
    var o = opts || {};
    var shape = shapeById(o.shape || DEFAULT_SHAPE);
    var still = stillsDoor(reg);
    if (!shape || !stillsCanDraw(still, shape)) return [];
    var out = [];
    var doors = modulesFor(reg, "motion.backend");
    for (var i = 0; i < doors.length; i++) {
      var m = doors[i];
      if (faceGrade(m) < CONSISTENT) continue;
      if (voiceFileOnly(m) && o.talks !== true) continue;
      if (o.talks === true && !canSpeak(m)) continue;
      if (!doorCanShape(m, shape)) continue;
      if (!usable(m, o.host)) continue;
      out.push(m);
    }
    var talkUnknown = o.talks !== true && o.talks !== false;
    out.sort(function (a, b) {
      var g = faceGrade(b) - faceGrade(a);
      if (g) return g;
      var v = voiceLock(b) - voiceLock(a);
      if (v) return v;
      if (talkUnknown) {
        var s = (canSpeak(b) ? 1 : 0) - (canSpeak(a) ? 1 : 0);
        if (s) return s;
      }
      var oa = a.ui && typeof a.ui.order === "number" ? a.ui.order : 1e9;
      var ob = b.ui && typeof b.ui.order === "number" ? b.ui.order : 1e9;
      if (oa !== ob) return oa - ob;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }

  // The shapes this host can make with a consistency-grade door. talks follows the same rule.
  function offeredShapes(reg, opts) {
    var o = opts || {};
    var out = [];
    for (var i = 0; i < SHAPES.length; i++) {
      var c = candidates(reg, { shape: SHAPES[i].id, talks: o.talks, host: o.host });
      if (c.length) out.push(SHAPES[i]);
    }
    return out;
  }

  // The qualities this host offers, in the order Draft, Good, Best, from render.quality_tiers.
  function offeredQualities(reg) {
    var tiers = (reg && reg.render && reg.render.quality_tiers) || [];
    var have = {};
    for (var i = 0; i < tiers.length; i++) if (tiers[i] && tiers[i].value) have[tiers[i].value] = true;
    var out = [];
    for (var j = 0; j < QUALITIES.length; j++) if (have[QUALITIES[j].tier]) out.push(QUALITIES[j]);
    return out;
  }

  function qualityById(id) {
    for (var i = 0; i < QUALITIES.length; i++) if (QUALITIES[i].id === id) return QUALITIES[i];
    return null;
  }

  function resNumber(v) {
    var m = String(v).match(/(\d+)/);
    if (!m) return 0;
    var n = Number(m[1]);
    return /k$/i.test(String(v)) ? n * 1000 : n;
  }

  // Which resolution value a quality asks the door for, and where it sits in the door's own range.
  // Returns null when the door has no resolution choice.
  function resolutionFor(mod, quality) {
    var r = schemaField(mod, RESOLUTION_FIELDS);
    if (!r) return null;
    var values = r.field.values.slice().sort(function (a, b) { return resNumber(a) - resNumber(b); });
    var q = qualityById(quality) || qualityById("good");
    var value;
    if (q.res === "low") value = values[0];
    else if (q.res === "high") value = values[values.length - 1];
    else value = r.field.default !== undefined ? r.field.default : values[0];
    var pos = value === values[0] ? "low" : value === values[values.length - 1] ? "high" : "middle";
    return { field: r.name, value: value, pos: pos };
  }

  // The length a door really makes for a planned scene: inside its bounds, then up to its next step.
  function doorSeconds(mod, seconds) {
    var u = usage(mod);
    var s = seconds;
    if (typeof u.max_seconds === "number" && s > u.max_seconds) s = u.max_seconds;
    if (typeof u.min_seconds === "number" && s < u.min_seconds) s = u.min_seconds;
    var steps = Array.isArray(u.duration_steps) ? u.duration_steps.slice().sort(function (a, b) { return a - b; }) : [];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= s) return steps[i];
    return steps.length ? steps[steps.length - 1] : s;
  }

  function perClip(mod) {
    var list = mod && mod.ui && mod.ui.cost_usd_per_clip;
    if (!Array.isArray(list) || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (!list[i] || !(typeof list[i].usd === "number" && list[i].usd > 0)) return null;
    return list;
  }

  function rate(mod) {
    var r = mod && mod.ui && mod.ui.cost_usd_per_second;
    if (!Array.isArray(r) || r.length !== 2) return null;
    if (!r.every(function (x) { return typeof x === "number" && x > 0; })) return null;
    return r;
  }

  // The price of the clips, from the door's own stated rate (the figure the planner's spend confirm
  // uses). cost_usd_per_second is [lowest resolution, highest resolution], so a quality that asks for
  // the lowest resolution is priced at the first figure, the highest at the second, and anything in
  // between at the second as an upper bound ("up to"). A door with no rate, or no length yet, is
  // "unknown". Never a guess.
  // `seconds` is either a number (the total, the older form) or a list of each scene's planned seconds,
  // which is priced scene by scene at the length the door really makes.
  function clipPrice(mod, seconds, quality) {
    var list = Array.isArray(seconds) ? seconds : null;
    var clips = perClip(mod);
    if (clips) {
      if (!list || !list.length) return { usd: null, kind: "per_clip" };
      var picked = resolutionFor(mod, quality);
      var total = 0;
      for (var c = 0; c < list.length; c++) {
        var len = doorSeconds(mod, list[c]);
        var hit = null;
        for (var k = 0; k < clips.length; k++) {
          var e = clips[k];
          if (e.resolution !== undefined && (!picked || e.resolution !== picked.value)) continue;
          if (e.seconds !== undefined && e.seconds !== len) continue;
          hit = e;
          break;
        }
        if (!hit) return { usd: null, kind: "unknown" };
        total += hit.usd;
      }
      return { usd: Number(total.toFixed(2)), kind: "about" };
    }
    var r = rate(mod);
    if (!r) return { usd: null, kind: "unknown" };
    if (list) {
      var sum = 0;
      for (var j = 0; j < list.length; j++) sum += doorSeconds(mod, list[j]);
      seconds = sum;
    }
    var res = resolutionFor(mod, quality);
    var low = res ? res.pos === "low" : false;
    var exact = res ? res.pos !== "middle" : false;
    var perSecond = low ? r[0] : r[1];
    if (!(seconds > 0)) return { usd: null, kind: "per_second", perSecond: perSecond, exact: exact };
    return { usd: Number((perSecond * seconds).toFixed(2)), kind: exact ? "about" : "up_to", perSecond: perSecond, exact: exact };
  }

  // Each scene's planned seconds, the same ones the render submit sends.
  function sceneSeconds(board) {
    var scenes = (board && Array.isArray(board.scenes)) ? board.scenes : [];
    var clip = board && typeof board.clip_seconds === "number" && board.clip_seconds > 0 ? board.clip_seconds : 4;
    var out = [];
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i];
      if (!s || typeof s.prompt !== "string" || !s.prompt.trim()) continue;
      out.push(typeof s.target_seconds === "number" && s.target_seconds > 0 ? s.target_seconds : clip);
    }
    return out;
  }

  // The door's own price line, at cost, for a door card: "$0.04 to $0.07 a second" or "from $0.28 a
  // clip", plus the day it was read. "Price unknown" when the door states none.
  function rateLine(mod) {
    // Cents, or a tenth of a cent when the provider prices that finely ($0.157).
    var money = function (n) { var s = n.toFixed(3); return "$" + (s.charAt(s.length - 1) === "0" ? n.toFixed(2) : s); };
    var asOf = mod && mod.ui && typeof mod.ui.cost_as_of === "string" ? asOfText(mod.ui.cost_as_of) : "";
    var r = rate(mod);
    if (r) return (r[0] === r[1] ? money(r[0]) : money(r[0]) + " to " + money(r[1])) + " a second, at cost" + asOf;
    var clips = perClip(mod);
    if (clips) {
      var low = clips.reduce(function (m, e) { return Math.min(m, e.usd); }, Infinity);
      return (clips.length > 1 ? "from " : "") + money(low) + " a clip, at cost" + asOf;
    }
    return "Price unknown";
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function asOfText(day) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m || !MONTHS[Number(m[2]) - 1]) return "";
    return " (price as of " + MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1] + ")";
  }

  // Length of a planned board: the same seconds the planner's render submit sends.
  function boardSeconds(board) {
    var scenes = (board && Array.isArray(board.scenes)) ? board.scenes : [];
    var clip = board && typeof board.clip_seconds === "number" && board.clip_seconds > 0 ? board.clip_seconds : 4;
    var total = 0;
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i];
      if (!s || typeof s.prompt !== "string" || !s.prompt.trim()) continue;
      total += typeof s.target_seconds === "number" && s.target_seconds > 0 ? s.target_seconds : clip;
    }
    return total;
  }

  function hasSpokenLines(board) {
    var scenes = (board && Array.isArray(board.scenes)) ? board.scenes : [];
    for (var i = 0; i < scenes.length; i++) {
      var d = scenes[i] && scenes[i].dialogue;
      if (d && String(d.text || "").trim()) return true;
    }
    return false;
  }

  function priceText(p) {
    if (!p || p.usd === null) return "price unknown";
    var money = "$" + p.usd.toFixed(2);
    return p.kind === "up_to" ? "up to " + money : "about " + money;
  }

  function styleLine(mod) {
    if (!mod) return "";
    if (voiceFileOnly(mod)) return "Talking in their own voices, faces locked";
    var grade = faceGrade(mod);
    var talk = canSpeak(mod) ? "Talking" : "No talking";
    return talk + (grade >= GRADE.HOLD ? ", faces locked" : ", consistent faces");
  }

  // The one call the page makes. Returns null when nothing qualifies.
  function chooseStyle(reg, opts) {
    var o = opts || {};
    var list = candidates(reg, o);
    if (!list.length) return null;
    var door = list[0];
    var shape = shapeById(o.shape || DEFAULT_SHAPE);
    var still = stillsDoor(reg);
    var motionConfig = {};
    var aspect = schemaField(door, ASPECT_FIELDS);
    if (aspect) motionConfig[aspect.name] = shape.ratio;
    var res = resolutionFor(door, o.quality);
    if (res) motionConfig[res.field] = res.value;
    var stillConfig = { width: shape.width, height: shape.height };
    return {
      door: door,
      still: still,
      shape: shape,
      grade: faceGrade(door),
      evidence: evidence(door),
      needs: needs(door),
      line: styleLine(door),
      motionConfig: motionConfig,
      stillConfig: stillConfig,
    };
  }

  return {
    GRADE: GRADE,
    SHAPES: SHAPES,
    QUALITIES: QUALITIES,
    DEFAULT_SHAPE: DEFAULT_SHAPE,
    FACE_HOLD: FACE_HOLD,
    faceGrade: faceGrade,
    canSpeak: canSpeak,
    voiceLock: voiceLock,
    stillsDoor: stillsDoor,
    candidates: candidates,
    offeredShapes: offeredShapes,
    offeredQualities: offeredQualities,
    resolutionFor: resolutionFor,
    clipPrice: clipPrice,
    priceText: priceText,
    boardSeconds: boardSeconds,
    sceneSeconds: sceneSeconds,
    doorSeconds: doorSeconds,
    rateLine: rateLine,
    hasSpokenLines: hasSpokenLines,
    styleLine: styleLine,
    chooseStyle: chooseStyle,
  };
});
