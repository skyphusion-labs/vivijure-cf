// vivijure-cf#879: this host invokes module hooks of its own (plan.enhance, image.generate, cast.image,
// score, the voice-sample motion call). Each goes through core's invokeRegistered, so an install-scope
// config field is the operator's stored value on every hook, as it is inside the core orchestrators.
// A direct invokeModule call in src/ would skip that, so this fails on one.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chatImageViaModule } from "../src/chat-image-module";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";

const SRC = join(__dirname, "..", "src");
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const FILES = tsFiles(SRC).map((p) => ({ rel: relative(SRC, p), text: code(readFileSync(p, "utf8")) }));

describe("the host's hook invokes go through invokeRegistered", () => {
  it("CONTROL: the sweep reads src and finds the wrapper in use", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.filter((f) => /\binvokeRegistered\s*[<(]/.test(f.text)).length).toBeGreaterThanOrEqual(5);
  });
  it("no file in src/ calls invokeModule directly", () => {
    expect(FILES.filter((f) => /\binvokeModule\s*[<(]/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });
});

describe("an install-scope field reaches a host-invoked hook as the operator set it", () => {
  it("image.generate gets the stored value, and reads it under the module name", async () => {
    const bodies: Record<string, unknown>[] = [];
    const reads: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (name: string) => ({
            all: async () => {
              reads.push(`${name}|${sql.includes("operator_module_config")}`);
              return { results: [{ field_key: "region", value_json: JSON.stringify("eu") }] };
            },
          }),
        }),
      },
      MODULE_IMG: {
        fetch: async (_u: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true, output: { images: [] } }), { status: 200 });
        },
      },
    };
    const mod = {
      name: "img-gen", version: "1.0.0", api: "vivijure-module/2", binding: "MODULE_IMG", hooks: ["image.generate"],
      config_schema: {
        model: { type: "enum", values: ["m1"], default: "m1" },
        region: { type: "enum", values: ["us", "eu"], default: "us", scope: "install" },
      },
    } as unknown as RegisteredModule;
    await chatImageViaModule(env as never, [mod], { model: "m1", user_input: "a cat" });
    expect(bodies).toHaveLength(1);
    expect((bodies[0].config as Record<string, unknown>).region).toBe("eu");
    expect(reads).toEqual(["img-gen|true"]);
  });
});
