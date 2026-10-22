# Walkthrough: have DSH say hello

This is the one-shot path any local agent can follow. Hermes Agent is the worked example. Claude Code and Codex use the same command.

Tested against the Agent Bridge plugin behavior for DeepSeek Harness desktop 0.2.1-rc.2. The client talks to `127.0.0.1` only. `ask` prints DSH's reply as plain text so the agent can relay it. `--json` (PowerShell: `-Json`) prints the full envelope instead.

## What the user says

> Go operate my DeepSeek Harness and have it say hello to you.

## What the agent does

1. Resolve the DSH data directory: `$DSH_HOME` if it is set, otherwise `~/.dsh`. Do not guess a drive letter or a home-folder path.
2. Check `<data-dir>/dsh-agent-bridge.json`. Running `doctor` does this without printing the token:

```bash
node clients/dsh-bridge.mjs doctor
```

3. If that file is missing, the bridge is off (or DSH is not running). `ask` exits 1, writes nothing to stdout, and writes this to stderr:

```text
Agent Bridge is off or DSH is not running (no discovery file at <data-dir>/dsh-agent-bridge.json). In DSH open Plugins and enable Agent Bridge. If DSH uses a custom data directory, set DSH_HOME or pass --home.
```

The agent stops and tells the user: open DeepSeek Harness, go to **Plugins**, enable **Agent Bridge**, then ask again. It does not scan ports.

4. If `doctor` returns `"pong": true`, the agent runs one shot. No provider and no model, so DSH keeps its current default:

```bash
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

5. Stdout is the greeting and nothing else, for example:

```text
Hello. I am here.
```

The agent relays that text to the user as what DeepSeek Harness said. Stderr is unused on this call. Exit 0 means the turn finished (`turn-ended`). Exit 1 means it did not; the reason is on stderr, and any partial reply is on stdout.

PowerShell does the same thing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ask -Text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

Pass `--json` or `-Json` when the caller needs `sessionId`, `status`, or the model-default fields. See [API.md](API.md).

## Install the skill for Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research) loads a directory that contains `SKILL.md` with YAML frontmatter. The file in this repo follows that format: `name`, `description` (one sentence, at most 60 characters), `version`, `license`, `platforms`, and `metadata.hermes` (`tags`, `requires_toolsets: [terminal]`). The validator requires `name`, `description`, and a body. The description limit and the `metadata.hermes` block are the project convention documented in Hermes's skill authoring guide.

Copy the folder into Hermes's skills directory. The frontmatter `name` is the skill id.

```bash
mkdir -p ~/.hermes/skills
cp -a agent-template/hermes ~/.hermes/skills/dsh-agent-bridge
```

Restart the Hermes session, or send another message so Hermes notices the new skill. It then appears in `skills_list` and as `/dsh-agent-bridge`. The agent should `skill_view` it and follow the procedure above. The terminal tool runs `dsh-bridge.mjs`.

A skill is also picked up from a trusted project. From this repository, after `hermes skills trust`, Hermes reads `.hermes/skills/` or `.agents/skills/` at the repo root. This repo keeps the installable copy under `agent-template/hermes/` so it is obvious what to copy. Copying it to `~/.hermes/skills/dsh-agent-bridge` is the direct install.

If you cannot install a skill, paste [`agent-template/hermes/system-prompt.md`](../agent-template/hermes/system-prompt.md) into Hermes's profile instructions.

`requires_toolsets: [terminal]` hides the skill in a session that has no terminal tool. The hello flow needs a shell.

## Claude Code

Claude Code loads `SKILL.md` from `~/.claude/skills/<name>/` for every project on that machine, or from `.claude/skills/<name>/` inside a repository. It uses the `name` and `description` frontmatter; extra Hermes fields are ignored.

```bash
mkdir -p ~/.claude/skills/dsh-agent-bridge
cp agent-template/SKILL.md ~/.claude/skills/dsh-agent-bridge/SKILL.md
```

[`agent-template/SKILL.md`](../agent-template/SKILL.md) is the generic skill. It tells Claude to run the same `doctor` check and the same plain-text `ask`, then relay stdout. You can instead paste [`agent-template/system-prompt.md`](../agent-template/system-prompt.md) into `CLAUDE.md`.

The same user sentence works. Claude checks the discovery file, and if it is missing tells the user to enable **Agent Bridge**. Otherwise it runs:

```bash
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

and relays the greeting.

## Codex

Codex reads skills from `.agents/skills/` (the working directory, each parent, and the repository root) and from `~/.agents/skills/`. Admin skills can live in `/etc/codex/skills`. An older `~/.codex/skills` path still loads and is deprecated in favor of `~/.agents/skills`.

```bash
mkdir -p ~/.agents/skills/dsh-agent-bridge
cp agent-template/SKILL.md ~/.agents/skills/dsh-agent-bridge/SKILL.md
```

Opening this repository also loads [`AGENTS.md`](../AGENTS.md), which has the same enablement check and the same `ask` command. Codex follows that file even without a copied skill. The reply to relay is still the plain-text stdout of `ask`.

## What not to do

- Do not put a provider or model id in the hello command. This repository does not ship any.
- Do not print `dsh-agent-bridge.json`'s `token`, and do not pass it as a shell argument. The client reads the file itself.
- Do not forward the port. The server binds `127.0.0.1` only.
- Do not treat a missing discovery file as a reason to try other hosts. Ask the user to enable the plugin.
