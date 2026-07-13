#!/usr/bin/env python3
"""Retarget vivijure-cf shim imports to @skyphusion-labs/vivijure-core/*."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = "@skyphusion-labs/vivijure-core"

SHIMS = [
    "modules/types",
    "modules/conformance",
    "modules/registry",
    "modules/render-pipeline",
    "film-model",
    "clip-job-model",
    "storyboard-ids",
    "film-orchestrator",
    "render-orchestrator",
    "clip-validate",
    "render-module-config",
    "runpod-types",
    "clip-content-validate",
    "cast-db",
    "storyboard-projects-db",
    "renders-db",
    "render-log",
    "public-id",
    "db-env",
    "d1-retry",
    "film-advance-lease",
    "bundle-assembler",
    "bundle-durations",
    "storyboard-validate",
    "planner-yaml",
    "key-safety",
    "lora-keys",
    "preflight",
    "planner-prompt",
    "output-extract",
    "scatter-orchestrator",
    "scatter-orchestrator-types",
    "scatter",
    "scatter-notify",
    "beat-analyze",
    "audio-stage",
    "audio-routing",
    "operator-config",
    "dialogue-lines",
    "cast-loras",
    "cast-lora-train",
    "lora-bundle",
    "runpod-submit",
    "render-sweep",
    "render-adopt",
    "render-mux",
    "clip-provenance",
    "bundle-storyboard",
    "captions",
    "srt",
    "finish-hash",
    "voices",
    "secret-store",
    "tar",
    "tar-emit",
]

# Longest paths first so modules/types wins over types if both existed.
SHIMS.sort(key=len, reverse=True)


def core_target(shim: str) -> str:
    if shim == "tar-emit":
        return f"{PKG}/tar"
    return f"{PKG}/{shim}"


def rewrite_text(text: str) -> tuple[str, int]:
    changes = 0
    for shim in SHIMS:
        target = core_target(shim)
        patterns = [
            (
                re.compile(
                    rf'from\s+(["\'])(?:\./|\.\./src/){re.escape(shim)}(?:\.js)?\1'
                ),
                f'from "{target}"',
            ),
            (
                re.compile(
                    rf'import\(\s*(["\'])(?:\./|\.\./src/){re.escape(shim)}(?:\.js)?\1\s*\)'
                ),
                f'import("{target}")',
            ),
            (
                re.compile(
                    rf'vi\.mock\(\s*(["\'])(?:\./|\.\./src/){re.escape(shim)}(?:\.js)?\1'
                ),
                f'vi.mock("{target}"',
            ),
        ]
        for pat, repl in patterns:
            text, n = pat.subn(repl, text)
            changes += n
    return text, changes


def main() -> None:
    total = 0
    for path in sorted(ROOT.rglob("*.ts")):
        if "node_modules" in path.parts:
            continue
        original = path.read_text()
        updated, n = rewrite_text(original)
        if n:
            path.write_text(updated)
            total += n
            print(f"{path.relative_to(ROOT)}: {n}")
    print(f"rewired {total} import sites")


if __name__ == "__main__":
    main()
