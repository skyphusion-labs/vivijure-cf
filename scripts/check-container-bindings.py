#!/usr/bin/env python3
"""Container class contract for wrangler.toml.example.

Every [[containers]] class_name must match a [[durable_objects.bindings]]
class_name, and every container class must be declared by a migration
(new_classes or new_sqlite_classes). Parsing is tomllib, stdlib from 3.11.

Python 3.9 has no TOML parser. An inline import whose error was discarded
reported nothing wrong (fleet-chezmoi#2291). A missing parser, or a python
older than 3.11, exits non-zero and names the version it found and the
minimum it needs. It does not skip, and it does not search PATH for a newer
interpreter: the one that was invoked is the one being judged.

    python3 scripts/check-container-bindings.py [wrangler.toml.example]
"""

import sys

MINIMUM = (3, 11)
MINIMUM_TEXT = "3.11"


def found_version():
    return "%d.%d.%d" % sys.version_info[:3]


def refuse_interpreter(reason):
    sys.stderr.write(
        "::error::check-container-bindings: %s. "
        "Found python %s; minimum python >= %s. "
        "A missing parser is a failure, not a skip.\n"
        % (reason, found_version(), MINIMUM_TEXT)
    )
    raise SystemExit(1)


def load_parser():
    """Return tomllib, or refuse. Older than 3.11 is fatal even if a third-party
    parser happens to be installed: the contract is the stdlib, not a package."""
    too_old = sys.version_info < MINIMUM
    parser = None
    try:
        import tomllib
        parser = tomllib
    except ImportError:
        parser = None
    if too_old or parser is None:
        bits = []
        if too_old:
            bits.append("interpreter is older than %s" % MINIMUM_TEXT)
        if parser is None:
            bits.append("no tomllib, so this interpreter cannot parse TOML")
        refuse_interpreter("cannot parse TOML (%s)" % "; ".join(bits))
    return parser


def die(msg):
    sys.stderr.write("::error::check-container-bindings: %s\n" % msg)
    raise SystemExit(1)


def _class_names(doc):
    bindings = []
    durable = doc.get("durable_objects") or {}
    if isinstance(durable, dict):
        bindings = durable.get("bindings") or []
    dob = set()
    if isinstance(bindings, list):
        for binding in bindings:
            if isinstance(binding, dict) and isinstance(binding.get("class_name"), str):
                dob.add(binding["class_name"])
    declared = set()
    migrations = doc.get("migrations") or []
    if isinstance(migrations, list):
        for migration in migrations:
            if not isinstance(migration, dict):
                continue
            for key in ("new_sqlite_classes", "new_classes"):
                values = migration.get(key) or []
                if isinstance(values, list):
                    for value in values:
                        if isinstance(value, str):
                            declared.add(value)
    return dob, declared


def contract_errors(doc):
    containers = doc.get("containers") or []
    if not isinstance(containers, list) or not containers:
        return ["no [[containers]] block; refusing to report a pass over an empty set"]
    dob, declared = _class_names(doc)
    errors = []
    for entry in containers:
        if not isinstance(entry, dict):
            errors.append("a [[containers]] entry is not a table")
            continue
        class_name = entry.get("class_name")
        if not isinstance(class_name, str) or not class_name:
            errors.append("a [[containers]] block has no class_name")
            continue
        if class_name not in dob:
            errors.append("container class_name %s has no matching DO binding" % class_name)
        if class_name not in declared:
            errors.append("container class %s is not declared by a migration" % class_name)
    return errors


def main(argv):
    parser = load_parser()
    if len(argv) > 2:
        die("usage: check-container-bindings.py [wrangler.toml]")
    if len(argv) == 2:
        path = argv[1]
    else:
        # Default is the example next to this script's repo root, not cwd: a
        # check run from somewhere else must not pass by failing to find the file.
        import os
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "wrangler.toml.example")
    try:
        handle = open(path, "rb")
    except OSError as exc:
        die("cannot read %s: %s" % (path, exc))
    try:
        try:
            doc = parser.load(handle)
        except parser.TOMLDecodeError as exc:
            die("TOML parse error in %s: %s" % (path, exc))
    finally:
        handle.close()
    if not isinstance(doc, dict):
        die("%s did not parse to a table" % path)
    errors = contract_errors(doc)
    if errors:
        for error in errors:
            sys.stderr.write("::error::check-container-bindings: %s\n" % error)
        raise SystemExit(1)
    print("checked %s" % path)
    print("CONTRACT OK: every container class_name has a matching durable_objects binding")
    print("CONTRACT OK: every container class is declared by a migration")
    return 0


if __name__ == "__main__":
    main(sys.argv)
