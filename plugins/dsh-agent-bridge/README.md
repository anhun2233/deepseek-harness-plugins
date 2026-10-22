# Agent Bridge (`dsh-agent-bridge`)

Host plugin for DeepSeek Harness desktop. While it is enabled on the Plugins page it serves a JSON control API on `127.0.0.1` so any local agent (Claude Code, Codex, Cursor, OpenClaw, or anything else that can run a command or send HTTP) can drive DSH.

While it is off, it does not listen and it does not leave a token file behind.

## What it can do

Ping, list models, list workspaces, list and create sessions, send a prompt and wait for the reply, select a model, cancel, rename, read messages, list permission presets, set a session's preset, get or set the default model, and approve or reject tool requests.

Permanent delete is included only when [`dsh-session-delete`](../dsh-session-delete/README.md) is also installed and enabled. The bridge calls that plugin's `dshSessionDelete` service. It does not delete session files itself.

## Security

- Off until you enable **Agent Bridge** on the Plugins page.
- Binds `127.0.0.1` only. A non-loopback peer receives `403`.
- Random bearer token, written to `<DSH data dir>/dsh-agent-bridge.json` (mode `0600` where the platform honors it). Requests without that token receive `401`.
- The data directory is `DSH_HOME` if set, otherwise `~/.dsh`. Nothing in this plugin hardcodes a machine path.
- A new token is generated every time the plugin starts. Disabling the plugin deletes the file.
- Approval mode defaults to `ui` (DSH asks the person at the keyboard). `auto-allow` approves every tool call in that session; don't turn it on unless you mean to.

Selecting a model for a session may also change DSH's default model. Send `restoreDefault: true`, or pass `--restore-default` / `-RestoreDefault` on the clients, to write the previous default back. Model ids are whatever `GET /models` returns on that machine.

## Install

In DSH: **Plugins → Add plugin → install a third-party plugin** from a local folder or a link. Choose this folder (the one that contains `package.json`). Then enable **Agent Bridge** on the Plugins page when you want the API.

Clients and the full route list live in the repository root: [`docs/API.md`](../../docs/API.md), [`clients/`](../../clients/README.md), [`agent-template/SKILL.md`](../../agent-template/SKILL.md).

Tested with DeepSeek Harness desktop 0.2.1-rc.2. No build step and no dependencies.
