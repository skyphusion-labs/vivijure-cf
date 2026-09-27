// FinishContainer: the Durable Object that fronts the video-finish Cloudflare Container.
//
// Paired 1:1 with the [[containers]] and [[durable_objects.bindings]] blocks in
// wrangler.toml.example (class_name "FinishContainer", binding FINISH_CONTAINER) and with
// FINISH_CONTAINER in src/env.ts. All four move together: `wrangler deploy` REJECTS a Durable
// Object binding whose class is not exported from the entrypoint, so declaring the binding
// without exporting the class arms a deploy failure that only fires at the next `v*` tag, in
// studio-release.yml's `wrangler deploy --dry-run` bundle step. That takes the whole studio
// release down, and it lands on whoever tags next for an unrelated reason. Do not split them.
//
// This class is deliberately MINIMAL. The base `Container.fetch()` already forwards the request
// to the container on `defaultPort`, so a passthrough needs no code of our own, and the finish
// tier's own HTTP surface (/async/finish, /async/status/{jobId}, /finish, /inspect) is unchanged.
// The chunked-assemble job loop, `renewActivityTimeout()` and externalised job state are #784.

import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

export class FinishContainer extends Container<Env> {
  // containers/video-finish/Dockerfile sets ENV PORT=8000 and app.py binds 0.0.0.0:8000.
  defaultPort = 8000;

  // sleepAfter is the IDLE timeout, and for this stage it is a contract with the job loop, not a
  // free knob.
  //
  // Why it is not short: /async/finish returns immediately, so NO request is in flight while the
  // encode runs. Incoming requests reset this timer automatically; background work does not. The
  // job loop must therefore call renewActivityTimeout() (#784). Without that call the container
  // sleeps under its own running job, and because container disk is ephemeral and reset to the
  // image on wake, the work dir dies with it and the next poll finds nothing. A 30-60s value
  // (which fleet-chezmoi#2234 recommended for one-shot stages, and which was my error) would
  // make that near-certain.
  //
  // Why it is not huge either. Memory and disk bill on PROVISIONED size for the whole time an
  // instance is awake, and standard-4 provisions 12 GiB. At the published rates that idle tail is
  // about 12 * 600 * 0.0000025 = USD 0.018 in memory plus USD 0.0008 in disk per wake, which is
  // already the same order as the active cost of a 300-second assemble. Every extra minute here
  // is paid on every render and buys nothing, because these jobs are one-shot and never need to
  // stay warm between films.
  //
  // THE REQUIREMENT THIS IMPLIES, stated so it is not discovered the hard way: the job loop must
  // renew MORE OFTEN than this value. If a single chunk batch can run longer than 10 minutes,
  // renew inside the batch (on ffmpeg progress), not only between batches.
  sleepAfter = "10m";
}
