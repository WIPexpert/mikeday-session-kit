#!/usr/bin/env python3
"""Validate a handoff file against schema.json (next to this script).

Run with the shared venv that has jsonschema:
  ~/.claude/handoff/venv/bin/python <skill folder>/validate.py <file.handoff.json>

Exit 0 and "ok" when valid; exit 1 and one line per problem otherwise.
"""
import json
import pathlib
import sys

import jsonschema

schema_path = pathlib.Path(__file__).with_name("schema.json")
schema = json.loads(schema_path.read_text())
validator = jsonschema.Draft202012Validator(schema)

for arg in sys.argv[1:] or ["--help"]:
    if arg in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

failed = False
for arg in sys.argv[1:]:
    doc = json.loads(pathlib.Path(arg).read_text())
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
    if errors:
        failed = True
        for e in errors:
            where = "/".join(str(p) for p in e.path) or "(root)"
            print(f"{arg}: {where}: {e.message}")
    else:
        print(f"{arg}: ok")

sys.exit(1 if failed else 0)
