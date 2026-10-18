#!/usr/bin/env python3
"""Validate handoff files against references/schema.json (in the skill folder).

  python3 validate.py <file.handoff.json> [more files]

With the Python package `jsonschema` the whole schema is checked. If this Python
does not have it, the script looks for a venv that does and runs again inside it:
  $HANDOFF_VENV, ~/.config/handoff/venv, ~/.claude/handoff/venv
With no `jsonschema` anywhere it falls back to a basic check (valid JSON, the
required top-level keys, no unknown top-level keys) and says so.

Exit 0 and "ok" when valid; exit 1 and one line per problem otherwise.
"""
import json
import os
import pathlib
import sys

SCHEMA = pathlib.Path(__file__).resolve().parent.parent / "references" / "schema.json"


def venv_pythons():
    candidates = []
    if os.environ.get("HANDOFF_VENV"):
        candidates.append(pathlib.Path(os.environ["HANDOFF_VENV"]).expanduser())
    candidates.append(pathlib.Path.home() / ".config" / "handoff" / "venv")
    candidates.append(pathlib.Path.home() / ".claude" / "handoff" / "venv")
    for venv in candidates:
        for rel in ("bin/python", "Scripts/python.exe"):
            python = venv / rel
            if python.exists():
                yield str(python)


def load_jsonschema():
    try:
        import jsonschema  # noqa: PLC0415

        return jsonschema
    except ImportError:
        pass
    if not os.environ.get("HANDOFF_VALIDATE_REEXEC"):
        for python in venv_pythons():
            os.environ["HANDOFF_VALIDATE_REEXEC"] = "1"
            os.execv(python, [python, __file__, *sys.argv[1:]])
    return None


def basic_problems(doc, schema):
    if not isinstance(doc, dict):
        return ["(root): a handoff is a JSON object"]
    problems = [f"(root): '{key}' is a required property" for key in schema.get("required", []) if key not in doc]
    known = schema.get("properties", {})
    problems += [f"(root): unknown top-level key '{key}'" for key in doc if key not in known]
    return problems


def main(paths):
    schema = json.loads(SCHEMA.read_text())
    jsonschema = load_jsonschema()
    validator = jsonschema.Draft202012Validator(schema) if jsonschema else None
    if validator is None:
        print("note: the Python package jsonschema is not installed, so only a basic check runs (valid JSON, required and known top-level keys).")

    failed = False
    for path in paths:
        try:
            doc = json.loads(pathlib.Path(path).read_text())
        except (OSError, json.JSONDecodeError) as err:
            print(f"{path}: cannot read as JSON: {err}")
            failed = True
            continue
        if validator is not None:
            errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
            problems = [f"{'/'.join(str(p) for p in e.path) or '(root)'}: {e.message}" for e in errors]
        else:
            problems = basic_problems(doc, schema)
        if problems:
            failed = True
            for problem in problems:
                print(f"{path}: {problem}")
        else:
            print(f"{path}: ok" + ("" if validator is not None else " (basic check only)"))
    return 1 if failed else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    sys.exit(main(args))
