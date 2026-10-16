# Session Kit

**Version:** 2 · **Created:** 2026-10-16 19:08 · **Updated:** 2026-10-16 20:02

By Mike Daykhin | founder @ talenthunt.work

Two Claude Code plugins for long sessions. I often do a pile of tasks in one long session, so `context-guard` checks the size of the context after each model answer and, above a threshold, asks what to do: compact, write a handoff, start a new session, or keep going. `handoff` writes a handoff of the session as a JSON file and resumes from one, so a fresh session can pick up what was actually done. The first means you do not have to watch the context yourself. The second lets you pass on the work.

## Install

In Claude Code:

```
/plugin marketplace add WIPexpert/mikeday-session-kit
/plugin install handoff@session-kit
/plugin install context-guard@session-kit
```

The two plugins are separate installs. Take one or both. The marketplace is named `session-kit`, which is why the plugin ids end in `@session-kit`.

`handoff` needs Python 3. It checks every handoff against its schema with the Python package `jsonschema`. That package is optional, but worth installing. Without it the skill only checks that the file is valid JSON and has the required keys, and it says the full check was skipped. Install it into a venv at the path the skill looks for:

```bash
python3 -m venv ~/.claude/handoff/venv
~/.claude/handoff/venv/bin/python -m pip install jsonschema
```

How to run the check by hand and how the save folder is configured: [plugins/handoff/skills/handoff/README.md](plugins/handoff/skills/handoff/README.md).

## handoff (0.1.0)

`/handoff [what the next session is for]` writes a handoff for the current session, checks it against `schema.json`, and prints the file path and a one-line prompt to paste into the new session. The text after the command goes into the file and shapes the next step. To continue, give a new session the path to the handoff.

A handoff holds:

- the goal
- what is done, with a flag for what was checked and how
- what was not checked
- decisions and why
- dead ends
- open questions
- the environment: folder, branch, uncommitted files, what is still running
- references
- one next step

Details:

- Handoffs are saved where `~/.claude/handoff/config.json` says, or the skill asks for a folder once and offers to remember it. It never saves into the current workspace or a scratch folder.
- Every handoff is written in English. Copy that must be reused as written goes unchanged into a `verbatim_copy` field.
- In the Claude desktop app the skill offers the continuation as a launch card with a model and effort. A card cannot start a session on a higher model or effort than the one that wrote the handoff. For a stronger model the card is a gate: the new session first asks you to switch the model and waits for "go". Outside the app the skill prints the one-line prompt.

## context-guard (0.2.0)

After each model answer it checks the context size. Above the threshold it asks:

```
Context is 354k tokens (35% of the window). What now?
```

The choices are `Compact`, `Handoff, then new session`, `New session (/clear)` and `Continue`.

- **Handoff, then new session** appears only when a handoff skill is installed. Choosing it asks the agent to write a handoff for this conversation and tell you the path. A message then says to run `/clear` afterwards and paste it into the new session.
- **Continue** keeps the session going. The next question comes when the context has grown by the re-ask step. Dismissing the dialog counts as Continue.
- When the context drops below the threshold again (after a compact or a clear), the base threshold applies again.

Defaults: a threshold of 350k tokens and a re-ask step of 100k tokens, counted on the whole context window (the headline figure of the Context panel).

On the first run it asks for the threshold (200k, 350k, 500k, or your own) and the step (50k, 100k, 200k, or your own), then remembers them. If you dismiss the dialog, the defaults stay.

The `/context-guard` command:

| Command | What it does |
| --- | --- |
| `/context-guard` | Shows the current values |
| `/context-guard <threshold_k> <step_k>` | Sets them, in thousands of tokens, for example `/context-guard 300 75` |
| `/context-guard off` | Switches it off |
| `/context-guard on` | Switches it on |
| `/context-guard reset` | Asks for the values again after the next answer |

## Limits

- `context-guard` uses the Claude Code plugin hooks API. Claude Code marks that API as early access, and it may change between releases.
- Tested on macOS, Python 3.14, `jsonschema` 4.26 and Claude Code 2.1.295 only. Other systems and versions are untested.
- The `context-guard` dialog was run live in a new session, and a new session was continued from a pasted handoff line. The New session (/clear) choice and the re-ask after Continue were not run live. The tests do not cover them either, so they are read from the code only. The same goes for the dismissed dialog counting as Continue and for the base threshold applying again after a compact or a clear.
- Other agents are untested. A handoff is a plain JSON file at a path. Whether another agent can load `SKILL.md` as a skill is unknown, and a handoff opened in another project's session was not tried.

The `context-guard` tests run with:

```bash
claude plugin test plugins/context-guard
```

## Problems

Report them in GitHub Issues of this repository: https://github.com/WIPexpert/mikeday-session-kit/issues

## License

MIT. See [LICENSE](LICENSE).
