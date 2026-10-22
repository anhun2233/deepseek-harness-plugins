---
name: dsh-agent-bridge
description: Operate a local DeepSeek Harness desktop app.
version: 0.1.0
author: deepseek-harness-plugins contributors
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [DeepSeek, Desktop, Bridge]
    requires_toolsets: [terminal]
---

# DeepSeek Harness bridge

Operate a local DeepSeek Harness (DSH) desktop app through the Agent Bridge plugin. This skill does not talk to a cloud API and it does not embed a model id. The bridge is off until a person enables it.

## When to Use

- The user asks you to operate, drive, or talk to their DeepSeek Harness app.
- The user asks DSH to say hello, answer a question, or do a task in a DSH session.
- You need to check whether Agent Bridge is enabled.

Don't use this for tasks that do not involve the local DSH app. Don't use it to guess ports, scan the network, or call any host other than `127.0.0.1`.

## Prerequisites

- DeepSeek Harness desktop is installed. Agent Bridge is the plugin in `plugins/dsh-agent-bridge` of this repository. It listens only while it is enabled on DSH's Plugins page.
- Node.js 18 or newer, so you can run `clients/dsh-bridge.mjs`.
- The client file. Use `clients/dsh-bridge.mjs` when this repository is the working directory. Otherwise use the path the user gave you. Do not search the whole disk for it.
- Data directory: `$DSH_HOME` if set, otherwise `~/.dsh`. If DSH uses another directory, the user must set `DSH_HOME` or you pass `--home`. Do not invent a path.

## How to Run

Use the terminal tool. `ask` prints DSH's reply as plain text on stdout. Pass `--json` only when you need the raw envelope.

```bash
node clients/dsh-bridge.mjs doctor
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

## Procedure

The user said: "go operate my DeepSeek Harness and have it say hello to you."

1. Resolve the data directory (`$DSH_HOME` or `~/.dsh`). Look for `<data-dir>/dsh-agent-bridge.json`. You can do that by running `doctor` instead of opening the file, which avoids printing the token.
2. If the file is missing, `doctor` and `ask` exit 1. For `ask`, stderr says to enable Agent Bridge and stdout is empty. Stop. Tell the user: open DeepSeek Harness, go to Plugins, enable **Agent Bridge**, then ask again. Do not scan ports and do not invent a token.
3. If `doctor` prints `{"ok":true,...,"pong":true}`, the bridge is on. Run:

```bash
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
```

4. On exit 0, stdout is the greeting and nothing else. Relay that text to the user as what DSH said. Do not wrap it in JSON and do not add a model id.
5. On exit 1, read stderr. If it says the bridge is off, use step 2. If it says the turn timed out, tell the user DSH did not finish and quote any partial stdout.

Omit `--provider` and `--model` on this call so DSH keeps its current default model. If the user names a model, copy the ids from `node clients/dsh-bridge.mjs models` and add `--restore-default` unless they want that model to become the default. `--restore-default` writes a note to stderr. Stdout stays the reply.

## Quick Reference

```bash
node clients/dsh-bridge.mjs doctor
node clients/dsh-bridge.mjs models
node clients/dsh-bridge.mjs sessions --limit 20
node clients/dsh-bridge.mjs ask --text "..."
node clients/dsh-bridge.mjs ask --text "..." --json
node clients/dsh-bridge.mjs prompt --session <session-id> --text "Continue"
```

`doctor`, `models`, `sessions`, and `prompt` print one JSON object. `ask` prints text unless `--json` is set. PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ask -Text "..."` and `-Json` for the envelope.

Permanent delete (`delete`) needs the separate `dsh-session-delete` plugin enabled. Confirm with the user first. It does not remove attachments.

## Pitfalls

- A missing discovery file means the plugin is off or DSH is not running. It does not mean you should try another port.
- Never print the `token` field, put it in a command line, or send it anywhere except the client's own `Authorization` header. Prefer the client.
- Connect only to `127.0.0.1`. The server does not bind other addresses.
- Plain `ask` stdout is the reply. Parsing it as JSON will fail. Use `--json` when you need `status`, `sessionId`, or `previousDefault`.
- `auto-allow` approves every tool request in that session. Do not set it unless the user explicitly asks.
- Approval mode `ui` is the default: the person answers inside the DSH window.

## Verification

- `node clients/dsh-bridge.mjs doctor` exits 0 and the JSON has `value.pong` true.
- The hello `ask` exits 0 and stdout is a short greeting with no JSON braces.
- The user received that greeting, relayed by you, as DSH's reply.
