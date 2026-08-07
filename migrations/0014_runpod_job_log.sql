-- Durable per-job record of every RunPod job a module worker submits and polls (cf#279).
--
-- WHY THIS EXISTS. A module holds the RunPod job id and the terminal reason at the exact moment a job
-- ends and, before this table, wrote neither. RunPod cannot enumerate jobs (the whole surface is
-- /run, /status, /stream, /cancel, /retry, /purge-queue, /health, and /status is by id only), so an
-- id we do not keep is unreachable permanently. The `renders` table does not close the gap: its
-- job_id was historically written only for jobs the CORE submitted to a single render endpoint, and
-- the CORE no longer submits to RunPod at all (every /run submitter is a module worker). Module-
-- submitted jobs (keyframe, own-gpu, musetalk, video-upscale, audio-upscale, finish-*, ...) are
-- exactly the population this table was added for (cf#279, cf#315).
--
-- WHY A SUBMIT ROW AND NOT ONLY A FAILURE ROW. cf#277 asks for a failure RATE per endpoint. A rate
-- needs a denominator, and the endpoint health counters cannot supply one: they bucket four terminal
-- statuses into two, and completed + failed excludes CANCELLED, which the modules produce
-- deliberately (the F17 spend-leak cancel). Rows only for failures would answer "how many of these
-- did we see" and not "out of how many", which is the question.
--
-- CONTENT. Ids and machine-generated labels only: the RunPod job id, the module name (a compile-time
-- constant in the module worker, and already published in its /module.json), an outcome from a closed
-- set, and two timestamps. `detail` is the backend error string, bounded, held to exactly the standard
-- `renders.error` is already held to in this same database. The RunPod ENDPOINT id is deliberately NOT
-- stored: it arrives from the Secrets Store and the module /ready probe reports it as a boolean and
-- never as a value, so writing it here would break that convention for no gain. The module name maps
-- to the endpoint through the module wrangler.toml, which is public in the repo.
--
-- Additive (CREATE TABLE + CREATE INDEX only) -> rides the normal auto-apply; no manual gate.
CREATE TABLE IF NOT EXISTS runpod_job_log (
  job_id       TEXT PRIMARY KEY,               -- RunPod job id; the upsert key
  module       TEXT NOT NULL,                  -- module worker name, e.g. finish-upscale
  outcome      TEXT NOT NULL,                  -- submitted|completed|backend-error|failed|gone
  detail       TEXT,                           -- bounded backend error text; NULL unless a fault
  submitted_at INTEGER,                        -- unix seconds; NULL only when a legacy poll token
                                               -- carried no submit time (never a fabricated value)
  terminal_at  INTEGER                         -- unix seconds; NULL while outcome is submitted
);

-- The cf#277 query shape: group by module over a recent window.
CREATE INDEX IF NOT EXISTS idx_runpod_job_log_module_submitted
  ON runpod_job_log (module, submitted_at);
