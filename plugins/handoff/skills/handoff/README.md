# Handoff skill

**Version:** 3 · **Created:** 2026-10-16 16:34 · **Updated:** 2026-10-16 16:46

A Claude Code skill that writes a handoff for the current session as a JSON file, so a fresh session can pick the work up. Given the path to a handoff, it resumes from it.

- `/handoff [what the next session is for]` writes the file, checks it against `schema.json`, and prints its path plus a one-line prompt to paste into the new session.
- Files are saved where `config.json` says, or the skill asks for a folder once and offers to remember it.
- In the Claude desktop app it then offers the continuation as a launch card, with a model and effort that you pick or that the handoff recommends (`next_session`). A card cannot start a session on a higher model or effort than the one that wrote the handoff, so for a stronger model it becomes a gate: the new session first asks you to switch the model in the menu and waits for your "go". Without the app, the skill prints the one-line prompt and says which model to open it on.
- Everything in a handoff is written in English. Copy that must be reused as written (app, website or document text) goes unchanged into `verbatim_copy`.

## Prerequisites

| Requirement | Status | Why it is needed |
| --- | --- | --- |
| Claude Code | required | Runs the skill. |
| Python 3 | required | The skill checks every handoff with it, with or without `jsonschema`. |
| `jsonschema` (Python package) | **strongly recommended** | Full check of each handoff against `schema.json`. See below. |
| git | optional | Fills `environment` with the branch, commit and uncommitted files. Without git the skill leaves those out. |

Tested on macOS with Python 3.14 and `jsonschema` 4.26. Other systems are untested; on Windows the venv's Python is at `venv\Scripts\python.exe`.

## Install the schema check (strongly recommended)

`schema.json` is the contract between the session that writes a handoff and the session that reads it. With `jsonschema` installed, each write is checked, and the skill fixes problems before it gives you the path. Without it, a handoff with a missing `next_step` or a wrong type is saved without a complaint, and the next session finds out when it tries to resume. In that case the skill only checks that the file is valid JSON and has the required top-level keys, and it says the full check was skipped.

Install it into a venv, not into the system Python. Homebrew and many Linux distributions refuse a global `pip install` (PEP 668).

```bash
python3 -m venv ~/.claude/handoff/venv
~/.claude/handoff/venv/bin/python -m pip install jsonschema
```

Check that it works against any handoff file:

```bash
~/.claude/handoff/venv/bin/python <skill folder>/validate.py path/to/file.handoff.json
```

A valid file prints `<path>: ok`. An invalid one prints one line per problem and exits with code 1.

The venv path is fixed because the skill looks for it there. Keep it at `~/.claude/handoff/venv` and every session on the machine uses it.

## Where handoffs are saved

The skill reads the folder rule from `$HANDOFF_CONFIG`, then from `~/.claude/handoff/config.json`. With no config it asks once and offers to write one. Minimal config:

```json
{
  "version": 1,
  "mode": "fixed",
  "root": "~/handoffs",
  "layout": "{project}/{yyyy}-{mm}/{yymmdd}-{hhmm}-{topic}.handoff.json",
  "index": true
}
```

`mode: "ask"` asks for the folder every time. `index: true` appends one line per handoff to `<root>/INDEX.jsonl`, which is how "continue the last handoff" finds the latest file. The skill never saves into the current workspace, a session's scratch folder, or a path inside a git repository without asking first. The full rules are in `SKILL.md`.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | The skill's instructions. |
| `schema.json` | The structure of a handoff. The authority. |
| `validate.py` | Checks a handoff against the schema. Needs `jsonschema`. |
| `config.example.json` | Example folder rule. |
