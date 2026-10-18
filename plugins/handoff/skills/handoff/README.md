# Handoff skill

**Version:** 4 · **Created:** 2026-10-16 16:34 · **Updated:** 2026-10-18 12:34

An Agent Skill that writes a handoff for the current session as a JSON file, so a fresh session can pick the work up. Given the path to a handoff, it resumes from it. It follows the [Agent Skills](https://agentskills.io) format, so any agent that loads that format can use it.

- Ask your agent for a handoff (in Claude Code `/handoff`, in Codex `$handoff`), optionally with what the next session is for. It writes the file, checks it against `references/schema.json`, and prints the path plus a one-line prompt to paste into the new session.
- Files are saved where `config.json` says, or the skill asks for a folder once and offers to remember it.
- In the Claude desktop app it then offers the continuation as a launch card, with a model and effort that you pick or that the handoff recommends (`next_session`). A card cannot start a session on a higher model or effort than the one that wrote the handoff, so for a stronger model it becomes a gate: the new session first asks you to switch the model in the menu and waits for your "go". In other agents the skill prints the one-line prompt and says which model to open it on.
- Everything in a handoff is written in English. Copy that must be reused as written (app, website or document text) goes unchanged into `verbatim_copy`.

## Prerequisites

| Requirement | Status | Why it is needed |
| --- | --- | --- |
| An agent that loads Agent Skills | required | Claude Code, Codex, Gemini CLI and others. See the install page of the repository. |
| Python 3 | required | The skill checks every handoff with it, with or without `jsonschema`. |
| `jsonschema` (Python package) | **strongly recommended** | Full check of each handoff against `references/schema.json`. See below. |
| git | optional | Fills `environment` with the branch, commit and uncommitted files. Without git the skill leaves those out. |

Tested only in Claude Code, on macOS with Python 3.14 and `jsonschema` 4.26. Other agents and systems are untested. On Windows the venv's Python is at `venv\Scripts\python.exe`.

## Install the schema check (strongly recommended)

`references/schema.json` is the contract between the session that writes a handoff and the session that reads it. With `jsonschema` installed, each write is checked, and the skill fixes problems before it gives you the path. Without it, a handoff with a missing `next_step` or a wrong type is saved without a complaint, and the next session finds out when it tries to resume. In that case `scripts/validate.py` only checks that the file is valid JSON with the required and known top-level keys, and says so.

Install the package into a venv, not into the system Python. Homebrew and many Linux distributions refuse a global `pip install` (PEP 668).

```bash
python3 -m venv ~/.config/handoff/venv
~/.config/handoff/venv/bin/python -m pip install jsonschema
```

You do not have to point anything at the venv: `scripts/validate.py` looks for it in `$HANDOFF_VENV`, `~/.config/handoff/venv` and `~/.claude/handoff/venv` (where earlier versions put it), and runs itself inside the first one it finds.

Check that it works against any handoff file:

```bash
python3 <skill folder>/scripts/validate.py path/to/file.handoff.json
```

A valid file prints `<path>: ok`. An invalid one prints one line per problem and exits with code 1.

## Where handoffs are saved

The skill reads the folder rule from `$HANDOFF_CONFIG`, then from `~/.config/handoff/config.json`, then from `~/.claude/handoff/config.json`. With no config it asks once and offers to write one to `~/.config/handoff/config.json`. Minimal config:

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
| `references/schema.json` | The structure of a handoff. The authority. |
| `scripts/validate.py` | Checks a handoff against the schema. |
| `assets/config.example.json` | Example folder rule. |
