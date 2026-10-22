# Agents

This repository is the public home for two DeepSeek Harness (DSH) desktop plugins. An agent that will **drive DSH** should follow the procedure below. An agent that will **change this repository** should also run `node scripts/check.mjs` before finishing.

Portable copies of the procedure, for an agent that is not working inside this repo:

- `agent-template/SKILL.md` — drop-in skill
- `agent-template/system-prompt.md` — short system-prompt snippet
- `docs/API.md` — full HTTP reference

## Drive DSH

The control API is **Agent Bridge** (`plugins/dsh-agent-bridge`). It is off until a person enables it on DSH's Plugins page. It binds `127.0.0.1` only. A random bearer token is written to `<data-dir>/dsh-agent-bridge.json` and removed when the plugin stops. Requests without the token get `401`.

Data directory: `$DSH_HOME` if set, otherwise `~/.dsh`. Do not hardcode a path. If the discovery file is missing, ask the user to enable **Agent Bridge** or to set `DSH_HOME` to the directory DSH is actually using. Do not scan ports and do not guess a drive letter.

Check, then use. `ask` prints the reply text, not JSON. Pass `--json` for the envelope. The hello walkthrough for Hermes Agent, Claude Code, and Codex is `docs/walkthrough.md`.

```bash
node clients/dsh-bridge.mjs doctor
node clients/dsh-bridge.mjs sessions --limit 20
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ping
```

`doctor` and `ping` are the same enablement check. The Node client needs Node.js 18 or newer and works on macOS, Linux, and Windows. PowerShell works on Windows PowerShell 5.1 and on PowerShell 7.

Never print the discovery token or send it anywhere except `Authorization: Bearer` on `http://127.0.0.1:<port>`. Prefer the clients so the token stays out of argv.

### Model selection

Choosing a model for a session may change DSH's default model. This tree has no model ids in it. Read `models`, or omit `provider` and `model` to keep the current default. When you do select one, pass `--restore-default` (PowerShell: `-RestoreDefault`) unless the user wants that model to become the default. The JSON result includes `previousDefault`, `defaultMayHaveChanged`, and `defaultRestored`.

### Approvals

Default mode is `ui`: the person answers in the DSH window. `remote` holds the request for `approvals` / `approve` / `reject`. `auto-allow` allows every tool request in that session once — do not set it unless the user explicitly asks. Modes are in memory and reset when the plugin restarts.

### Permanent delete

`delete` calls the separate **Session Delete** plugin (`plugins/dsh-session-delete`, service `dshSessionDelete`). If that plugin is not enabled, the bridge returns `501`. Confirm with the user first. The red **Delete permanently** menu item (Chinese locale: **永久删除**) is that plugin's own UI and does not need the bridge.

Delete removes the session log and projection cache from the DSH data directory. It does not remove attachments or workspace files. A session that is loaded in the current run leaves the list immediately and its files are removed when DSH exits or next starts. Subagent children are included. Forks are not.

## Repository map

```
plugins/dsh-agent-bridge/     Host plugin. package.json keeps dsh.bundle.patch.
plugins/dsh-session-delete/   Host plugin plus client module (session menu).
clients/dsh-bridge.mjs        Cross-platform CLI (Node 18+).
clients/dsh-bridge.ps1        PowerShell CLI.
docs/API.md                   HTTP reference.
agent-template/               Skill and system-prompt snippet.
agent-template/hermes/        Hermes Agent skill and snippet.
docs/walkthrough.md           Hello example for Hermes, Claude Code, and Codex.
scripts/check.mjs             Loads both plugins and exercises the bridge.
```

Install in the app with **Plugins → Add plugin → install a third-party plugin** from a local folder or a link. Point at one plugin folder, not the repository root. Tested with DSH desktop 0.2.1-rc.2.

## Working on this tree

- Plugins are plain ESM. There is no build and there are no dependencies.
- Keep paths derived from `DSH_HOME` or `os.homedir()`. Do not add machine paths, account names, tokens, or fixed model ids.
- `node scripts/check.mjs` must pass. It checks the plugin manifests (including `dsh.bundle.patch` and both locales), starts the bridge on a temporary data directory, checks loopback binding, `401` without a token, model-default restore, and session deletion.
