---
name: dsh-agent-bridge
description: Drive a local DeepSeek Harness desktop app through the Agent Bridge plugin. Use when checking whether the bridge is enabled, creating DSH sessions, sending prompts, reading replies, switching models, setting permissions, answering approvals, or permanently deleting a session.
---

# DeepSeek Harness Agent Bridge

You can drive a local DeepSeek Harness (DSH) desktop app only through the Agent Bridge plugin. The bridge is off until a person enables **Agent Bridge** on DSH's Plugins page. It listens on `127.0.0.1` only and requires a bearer token.

## Check whether it is enabled

1. Data directory: `$DSH_HOME` if that variable is set, otherwise `~/.dsh`. Do not guess a drive letter or a home-folder path. If the file below is missing and the user says DSH uses another data directory, ask them to set `DSH_HOME` or pass that directory as `--home` / `-DshHome`.
2. Discovery file: `<data-dir>/dsh-agent-bridge.json` with `bind`, `port`, `token`, `pid`, `startedAt`, `version`.
3. If the file is missing, the bridge is off or DSH is not running. Tell the user to open **Plugins** and enable **Agent Bridge**. Stop. Do not scan ports, do not try other interfaces, and do not invent a token.
4. If the file exists, call ping and nothing else until ping succeeds:
   - With this repository checked out: `node clients/dsh-bridge.mjs doctor` (Node.js 18+). On Windows PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ping`.
   - Without the repository: `GET http://127.0.0.1:<port>/ping` with header `Authorization: Bearer <token from the file>`.
5. `doctor` / `ping` prints one JSON object. `ok: true` and `value.pong: true` means the bridge is up. `code: "disabled"` means step 3. `code: "stale"` means the recorded process is gone; ask the user to start DSH and enable the plugin again.

Never print the token, put it in a commit, or send it anywhere except the `Authorization` header of a request to `127.0.0.1:<port>`. Prefer the client so the token stays out of argv.

## Calls

`ask` prints only DSH's reply text on stdout. Relay that text. Pass `--json` (PowerShell: `-Json`) when you need the `{ "ok", "value" }` envelope. Every other command prints one JSON object. Exit code 1 is failure. A failed plain `ask` writes the error to stderr and leaves stdout empty. Default-model notes are on stderr.

One shot, with no model id, so DSH keeps its current default:

```bash
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

The full hello conversation is [docs/walkthrough.md](../docs/walkthrough.md). Hermes's installable copy is [agent-template/hermes/SKILL.md](hermes/SKILL.md).

| Goal | Client | HTTP |
|---|---|---|
| Catalog | `models` | `GET /models` |
| Workspaces | `workspaces` | `GET /workspaces` |
| List sessions | `sessions --limit 20` | `GET /sessions?limit=20` |
| New session | `new --title "..."` | `POST /sessions` |
| One-shot | `ask --text "..."` | `POST /ask` |
| Continue | `prompt --session <id> --text "..."` | `POST /sessions/<id>/prompt` |
| Read | `messages --session <id>` | `GET /sessions/<id>/messages` |
| Cancel | `cancel --session <id>` | `POST /sessions/<id>/cancel` |
| Rename | `rename --session <id> --title "..."` | `POST /sessions/<id>/rename` |
| Permissions | `permissions` then `permission --session <id> --preset <id>` | `GET /permissions`, `POST /sessions/<id>/permission` |
| Default model | `default-model` / `set-default-model` | `GET` or `POST /default-model` |
| Approvals | `approvals`, `approve --id <id>`, `reject --id <id>` | `GET /approvals`, `POST /approvals/<id>` |

Full request and response fields: `docs/API.md` in this repository. If you only have this skill, the table plus the bodies below is enough to start.

`POST /sessions` body (all optional): `{ "workspaceId", "cwd", "title", "provider", "model", "reasoningEffort", "approvalMode", "permission", "restoreDefault" }`. Omit `workspaceId` and `cwd` to use the first workspace. `provider` and `model` must be sent together, copied from `GET /models`.

`POST /ask` is that body plus `{ "text": "required", "wait": true, "timeoutSec": 300 }`. `POST /sessions/<id>/prompt` is `{ "text", "wait": true, "timeoutSec": 300, "mode": "queue" }`. `mode` may be `steer`. Wait until `status` is `turn-ended` or the command returns; the reply is `value.reply`.

## Model selection

Selecting a model for a session may change DSH's default model for every later session. Do not hardcode a model id.

- To keep the current default, omit `provider` and `model`.
- To use a specific model for one session and then restore the previous default, pass `--restore-default` (PowerShell: `-RestoreDefault`), or send `"restoreDefault": true`.
- The response includes `previousDefault`, `defaultMayHaveChanged`, and `defaultRestored`. If you did not restore and `defaultMayHaveChanged` is true, tell the user and offer to `POST /default-model` with `previousDefault`.
- Change the default on purpose only with `set-default-model` / `POST /default-model`, and only when the user asked.

## Approvals

Modes are per session and live in memory (they reset when the plugin restarts). Sessions you did not create through the API stay on `ui`.

- `ui` (default): the person answers in the DSH window. You can list the request; deciding it returns `409`.
- `remote`: the request waits on `GET /approvals`. Decide with `allow`, `reject`, or `cancel` only for a request you understand. `allow` means allowed once.
- `auto-allow`: every tool request in that session is allowed once. Do not set this unless the user explicitly asks.

## Permanent delete

`delete --session <id>` / `POST /delete` with `{ "sessionIds": ["<id>"] }` works only when the separate **Session Delete** plugin (`dsh-session-delete`) is installed and enabled. Otherwise the bridge returns `501` `delete-unavailable`. Ask the user before deleting. Deletion removes the session log and projection cache from the DSH data directory. It does not remove attachments or files inside the workspace. A session that is open in this run disappears from the list immediately and its files are removed when DSH exits or next starts (`deferred`). Subagent children are included. Forked sessions are not.

## Rules

- Talk only to `127.0.0.1` and only with the current discovery token.
- If ping fails, ask the user to enable the plugin. Do not look for another port.
- Confirm before `auto-allow` and before permanent delete.
- Do not put secrets from the user's sessions into another system unless the user asked.
