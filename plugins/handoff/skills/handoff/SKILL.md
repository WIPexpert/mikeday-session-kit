---
name: handoff
description: Write a JSON handoff of the current session so a fresh agent session can continue the work, saved by the folder rule in config.json, or resume from a handoff file when given its path. Use when the user says handoff, hand off, pass this on, or continue in a new session, or when the conversation has grown long.
license: MIT
compatibility: Needs Python 3. The Python package jsonschema is recommended for the full schema check. Works in any agent that loads Agent Skills; the launch-card step needs the Claude desktop app.
metadata:
  author: Mike Daykhin
  version: "0.2.0"
---

# Handoff

**Version:** 6 · **Created:** 2026-10-16 16:09 · **Updated:** 2026-10-18 12:30

Two jobs: **write** a handoff for this session, or **resume** from one when the user gives you a path to a `.handoff.json` file.

`<skill>` below is the folder that holds this `SKILL.md`. Its files: `references/schema.json` (the document's structure, the authority), `assets/config.example.json` (the folder rule), `scripts/validate.py` (checks a handoff against the schema).

## Write

1. **Resolve where to save it** (see "Where it goes"). Do this first; if it needs a question, ask it now and wait.
2. **Collect facts with commands, not memory:** `date '+%Y-%m-%dT%H:%M:%S%z'`, `pwd`, and when inside a git repo `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short HEAD`, `git status --short`. List what is still running (dev servers, background tasks, scheduled jobs) from this session's own record.
3. **Fill the document** to match `references/schema.json`. Rules for the content:
   - Reference, never copy: commits, diffs, plans, PRDs, ADRs and issues go into `artifacts` by path, hash or URL.
   - `state.done[].verified` is `true` only when this session checked it by running or measuring it, and `evidence` names the command. A cause nobody measured goes to `state.not_verified`, not to `done`.
   - `dead_ends` holds what was tried and failed, so the next agent does not repeat it.
   - `next_step` is ONE concrete action doable in minutes, with `first_command` when there is one.
   - `suggested_skills` lists the skills the next agent should invoke.
   - `next_session` (optional): the `model` and `effort` the continuing session should use, with a one-line `reason`. Set it only when the work clearly needs more or less than this session; otherwise leave it out.
   - If the user said what the next session is for, put it in `meta.next_session_focus` and tailor `goal`, `next_step` and `suggested_skills` to it.
   - **English only.** Every key and value in the file, the two lines you print, and any question you ask the user are in English, whatever language the session used. The one exception is copy that must be reused as written (text for an app, a website, a document, a message to send): put it unchanged, in its original language, in `verbatim_copy` (`where`, `language`, `text`) and explain it around it in English. Never translate or rephrase `verbatim_copy`.
   - Redact API keys, tokens, passwords and personal data; write `[redacted]`.
   - Keep it short: about 150 lines pretty-printed (2-space indent). If it grows past that, cut prose, not facts.
4. **Write the file, then check it:** `python3 <skill>/scripts/validate.py <file>`. It prints `ok` or one line per problem; fix and rewrite on failure. The script finds the Python package `jsonschema` by itself (see the skill's README). Without it, it checks only that the file is valid JSON with the required top-level keys, and says so: pass that on to the user.
5. **Append to the index** when `index` is on (below).
6. **Print two things:** the absolute path, and `resume_prompt` on its own line, ready to paste. `resume_prompt` is one line that names the absolute path, for example: `Read <path> and continue from next_step; check environment first.`
7. **Offer the new session.** First settle the model and effort for it: `next_session` when present, otherwise ask once (offer "keep this session's" as the recommended answer, a lower effort, a cheaper model, a stronger model). Compare with the model and effort this session runs on; if you cannot tell which is higher, treat it as higher. Then, by case:
   - **Not higher, and you have a tool that proposes a new session as a card** (the Claude desktop app: `mcp__ccd_session__start_session`): propose a card with `initiation: "own_initiative"` and `context: "fresh"`: `title` from `meta.topic`, `prompt` = `resume_prompt`, `background` = `goal` plus `next_step.action` (at least 80 characters), plus `model` and `effort`.
   - **Higher, with that tool:** a card cannot start a session above this one, and a session cannot raise its own model, so the card is a gate. `title` = `Switch to <model> / <effort> first: <meta.topic>`; `prompt` = `Do not start work yet. Tell me to switch this session to <model> at <effort> effort in the model menu, then wait for me to reply "go". After "go": <resume_prompt>`; leave `model` and `effort` out.
   - **No such tool (a terminal, another agent):** the printed `resume_prompt` is enough; when a stronger model is wanted, add one line: `Open a new session on <model> at <effort> effort, then paste the line above.`

   Never start the session yourself: the card is the user's click.

## Where it goes

Look up the folder rule in this order, first hit wins:

1. `$HANDOFF_CONFIG` (path to a config file), if set.
2. `~/.config/handoff/config.json`.
3. `~/.claude/handoff/config.json` (where earlier versions kept it).

**Config found, `mode: "fixed"`:** do not ask. Save to `<root>/<layout>`.

**No config, or `mode: "ask"`:** ask the user once where to save, using your question tool if you have one and plain text otherwise. Offer: `~/handoffs` (recommended), or another folder they type. After the answer, offer to save it as `~/.config/handoff/config.json` with `mode: "fixed"` so the question never comes back; write the file only on a yes.

`config.json` fields (see `assets/config.example.json`):

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `mode` | `fixed` saves silently, `ask` asks every time |
| `root` | base folder; `~` is expanded |
| `layout` | path under `root`; tokens `{project}` `{topic}` `{yyyy}` `{mm}` `{yymmdd}` `{hhmm}`; must end in `.handoff.json` |
| `index` | `true` appends one line per handoff to `<root>/INDEX.jsonl` |

Rules for the path, in every mode:

- **Never save into the current workspace or the session's scratch folder.** A scratch folder is deleted with its session; a repo working tree gets polluted. If the resolved path is inside a git repo (`git -C <dir> rev-parse --is-inside-work-tree`), stop and ask.
- **Slugs** (`topic`, `project`): lowercase ASCII, words joined by `-`, non-Latin text transliterated, no other characters, at most 40 characters. No clear project: `misc`.
- **Time tokens** come from `date`, local time, never guessed.
- **Create missing folders.** If the file already exists, add `-2`, `-3`, and so on before the extension; never overwrite a handoff.
- **Index line**, one JSON object per line: `{"path", "created", "project", "topic", "next_step"}` where `next_step` is the action text. This is how a later session finds "the latest handoff": read the last line of `INDEX.jsonl`.

## Resume

When the user gives a path to a `.handoff.json` (or says "continue the last handoff" and an `INDEX.jsonl` is configured, then take its last line):

1. Read the file and check it with `python3 <skill>/scripts/validate.py <file>`.
2. Compare `environment` with reality (`pwd`, branch, `git status --short`, anything in `running`) and say what differs before touching anything.
3. Treat `state.done` items with `verified: true` as established; treat `not_verified` and unverified `done` items as unknown.
4. Start from `next_step`. Do not repeat anything in `dead_ends` unless you have a new reason.
5. Use `verbatim_copy` entries exactly as written; do not translate or rephrase them.
