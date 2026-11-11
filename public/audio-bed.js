// cf#1016: the panel half of deleting an uploaded audio bed.
//
// Pure helpers, no DOM, so tests/audio-bed-delete-1016.test.ts drives them under plain Node, the same
// way finish-degrade.js is tested. planner-audio.js owns the button and the confirm.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.audioBed = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The exact shape POST /api/storyboard/audio-upload mints. The route refuses anything else, so the
  // panel offers the delete only where it can succeed: a generated score is not an upload.
  var UPLOAD_KEY_RE = /^audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|wav|aac|m4a|ogg|webm)$/;

  function isUploadedBedKey(key) {
    return typeof key === "string" && UPLOAD_KEY_RE.test(key);
  }

  /** DELETE URL for an uploaded bed key, or null when the key is not one. */
  function deleteUrl(key) {
    if (!isUploadedBedKey(key)) return null;
    return "/api/storyboard/audio-upload/" + encodeURIComponent(key.slice("audio/".length));
  }

  /** What the panel does with the answer. `unlink` drops the bed from this plan, which is right both
   *  when it was deleted and when it was already gone (a plan pointing at a missing file only fails
   *  later). Anything else keeps the link and says why. */
  function deleteOutcome(status, body) {
    var err = body && typeof body.error === "string" ? body.error : "";
    if (status === 200) return { unlink: true, message: "audio file deleted." };
    if (status === 404) return { unlink: true, message: "that audio file was already gone; unlinked it from this plan." };
    if (status === 409) {
      var ids = body && Array.isArray(body.renders) ? body.renders : [];
      return {
        unlink: false,
        message: "not deleted: a render that has not finished uses this audio" + (ids.length ? " (" + ids.join(", ") + ")" : "") + ". Try again after it ends.",
      };
    }
    return { unlink: false, message: "not deleted: " + (err || "HTTP " + status) };
  }

  return { isUploadedBedKey: isUploadedBedKey, deleteUrl: deleteUrl, deleteOutcome: deleteOutcome };
});
