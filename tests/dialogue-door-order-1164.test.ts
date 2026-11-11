// vivijure-cf#1164: the core takes the first `dialogue` door by ui.order, then name. A tie lets chatterbox
// win on the alphabet, and its queued /runsync jobs then fail every spoken film. dialogue-gen is the default
// door until chatterbox handles its queue.
import { describe, expect, it } from "vitest";
import dialogueGen from "../modules/dialogue-gen/src/index";
import chatterbox from "../modules/chatterbox/src/index";

async function order(worker: { fetch: (...args: never[]) => unknown }): Promise<number> {
  const res = (await (worker.fetch as (r: Request, e: unknown) => Promise<Response>)(
    new Request("https://m/module.json"),
    {},
  ));
  const manifest = (await res.json()) as { ui: { order: number } };
  return manifest.ui.order;
}

describe("the default dialogue door", () => {
  it("is dialogue-gen, by a strictly lower ui.order", async () => {
    expect(await order(dialogueGen as never)).toBeLessThan(await order(chatterbox as never));
  });
});
