#!/usr/bin/env node
/**
 * Cross-platform client for the DSH Agent Bridge.
 *
 * Discovers the port and bearer token from <DSH data dir>/dsh-agent-bridge.json.
 * The data directory is --home, else $DSH_HOME, else ~/.dsh.
 * Talks only to 127.0.0.1.
 * `ask` prints the reply text on stdout. Pass --json for the full JSON object.
 * Every other command prints one JSON object. Exit 1 on failure.
 *
 * Requires Node.js 18 or newer.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DISCOVERY = 'dsh-agent-bridge.json'
const MODES = new Set(['ui', 'remote', 'auto-allow'])

const HELP = `dsh-bridge — local client for the DeepSeek Harness Agent Bridge

Usage:
  node clients/dsh-bridge.mjs <command> [options]

Discovery:
  Reads <data-dir>/${DISCOVERY} for { port, token, pid }.
  <data-dir> is --home, or $DSH_HOME, or ~/.dsh.
  The plugin writes that file only while Agent Bridge is enabled.
  Requests go to http://127.0.0.1:<port> and nowhere else.

Global options:
  --home <dir>       DSH data directory
  --info <file>      discovery JSON path (overrides --home)
  --ignore-pid       do not require the recorded pid to be running
  --timeout <sec>    wait budget for prompt/ask (default 300)
  --json             print the JSON envelope for ask (other commands already do)
  --help, -h         show this help

Commands:
  ping | doctor | status
  models
  workspaces
  sessions [--limit <n>] [--full]
  new [--workspace <id>] [--cwd <path>] [--title <text>]
      [--provider <id>] [--model <id>] [--reasoning <effort>]
      [--approval-mode ui|remote|auto-allow] [--permission <preset>]
      [--restore-default]
  ask --text <text> | --text-file <path>
      [same session options as new] [--no-wait] [--steer] [--timeout <sec>]
      [--time-zone <iana>] [--restore-default] [--json]
      Prints the reply text. --json prints the full response instead.
  prompt --session <id> (--text <text> | --text-file <path>)
      [--no-wait] [--steer] [--timeout <sec>] [--time-zone <iana>]
  messages --session <id> [--limit <n>] [--events] [--all]
  raw --session <id> [--limit <n>]
  model --session <id> --provider <id> --model <id> [--reasoning <effort>]
      [--restore-default]
  cancel --session <id>
  rename --session <id> --title <text>
  delete --session <id>[,<id2>...]
  permissions
  permission --session <id> --preset <id>
  approvals
  approve --id <approval-id>
  reject --id <approval-id>
  cancel-approval --id <approval-id>
  approval-mode --session <id> --mode ui|remote|auto-allow
  default-approval-mode [--mode ui|remote|auto-allow]
  default-model
  set-default-model --provider <id> --model <id> [--reasoning <effort>]
  call --method <VERB> --path </route> [--body <json>]

Model selection:
  Choosing a model for a session may also change DSH's default model.
  Pass --restore-default to write the previous default back afterwards.
  Provider and model ids come from the "models" command. This client has none built in.

Delete:
  "delete" needs the dsh-session-delete plugin installed and enabled.
  Files for a session that is loaded in the current run are removed when DSH exits or next starts.

Examples:
  node clients/dsh-bridge.mjs ping
  node clients/dsh-bridge.mjs models
  node clients/dsh-bridge.mjs ask --text "Say hello to the agent that sent you this message. Reply with a short greeting only."
  node clients/dsh-bridge.mjs ask --text "Summarize this workspace" --provider <provider> --model <model> --restore-default --json
  node clients/dsh-bridge.mjs prompt --session <session-id> --text "Continue"
`

let plainOutput = false

function fail(code, error) {
  if (plainOutput) {
    process.stderr.write(`${error}\n`)
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ ok: false, code, error }) + '\n')
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { opts.help = true; continue }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const eq = key.indexOf('=')
      if (eq !== -1) { opts[key.slice(0, eq)] = key.slice(eq + 1); continue }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opts[key] = true
      else { opts[key] = next; i++ }
      continue
    }
    rest.push(arg)
  }
  const command = rest[0] || (opts.help ? 'help' : 'ping')
  plainOutput = command === 'ask' && opts.json !== true && opts.help !== true
  if (rest.length > 1) fail('bad-args', `unexpected argument '${rest[1]}'`)
  return { command, opts }
}

function dshHome(opts) {
  if (typeof opts.home === 'string') return path.resolve(opts.home)
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function loadDiscovery(opts) {
  const file = typeof opts.info === 'string' ? path.resolve(opts.info) : path.join(dshHome(opts), DISCOVERY)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('disabled', `Agent Bridge is off or DSH is not running (no discovery file at ${file}). In DSH open Plugins and enable Agent Bridge. If DSH uses a custom data directory, set DSH_HOME or pass --home.`)
    }
    fail('bad-token-file', `Could not read the discovery file: ${error.message}`)
  }
  let info
  try { info = JSON.parse(text) } catch { fail('bad-token-file', 'Discovery file is not valid JSON.') }
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string' || info.token.length === 0) {
    fail('bad-token-file', 'Discovery file is missing port or token.')
  }
  if (opts['ignore-pid'] !== true && !pidAlive(info.pid)) {
    fail('stale', `Discovery file points at pid ${info.pid}, which is not running. Start DSH and enable Agent Bridge.`)
  }
  return info
}

function optString(opts, name) {
  const value = opts[name]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

function requireString(opts, name, command) {
  const value = optString(opts, name)
  if (value === undefined) fail('bad-args', `--${name} is required for '${command}'`)
  return value
}

function intOpt(opts, name, fallback) {
  if (opts[name] === undefined) return fallback
  const n = Number(opts[name])
  if (!Number.isInteger(n)) fail('bad-args', `--${name} must be an integer`)
  return n
}

function readText(opts, command, required) {
  if (typeof opts.text === 'string') return opts.text
  if (typeof opts['text-file'] === 'string') {
    try { return fs.readFileSync(opts['text-file'], 'utf8') }
    catch (error) { fail('bad-args', `Could not read --text-file: ${error.message}`) }
  }
  if (required) fail('bad-args', `--text or --text-file is required for '${command}'`)
  return undefined
}

function modeOpt(opts, name, command, { required }) {
  const value = opts[name]
  if (value === undefined || value === true) {
    if (required) fail('bad-args', `--${name} is required for '${command}'`)
    return undefined
  }
  if (!MODES.has(value)) fail('bad-args', `--${name} must be ui, remote, or auto-allow`)
  return value
}

function modelBody(opts, { restore, requireBoth }) {
  const provider = optString(opts, 'provider')
  const model = optString(opts, 'model')
  if (requireBoth && (!provider || !model)) fail('bad-args', '--provider and --model are required')
  if ((provider && !model) || (!provider && model)) fail('bad-args', '--provider and --model must be set together')
  const body = {}
  if (provider) body.provider = provider
  if (model) body.model = model
  const reasoning = optString(opts, 'reasoning')
  if (reasoning) body.reasoningEffort = reasoning
  if (restore && opts['restore-default'] === true && provider && model) body.restoreDefault = true
  return body
}

function sessionIds(opts, command) {
  const raw = requireString(opts, 'session', command)
  const ids = raw.split(/[,;\s]+/).filter(id => id.length > 0)
  if (ids.length === 0) fail('bad-args', `--session is required for '${command}'`)
  return ids
}

function oneSession(opts, command) {
  const ids = sessionIds(opts, command)
  if (ids.length !== 1) fail('bad-args', `--session must be a single id for '${command}'`)
  return ids[0]
}

function build(command, opts) {
  const limit = intOpt(opts, 'limit', command === 'raw' ? 20 : 50)
  const timeoutSec = intOpt(opts, 'timeout', 300)
  switch (command) {
    case 'ping':
    case 'doctor':
    case 'status':
      return { method: 'GET', path: '/ping' }
    case 'models':
      return { method: 'GET', path: '/models' }
    case 'workspaces':
      return { method: 'GET', path: '/workspaces' }
    case 'sessions': {
      const q = new URLSearchParams({ limit: String(limit) })
      if (opts.full === true) q.set('full', '1')
      return { method: 'GET', path: `/sessions?${q}` }
    }
    case 'new': {
      const body = modelBody(opts, { restore: true, requireBoth: false })
      const workspace = optString(opts, 'workspace')
      const cwd = optString(opts, 'cwd')
      const title = optString(opts, 'title')
      const permission = optString(opts, 'permission')
      const approvalMode = modeOpt(opts, 'approval-mode', command, { required: false })
      if (workspace) body.workspaceId = workspace
      if (cwd) body.cwd = cwd
      if (title) body.title = title
      if (permission) body.permission = permission
      if (approvalMode) body.approvalMode = approvalMode
      return { method: 'POST', path: '/sessions', body }
    }
    case 'ask': {
      const body = modelBody(opts, { restore: true, requireBoth: false })
      body.text = readText(opts, command, true)
      body.timeoutSec = timeoutSec
      body.wait = opts['no-wait'] !== true
      if (opts.steer === true) body.mode = 'steer'
      const workspace = optString(opts, 'workspace')
      const cwd = optString(opts, 'cwd')
      const title = optString(opts, 'title')
      const permission = optString(opts, 'permission')
      const approvalMode = modeOpt(opts, 'approval-mode', command, { required: false })
      const timeZone = optString(opts, 'time-zone')
      if (workspace) body.workspaceId = workspace
      if (cwd) body.cwd = cwd
      if (title) body.title = title
      if (permission) body.permission = permission
      if (approvalMode) body.approvalMode = approvalMode
      if (timeZone) body.timeZone = timeZone
      return { method: 'POST', path: '/ask', body, timeoutSec, plain: opts.json !== true }
    }
    case 'prompt': {
      const id = oneSession(opts, command)
      const body = {
        text: readText(opts, command, true),
        wait: opts['no-wait'] !== true,
        timeoutSec,
        mode: opts.steer === true ? 'steer' : 'queue',
      }
      const timeZone = optString(opts, 'time-zone')
      if (timeZone) body.timeZone = timeZone
      return { method: 'POST', path: `/sessions/${encodeURIComponent(id)}/prompt`, body, timeoutSec }
    }
    case 'messages': {
      const id = oneSession(opts, command)
      const q = new URLSearchParams({ limit: String(limit) })
      if (opts.events === true) q.set('events', '1')
      if (opts.all === true) q.set('all', '1')
      return { method: 'GET', path: `/sessions/${encodeURIComponent(id)}/messages?${q}` }
    }
    case 'raw': {
      const id = oneSession(opts, command)
      return { method: 'GET', path: `/sessions/${encodeURIComponent(id)}/raw?limit=${limit}` }
    }
    case 'model': {
      const id = oneSession(opts, command)
      const body = modelBody(opts, { restore: true, requireBoth: true })
      return { method: 'POST', path: `/sessions/${encodeURIComponent(id)}/model`, body }
    }
    case 'cancel': {
      const id = oneSession(opts, command)
      return { method: 'POST', path: `/sessions/${encodeURIComponent(id)}/cancel`, body: {} }
    }
    case 'rename': {
      const id = oneSession(opts, command)
      return { method: 'POST', path: `/sessions/${encodeURIComponent(id)}/rename`, body: { title: requireString(opts, 'title', command) } }
    }
    case 'delete':
      return { method: 'POST', path: '/delete', body: { sessionIds: sessionIds(opts, command) } }
    case 'permissions':
      return { method: 'GET', path: '/permissions' }
    case 'permission': {
      const id = oneSession(opts, command)
      return { method: 'POST', path: `/sessions/${encodeURIComponent(id)}/permission`, body: { preset: requireString(opts, 'preset', command) } }
    }
    case 'approvals':
      return { method: 'GET', path: '/approvals' }
    case 'approve':
      return { method: 'POST', path: `/approvals/${encodeURIComponent(requireString(opts, 'id', command))}`, body: { decision: 'allow' } }
    case 'reject':
      return { method: 'POST', path: `/approvals/${encodeURIComponent(requireString(opts, 'id', command))}`, body: { decision: 'reject' } }
    case 'cancel-approval':
      return { method: 'POST', path: `/approvals/${encodeURIComponent(requireString(opts, 'id', command))}`, body: { decision: 'cancel' } }
    case 'approval-mode': {
      const id = oneSession(opts, command)
      return {
        method: 'POST',
        path: `/sessions/${encodeURIComponent(id)}/approval-mode`,
        body: { mode: modeOpt(opts, 'mode', command, { required: true }) },
      }
    }
    case 'default-approval-mode': {
      const mode = modeOpt(opts, 'mode', command, { required: false })
      if (!mode) return { method: 'GET', path: '/approval-mode' }
      return { method: 'POST', path: '/approval-mode', body: { mode } }
    }
    case 'default-model':
      return { method: 'GET', path: '/default-model' }
    case 'set-default-model':
      return { method: 'POST', path: '/default-model', body: modelBody(opts, { restore: false, requireBoth: true }) }
    case 'call': {
      const method = requireString(opts, 'method', command).toUpperCase()
      let urlPath = requireString(opts, 'path', command)
      if (!urlPath.startsWith('/')) urlPath = `/${urlPath}`
      let body
      if (typeof opts.body === 'string') {
        try { body = JSON.parse(opts.body) } catch { fail('bad-args', '--body is not valid JSON') }
      }
      return { method, path: urlPath, body }
    }
    default:
      fail('bad-args', `unknown command '${command}'. Pass --help for usage.`)
  }
}

function noteModel(payload) {
  const value = payload?.value
  if (!value || typeof value !== 'object') return
  if (value.defaultRestored === true) {
    process.stderr.write('Previous default model was restored.\n')
    return
  }
  if (value.defaultMayHaveChanged === true) {
    const prev = value.previousDefault
    const who = prev && typeof prev.provider === 'string' && typeof prev.model === 'string'
      ? ` Previous default: ${prev.provider}/${prev.model}.`
      : ''
    process.stderr.write(`Selecting a model may change DSH's default model.${who} Re-run with --restore-default to restore it.\n`)
  }
}

async function request(info, spec) {
  const timeoutSec = spec.timeoutSec ?? 0
  const timeoutMs = Math.max((timeoutSec + 60) * 1000, 90_000)
  const headers = { authorization: `Bearer ${info.token}`, accept: 'application/json' }
  let payload
  if (spec.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(spec.body)
  }
  let response
  try {
    response = await fetch(`http://127.0.0.1:${info.port}${spec.path}`, {
      method: spec.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    fail('unreachable', `Could not reach Agent Bridge at 127.0.0.1:${info.port}: ${error.message}`)
  }
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  if (!parsed || typeof parsed !== 'object') fail('bad-response', `Bridge returned non-JSON (HTTP ${response.status}).`)
  if (spec.plain) {
    writePlainAsk(parsed, response)
    return
  }
  process.stdout.write(JSON.stringify(parsed) + '\n')
  noteModel(parsed)
  if (!response.ok || parsed.ok === false) process.exit(1)
}

function writePlainAsk(parsed, response) {
  if (!response.ok || parsed.ok === false) {
    process.stderr.write(`${parsed.error || 'request failed'}\n`)
    process.exit(1)
  }
  noteModel(parsed)
  const value = parsed.value ?? {}
  if (value.reply === undefined && value.status === undefined) {
    process.stdout.write(`accepted ${value.requestId}\n`)
    return
  }
  const reply = typeof value.reply === 'string' ? value.reply : ''
  if (value.status && value.status !== 'turn-ended') {
    process.stderr.write(`Turn status: ${value.status}\n`)
    if (reply.length > 0) process.stdout.write(reply.endsWith('\n') ? reply : `${reply}\n`)
    process.exit(1)
  }
  if (reply.length === 0) process.stderr.write('DSH returned an empty reply.\n')
  process.stdout.write(reply.endsWith('\n') ? reply : `${reply}\n`)
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (opts.help || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  const info = loadDiscovery(opts)
  const spec = build(command, opts)
  await request(info, spec)
}

main().catch((error) => fail('error', error instanceof Error ? error.message : String(error)))
