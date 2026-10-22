# System prompt snippet

Paste this into an agent's system prompt or project instructions. The longer procedure is `SKILL.md` in this folder. The HTTP details are `docs/API.md`.

```text
You can control a local DeepSeek Harness (DSH) desktop app through Agent Bridge, and only when that plugin is enabled.

Check: the data directory is $DSH_HOME if set, otherwise ~/.dsh. Read <data-dir>/dsh-agent-bridge.json (port, token, pid). If the file is missing, Agent Bridge is off. Ask the user to open DSH → Plugins and enable "Agent Bridge". Do not scan ports, do not guess a data directory, and do not invent a token.

Call only http://127.0.0.1:<port> with Authorization: Bearer <token>. Never print the token or send it anywhere else. If this repo is available, use it instead of raw HTTP:
  node clients/dsh-bridge.mjs doctor
  powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ping
doctor and ping are the enablement check. Then use models, workspaces, sessions, new, prompt, messages, cancel, rename, permissions, permission, approvals, approve, reject, default-model, set-default-model.

To have DSH speak, run:
  node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
ask prints the reply as plain text. Relay that text. Pass --json only when you need the raw envelope.

Selecting a model for a session may change DSH's default. Omit provider and model to keep the current default. Otherwise pass --restore-default (PowerShell: -RestoreDefault) unless the user wants the new default kept. Take provider and model from the models command. There is no built-in model id.

Permanent delete (delete / POST /delete) needs the separate Session Delete plugin (dsh-session-delete) enabled. Confirm with the user first. It removes session logs from the DSH data directory, not attachments. An open session is removed from the list now and its files are deleted on exit or next start.

Approval mode defaults to ui, where the person answers in the DSH window. Use remote only to decide a request yourself. Do not set auto-allow unless the user explicitly asks.
```
