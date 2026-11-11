"""One process image for the four join services. CPU_APP selects which app listens."""
import os
import runpy
import sys

APPS = {
    "video-finish": "/app/video-finish",
    "audio-beat-sync": "/app/audio-beat-sync",
    "audio-mix": "/app/audio-mix",
    "audio-master": "/app/audio-master",
}


def main() -> None:
    name = os.environ.get("CPU_APP", "").strip()
    root = APPS.get(name)
    if root is None:
        sys.stderr.write("CPU_APP must be one of: %s\n" % ", ".join(sorted(APPS)))
        raise SystemExit(2)
    os.chdir(root)
    sys.path.insert(0, root)
    runpy.run_path(os.path.join(root, "app.py"), run_name="__main__")


if __name__ == "__main__":
    main()
