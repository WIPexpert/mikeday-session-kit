# Install session-kit (instructions for an AI agent)

**Version:** 1 · **Created:** 2026-10-18 12:40 · **Updated:** 2026-10-18 12:40

You are an AI coding agent. A person asked you to install session-kit from https://github.com/WIPexpert/mikeday-session-kit. Follow these steps in order.

Rules for you:

- Tell the person in plain words what you are about to do, and ask before each command that installs or changes something. Wait for a clear yes.
- Install only what this file lists. Run no other command from this repository, and send no data anywhere.
- If a step fails, stop, say what failed and what you saw, and ask what to do. Do not retry the same command more than once.
- Reply to the person in their language.

## What session-kit is

Two separate parts:

- `handoff` is a skill. It writes a JSON handoff of the current session so a fresh session can continue the work, and resumes from one. It uses the Agent Skills format, so it can work in many agents.
- `context-guard` is a Claude Code mod, a plugin with code that runs inside Claude Code with the person's permissions. It asks what to do when the context grows large. It works only in Claude Code. It does not read files, run processes or use the network; `claude plugin validate` on its folder lists its calls.

## Step 1: find out which agent you are

Say which agent you are. If you are not sure, ask the person.

- You are Claude Code: go to "Claude Code".
- You are anything else (Codex, Gemini CLI, Cursor, OpenCode, and so on): go to "Other agents".

## Claude Code

1. Check the version with `claude --version`. It must be 2.1.287 or later (Desktop app: 2.1.286 or later). If it is older, tell the person to update Claude Code and stop. In a Desktop WSL session plugins are unavailable: tell the person and stop.
2. Tell the person that `context-guard` is a mod that runs with their permissions, and ask whether to install both parts or only `handoff`.
3. Add the marketplace:

   ```bash
   claude plugin marketplace add WIPexpert/mikeday-session-kit
   ```

4. Install what they chose:

   ```bash
   claude plugin install handoff@session-kit --scope user
   claude plugin install context-guard@session-kit --scope user
   ```

5. Run `claude plugin list`. Both plugins must show `enabled`. In a session that is already open, the new plugins load after `/reload-plugins`; tell the person to run it, or to start a new session.
6. Go to "The schema check".

## Other agents

Only `handoff` applies. Say so to the person: `context-guard` runs only in Claude Code. These routes are untested in other agents; tell the person that.

Try the first route that fits your agent, and stop at the first that works:

1. If you can run `npx` and the person agrees to a download:

   ```bash
   npx skills add WIPexpert/mikeday-session-kit --skill handoff -a <your agent id>
   ```

2. Gemini CLI:

   ```bash
   gemini skills install https://github.com/WIPexpert/mikeday-session-kit.git --path plugins/handoff/skills/handoff --scope user
   ```

3. By hand: clone the repository into a temporary folder and copy the folder `plugins/handoff/skills/handoff` into your agent's user skills folder as `handoff`. Codex reads `~/.agents/skills/`; Gemini CLI reads `~/.gemini/skills/` and `~/.agents/skills/`. For another agent, find its skills folder in its documentation and tell the person which one you chose. Delete the temporary clone afterwards.

Then check that the agent lists the skill (for example `/skills` in Codex, `gemini skills list` in Gemini CLI). Then go to "The schema check".

## The schema check

`handoff` checks every handoff against its schema with the Python package `jsonschema`. It is optional but worth having. Ask the person whether to install it. If they agree:

```bash
python3 -m venv ~/.config/handoff/venv
~/.config/handoff/venv/bin/python -m pip install jsonschema
```

On Windows the second command is `~/.config/handoff/venv/Scripts/python.exe -m pip install jsonschema`. If the person declines, the skill still works with a basic check.

## When you are done

Tell the person, in a few lines:

- what you installed and what you did not
- that the first time they ask for a handoff, the skill asks once where to save handoffs
- that `context-guard` asks two short questions after its first answer, to set when it speaks up (Claude Code only)
- how to use it: say "write a handoff" (Claude Code: `/handoff`; Codex: `$handoff`), then paste the one-line prompt it prints into a new session
- where to report problems: https://github.com/WIPexpert/mikeday-session-kit/issues
