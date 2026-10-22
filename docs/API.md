# Agent Bridge HTTP API

Local control API for DeepSeek Harness desktop, served by the `dsh-agent-bridge` plugin while that plugin is enabled.

Tested against DeepSeek Harness desktop 0.2.1-rc.2.

The bridge does not embed provider ids, model ids, or a data-directory path. Model ids come from `GET /models` on the running app. The data directory comes from `DSH_HOME` or, when that variable is unset, `~/.dsh`.

## Security

- The plugin does not listen until it is enabled on DSH's Plugins page. Disabling it stops the server and deletes the discovery file.
- The server binds `127.0.0.1` only. Connect to that address. `localhost` may resolve somewhere else and will not reach a server that is not listening there.
- A connection whose peer is not loopback gets `403` and is not given a chance to present a token.
- Every other request must send `Authorization: Bearer <token>`. A missing or wrong token gets `401`. The token is 32 random bytes, hex-encoded, generated again every time the plugin starts.
- The token is written to `<data-dir>/dsh-agent-bridge.json` with mode `0600` where the platform allows it. Treat that file as a secret. Do not commit it, print it, or send it off the machine.
- Do not publish the port with a tunnel or a reverse proxy. The token is the only application-level check, and it is meant for a local agent.
- `auto-allow` approves every tool request in that session once. Leave the mode at `ui` unless you mean to take approvals over.

Prefer `clients/dsh-bridge.mjs` or `clients/dsh-bridge.ps1`. They read the discovery file themselves, so the token does not have to appear on a command line.

## Discovery file

Path: `$DSH_HOME/dsh-agent-bridge.json`, or `~/.dsh/dsh-agent-bridge.json` when `DSH_HOME` is unset.

```json
{
  "bind": "127.0.0.1",
  "port": 0,
  "token": "<64 hex characters>",
  "pid": 0,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "version": "0.1.0"
}
```

`port` is chosen at random (`0` in the bundle config). If DSH was installed with a custom data directory, set `DSH_HOME` (or pass `--home` / `-DshHome`) to that same directory before using a client. The plugin and the client use the same rule, but a desktop shortcut that sets the variable does not export it to other terminals.

The file is removed when the plugin is disabled or the Host exits. If the file is missing, the bridge is off.

## Request and response

Base URL: `http://127.0.0.1:<port>`

- Methods and paths below. No prefix.
- Request bodies are JSON. Maximum size 1 MiB.
- Success: HTTP 200 and `{ "ok": true, "value": ... }`.
- Failure: `{ "ok": false, "code": "...", "error": "..." }` with an HTTP status.

| HTTP | `code` | When |
|---|---|---|
| 400 | `bad-request` | Missing or invalid fields |
| 400 | `bad-json` | Body is not JSON |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 403 | `forbidden` | Peer is not loopback |
| 404 | `not-found` | Unknown route, unknown approval, or session is not loaded |
| 409 | `not-decidable` | Approval is being shown in the DSH window |
| 413 | `too-large` | Body over 1 MiB |
| 501 | `delete-unavailable` | `dsh-session-delete` is not installed and enabled |
| 500 | (DSH or plugin code) | The Host call failed. `error` joins nested causes |

## Model selection caveat

`POST /sessions`, `POST /sessions/:id/model`, and `POST /ask` call DSH's session model selector when `provider` and `model` are set. **That selector may also save the choice as DSH's default model.**

The bridge snapshots the previous default first and returns it:

| Field | Meaning |
|---|---|
| `previousDefault` | `currentSelection()` from before this call, or `null` |
| `defaultMayHaveChanged` | `true` when the previous default was not written back |
| `defaultRestored` | `true` when `restoreDefault: true` and the previous default was saved again |
| `restoreError` | Set when a restore was requested and could not be completed |

Send `"restoreDefault": true` to put the previous default back before the response returns. The previous selection is restored from its `provider`, `model`, and `reasoningEffort` fields. If those fields are missing, nothing is written and `restoreError` explains why.

The clients do this when you pass `--restore-default` (Node) or `-RestoreDefault` (PowerShell). They also print a stderr note when a call reports `defaultMayHaveChanged`. There is no built-in model id; copy `provider` and `model` from `GET /models` or leave them unset to keep the current default.

`POST /default-model` changes the default on purpose and does not take `restoreDefault`.

## Endpoints

### GET /ping

Liveness. `value`: `{ pong: true, plugin: "dsh-agent-bridge", version, bind: "127.0.0.1", pid }`.

`doctor` and `status` in the clients are aliases of this call. A missing discovery file is reported by the client as `code: "disabled"` before any HTTP request.

### GET /models

DSH's model catalog, unchanged. Use these ids for later calls.

### GET /workspaces

`value.items[]`: `{ id, name, path, sessionCount }`. `path` is the workspace directory on this machine.

### GET /sessions

Query: `limit` (default 50), `full=1`.

Without `full`, each item is `{ sessionId, title, cwd, running, blank, updatedAt, model, permission, turns, approvalMode, pendingQuestions }`. `approvalMode` is `ui` until this API sets one for that session. With `full=1`, items are DSH's own list records.

### POST /sessions

Create a session.

```json
{
  "workspaceId": "optional",
  "cwd": "optional, used only when workspaceId is omitted",
  "provider": "optional, together with model",
  "model": "optional, together with provider",
  "reasoningEffort": "optional",
  "title": "optional",
  "approvalMode": "ui | remote | auto-allow",
  "permission": "preset id from GET /permissions",
  "restoreDefault": false
}
```

If both `workspaceId` and `cwd` are omitted, the first workspace is used. `provider` and `model` must be sent together. The session's approval mode is the body's `approvalMode`, or the API default (see below), otherwise `ui`.

`value` includes `{ sessionId, workspaceId, approvalMode }` plus the model-selection fields when a model was set.

### POST /ask

Create a session, send one prompt, and wait for the turn to finish.

Body: every `POST /sessions` field, plus `{ "text", "wait": true, "timeoutSec": 300, "mode": "queue", "timeZone": "optional" }`. `text` is required. `restoreDefault` applies to the model selected for the new session, and the previous default is written back before the prompt runs.

`value` merges the create result with the prompt result.

The Node and PowerShell clients print `value.reply` as plain text for `ask`, so another agent can relay it. Pass `--json` or `-Json` for this envelope. Any other client command prints the envelope already. See [walkthrough.md](walkthrough.md).

### POST /sessions/:id/prompt

```json
{ "text": "required", "wait": true, "timeoutSec": 300, "mode": "queue", "timeZone": "optional" }
```

- `mode` is `queue` (default) or `steer`.
- `timeoutSec` is clamped to 5..3600. The HTTP call stays open until the turn ends or the budget runs out, so the client timeout must be longer than `timeoutSec`.
- `timeZone` is an IANA name passed through as the prompt's client zone. When omitted, the bridge uses the Host process's own zone (`UTC` if the runtime cannot name one).

`wait: false` returns `{ accepted: true, requestId }`.

`wait: true` (default) also returns `{ status, reply, lastReply, errors, events }`. `status` is `turn-ended`, `timeout`, or `aborted`. `reply` joins assistant text from that turn. `events` are the same row shape as `GET /sessions/:id/messages`.

### GET /sessions/:id/messages

Query: `limit` (default 50, the last N rows), `events=1`, `all=1`.

Rows:

| `role` | Contents |
|---|---|
| `user` | `{ seq, time, source, text }` |
| `assistant` | `{ seq, time, turn, step, provider, model, text, toolCalls }` |
| `tool` | `{ seq, time, callId, text, isError }` (text capped at 4000 characters) |
| `event` | turn start/end and approval asked/decided, only when `events=1` |

By default, user rows whose `source` is set and is not `user` are hidden (injected runtime context). `all=1` includes them. Tool-call arguments are capped at 4000 characters when they are strings.

### GET /sessions/:id/raw

Query: `limit` (default 20). The last N durable session events, with strings longer than 2000 characters truncated. For debugging.

### POST /sessions/:id/model

```json
{ "provider": "required", "model": "required", "reasoningEffort": "optional", "restoreDefault": false }
```

See [Model selection caveat](#model-selection-caveat). `value` is DSH's select result plus the caveat fields.

### POST /sessions/:id/cancel

Cancel the running turn. Body is ignored.

### POST /sessions/:id/rename

```json
{ "title": "string" }
```

### GET /permissions

Permission preset catalog from DSH. Pass a preset id from this list to the calls below. Do not assume a fixed set of ids across DSH versions.

### POST /sessions/:id/permission

```json
{ "preset": "required" }
```

The session must already be loaded in this process (opened, or resolvable by DSH). Otherwise `404`.

### GET /default-model

`value.selected` is DSH's current default selection.

### POST /default-model

```json
{ "provider": "required", "model": "required", "reasoningEffort": "optional" }
```

Saves that selection as the default. This is the explicit way to change it, including restoring a default you saved from `previousDefault`.

### GET /approval-mode

`value`: `{ defaultForNewSessions, sessions }`. `sessions` maps session id to the mode set through this API. The map is in memory and is empty after the plugin restarts, which means every session falls back to `ui`.

### POST /approval-mode

```json
{ "mode": "ui | remote | auto-allow" }
```

Sets the default mode for sessions **created later through this API**. It does not change sessions that already exist, and it does not change sessions created in the DSH window.

### POST /sessions/:id/approval-mode

```json
{ "mode": "ui | remote | auto-allow" }
```

Sets the mode for one session.

| Mode | Behavior |
|---|---|
| `ui` | DSH shows its own approval prompt. The API lists the request with `decidable: false`. Deciding it here returns `409`. |
| `remote` | The request is held until `POST /approvals/:id`. The DSH window is not asked. |
| `auto-allow` | The request is allowed once immediately. |

### GET /approvals

`value.items[]`: `{ id, sessionId, mode, toolName, callId, reason, createdAt, decidable, arguments }`. `arguments` is a best-effort lookup of the tool call in the session log.

### POST /approvals/:id

```json
{ "decision": "allow | reject | cancel" }
```

Outcomes: `allow` → `allowed-once`, `reject` → `rejected`, `cancel` → `cancelled`. Only `decidable` requests (mode `remote`) can be answered here.

### POST /delete

Permanent delete. **Requires the `dsh-session-delete` plugin to be installed and enabled.** The bridge calls the in-process service `dshSessionDelete`. It does not delete files itself. If the service is missing the response is `501` `delete-unavailable`.

```json
{ "sessionIds": ["id-1", "id-2"] }
```

A single id may also be sent as `{ "sessionId": "id-1" }` or as a string `sessionIds`. The bridge drops any in-memory approval mode for those ids, then returns the delete plugin's result:

```json
{
  "deleted": [],
  "deferred": [],
  "notFound": [],
  "removedPaths": [],
  "errors": []
}
```

What is removed, what is deferred, and what is left untouched is defined by [Session Delete](../plugins/dsh-session-delete/README.md):

- Session logs under the DSH session root, the projection cache, and the workspace list / archive / pin entries.
- Subagent child sessions go with the parent. Forked sessions are not deleted.
- A session that is loaded in the current process is hidden immediately (`deferred`) and its files are removed when DSH exits or on the next start.
- Attachments and other content-addressed blobs are not deleted. Files the agent wrote into the workspace are not deleted.
- Only paths inside DSH session storage are candidates, and symbolic links are not followed.

## Examples

Node (macOS, Linux, Windows):

```bash
node clients/dsh-bridge.mjs doctor
node clients/dsh-bridge.mjs models
node clients/dsh-bridge.mjs sessions --limit 20
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
node clients/dsh-bridge.mjs ask --text "Summarize this workspace" --json
node clients/dsh-bridge.mjs ask --text "Summarize this workspace" \
  --provider <provider-from-models> --model <model-from-models> --restore-default
node clients/dsh-bridge.mjs approvals
node clients/dsh-bridge.mjs approve --id <approval-id>
```

PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ping
powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 model -SessionId '<session-id>' -Provider '<provider>' -Model '<model>' -RestoreDefault
```

Raw HTTP, if you are not using a client. Do not echo the token.

```bash
INFO="${DSH_HOME:-$HOME/.dsh}/dsh-agent-bridge.json"
PORT="$(node -pe "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port" "$INFO")"
TOKEN="$(node -pe "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token" "$INFO")"
curl -sS "http://127.0.0.1:${PORT}/ping" -H "Authorization: Bearer ${TOKEN}"
```

## Plugin config

`cordis.patch.yml` ships `config: {}`. Optional keys, still bound to `127.0.0.1`:

| Key | Default | Meaning |
|---|---|---|
| `port` | `0` (random) | TCP port |
| `defaultApprovalMode` | `ui` | Mode applied to sessions created through the API |
