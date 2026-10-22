# Clients

Both clients talk to Agent Bridge on `127.0.0.1` and read the port and bearer token from the discovery file. They do not contain a model id or a data-directory path.

| Client | Where it runs |
|---|---|
| [`dsh-bridge.mjs`](dsh-bridge.mjs) | macOS, Linux, and Windows. Node.js 18+. |
| [`dsh-bridge.ps1`](dsh-bridge.ps1) | Windows PowerShell 5.1 and PowerShell 7. PowerShell 7 also runs it on macOS and Linux. |

Discovery file: `$DSH_HOME/dsh-agent-bridge.json`, or `~/.dsh/dsh-agent-bridge.json`. Override with `--home` / `--info` or `-DshHome` / `-InfoFile`.

`ask` writes DSH's reply as plain text. `--json` / `-Json` writes the full JSON object instead. Other commands always write JSON.

```bash
node clients/dsh-bridge.mjs doctor
node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
node clients/dsh-bridge.mjs ask --text "Summarize this workspace" --restore-default --json
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 ping
powershell -NoProfile -ExecutionPolicy Bypass -File clients/dsh-bridge.ps1 model -SessionId '<session-id>' -Provider '<provider>' -Model '<model>' -RestoreDefault
```

`--restore-default` and `-RestoreDefault` put back the default model after a session model change. See [docs/API.md](../docs/API.md).

`delete` needs the `dsh-session-delete` plugin enabled. Stdout is one JSON object. A failure exits 1. Notes about the default model go to stderr, so a program can parse stdout alone.
