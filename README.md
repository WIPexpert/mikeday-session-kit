# Session Kit

**Version:** 11 · **Created:** 2026-10-16 19:08 · **Updated:** 2026-10-18 18:55

By Mike Daykhin | founder @ talenthunt.work

Two tools for long AI coding sessions. `context-guard` shows how full the context is in a one-line band above the prompt and, past a threshold you choose, asks what to do: compact, write a handoff, start a new session, or keep going. `handoff` writes a handoff of the session as a JSON file, so a fresh session can pick up what was actually done. The first means you do not have to watch the context yourself. The second lets you pass the work on.

## Install in one paste

Copy this into your agent (Claude Code, Codex, Gemini CLI, Cursor, or another one that loads Agent Skills) and send it:

```text
Install session-kit for me. Read https://raw.githubusercontent.com/WIPexpert/mikeday-session-kit/main/INSTALL.md and follow it. Tell me in plain words what you are about to do, and ask me before you change anything.
```

The agent reads [INSTALL.md](INSTALL.md), works out which agent it is, and installs what fits:

| Agent | What you get |
| --- | --- |
| Claude Code | `handoff` and `context-guard` |
| Codex, Gemini CLI, Cursor, OpenCode and other agents that load Agent Skills | `handoff` only. `context-guard` runs only inside Claude Code. |

The agent asks before each change. To read what it will do first, open [INSTALL.md](INSTALL.md).

### If you would rather type the commands (Claude Code)

```text
/plugin marketplace add WIPexpert/mikeday-session-kit
/plugin install handoff@session-kit
/plugin install context-guard@session-kit
```

The two plugins are separate installs. Take one or both. The marketplace is named `session-kit`, which is why the plugin ids end in `@session-kit`. To update later, run `/plugin marketplace update session-kit`, then `/reload-plugins`.

### Install the schema check

`handoff` checks every handoff against its schema with the Python package `jsonschema`. The package is optional but worth installing: without it a malformed handoff is saved with only a basic check. The install prompt above offers it. By hand:

```bash
python3 -m venv ~/.config/handoff/venv
~/.config/handoff/venv/bin/python -m pip install jsonschema
```

More in [the skill's README](plugins/handoff/skills/handoff/README.md).

## handoff (0.2.0)

Ask your agent for a handoff (in Claude Code `/handoff`, in Codex `$handoff`), optionally with what the next session is for. It writes a handoff for the current session, checks it against the schema, and prints the file path and a one-line prompt to paste into the new session. To continue, give a new session the path to the handoff.

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

- Handoffs are saved where `~/.config/handoff/config.json` says, or the skill asks for a folder once and offers to remember it. It never saves into the current workspace or a scratch folder.
- Every handoff is written in English. Copy that must be reused as written goes unchanged into a `verbatim_copy` field.
- In the Claude desktop app the skill offers the continuation as a launch card with a model and effort. A card cannot start a session on a higher model or effort than the one that wrote the handoff. For a stronger model the card is a gate: the new session first asks you to switch the model and waits for "go". Elsewhere the skill prints the one-line prompt.
- `handoff` is a skill in the [Agent Skills](https://agentskills.io) format, so other agents can load it. Only Claude Code was tested.

## context-guard (0.6.3)

`context-guard` is a Claude Code mod: a plugin with code that runs inside Claude Code. After each model answer it checks the context size. Past the threshold it asks:

```
Context is 35% of the window (354K tokens). What now?
```

The choices are `Compact`, `Handoff, then new session`, `New session (/clear)` and `Continue`.

- **Handoff, then new session** appears only when a handoff skill is installed. Choosing it asks the agent to write a handoff for this conversation and tell you the path. A message then says to run `/clear` afterwards and paste the path into the new session.
- **Continue** keeps the session going. The next question comes when the context has grown by the re-ask step. Dismissing the dialog counts as Continue.
- When the context drops below the threshold again (after a compact or a clear), the base threshold applies again.
- Compact calls the session's own compaction. Where the session refuses that call, as the Claude desktop app does, it runs `/compact` for you. If an action fails anyway, a message says so and tells you which command to type.
- It asks nothing in a session where nobody can answer, such as `claude -p`.

### The band above the prompt

One line above the prompt input, in the terminal and in the Claude desktop app:

```text
ctx-grd ████▉░│░░░ 26% used | next ask at 35%  [ Compact ] [ Handoff ] [ Clear ]
```

- The bar is a share of the window. It is green below your threshold, amber past it and red from 90%. The last cell is a partial block, so it moves smoothly. In the desktop app the bar is a rounded graphic.
- The white mark on the bar is the next ask line: your threshold at first, and one step further after you choose `Continue`. When the context is past it, the line says `over 35%` and the Compact button is the bright one.
- The three buttons do what the dialog's answers do: compact, ask for a handoff, run `/clear`. Each one asks you to confirm first, in the band itself: the line turns into `Compact now? The history is summarized.` with `Yes, compact` and `Cancel` buttons, the focus starting on `Cancel`. `Cancel`, or no answer for 20 seconds, takes it back and nothing runs. `Handoff` is there only when a handoff skill is installed. Each press is counted in the local statistics.
- Right after a compact or `/clear` there is no token count until the next answer, and the band says `no reading yet`.
- While Claude works, the spinner gets a short tail, `Thinking · ctx 77%…`.
- It is one line at any width (the example is 80 columns). On a wide terminal it reads `26% used 264K of 1M | next ask at 35%`. When the terminal is narrow, the token counts go first, then the words about the next ask get shorter (`| ask 35%`) and then go too, and the bar shrinks last.
- Before the first-run questions are answered the band reads `context-guard is not set up` with a `Set up` button. When switched off it reads `ctx-grd off` with `Turn on`.
- `/context-guard style` chooses what shows: `both` (the default), `dialog` only, or `band` only. With `band` it never interrupts you.
- The band is drawn in the terminal and the Claude desktop app. The VS Code extension has no band, so there only the dialog shows.

**Thresholds are a share of the model's context window**, the "used" figure of the Context panel. Defaults: 35% for the threshold and 10% for the re-ask step, which is 350k and 100k tokens on a 1M window. A share stays right when the window is smaller: Claude Opus 4.6 and Sonnet 4.6 have 200k unless you use the `[1m]` variant, and then 35% is 70k.

On the first run it asks for the threshold (20%, 35%, 50%, or your own) and the step (5%, 10%, 20%, or your own), with the token count beside each, then remembers them. If you dismiss the dialog, the defaults stay.

The `/context-guard` command:

| Command | What it does |
| --- | --- |
| `/context-guard` | Shows the current values, and warns when Claude Code would compact on its own before your threshold |
| `/context-guard 35% 10%` | Sets the threshold and the step as shares of the window |
| `/context-guard 350k 100k` | The same in thousands of tokens, turned into shares of the current window |
| `/context-guard off` | Switches it off |
| `/context-guard on` | Switches it on |
| `/context-guard reset` | Asks for the values again after the next answer |
| `/context-guard style dialog` | Shows only the dialog. `band` shows only the band, `both` shows both (the default). `/context-guard style` shows the current one |
| `/context-guard ask` | Opens the dialog now, below the threshold, with the current numbers. Use it to see what the dialog looks like or to compact on demand. The buttons really act, and this opening is not counted in the statistics |
| `/context-guard stats` | Shows your own usage counts |
| `/context-guard stats share` | Prints the counts as JSON you can paste into an issue |
| `/context-guard stats reset` | Clears the counts |

Settings are shared by all your sessions. Version 0.2.x kept them in tokens; the first run of 0.3.0 converts them.

### Local statistics

To help you see how you use it, `context-guard` counts a few things in its own store on your machine: how many times the dialog appeared and at what share of the window, how often you picked each answer, whether Compact went through the session or through `/compact`, how many handoff requests were sent, how many band buttons were pressed, and how many actions failed. `/context-guard stats` shows the counts. Nothing is sent anywhere: the counts never leave your machine unless you copy `/context-guard stats share` into a message yourself. It holds counts and your settings, no texts, paths, names or ids. `/context-guard stats reset` clears it.

## Requirements and limits

- Claude Code 2.1.287 or later (the Desktop app from 2.1.286) for `context-guard`. In Desktop's WSL sessions plugins are unavailable.
- The Claude Code mods API can change between releases. Tested with Claude Code 2.1.295 on macOS, Python 3.14 and `jsonschema` 4.26. Other versions and systems are untested.
- Run live: the `context-guard` dialog with the choices `Continue` and `New session (/clear)`, and continuing a new session from a pasted handoff line, plus both launch cards (a model and effort below the current session's, and the gate for a stronger model). Covered by tests only: the percent thresholds, the first-run questions, the `/context-guard` command, the 0.2.x conversion, the re-ask after Continue, the failure messages, the `/compact` fallback for sessions that refuse `session.compact`, the statistics, `/context-guard ask`, and the band above the prompt with its spinner tail.
- Other agents: only the handoff file and the skill format are portable. Nobody has run `handoff` in Codex or Gemini CLI yet.

The `context-guard` tests run with:

```bash
claude plugin test plugins/context-guard
```

## What a mod can reach

A mod runs inside Claude Code with your permissions and is not sandboxed. Install mods only from sources you trust, and read what a mod does first. `claude plugin validate plugins/context-guard` lists what `context-guard` does: it reads the context size and the list of commands, draws the band above the prompt and the spinner tail, refreshes the numbers every 8 seconds, asks you questions, can start a compact or `/clear`, can submit one prompt (the handoff request), and keeps its settings and counts in its own store. It reads no files and runs no processes, and it makes no network requests. The exact calls it makes:

```text
$.clock.after, $.clock.every, $.clock.now, $.command.list, $.command.register, $.command.run, $.prompt.submit,
$.session.compact, $.session.surfaces, $.session.usage, $.store.delete, $.store.get, $.store.set, $.ui.ask,
$.ui.invalidate, $.ui.log, $.ui.resolve, $.ui.toast
```

## Problems

Report them in GitHub Issues of this repository: https://github.com/WIPexpert/mikeday-session-kit/issues

## License

MIT. See [LICENSE](LICENSE).
