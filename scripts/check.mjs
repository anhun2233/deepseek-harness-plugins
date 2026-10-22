#!/usr/bin/env node
/**
 * Load both plugins and exercise Agent Bridge without the DSH desktop app.
 * Usage: node scripts/check.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const servers = []
const originalCreateServer = http.createServer
http.createServer = function patchedCreateServer(...args) {
  const server = originalCreateServer.apply(this, args)
  servers.push(server)
  return server
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assertManifest(dir, expectedName) {
  const pkg = readJson(path.join(dir, 'package.json'))
  assert(pkg.name === expectedName, `${dir} name`)
  assert(pkg.type === 'module', `${expectedName} type`)
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', `${expectedName} dsh.bundle.patch`)
  const patch = fs.readFileSync(path.join(dir, pkg.dsh.bundle.patch), 'utf8')
  assert(patch.includes(`id: ${expectedName}`), `${expectedName} patch id`)
  assert(patch.includes(`name: '${expectedName}'`), `${expectedName} patch name`)
  for (const lang of ['en', 'zh']) {
    const locale = readJson(path.join(dir, 'locale', `${lang}.json`))
    assert(typeof locale.meta?.title === 'string' && locale.meta.title.length > 0, `${expectedName} ${lang} title`)
    assert(typeof locale.meta?.description === 'string' && locale.meta.description.length > 0, `${expectedName} ${lang} description`)
  }
  return pkg
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert(result.status === 0, `${file} failed node --check\n${result.stderr}`)
}

function hostZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.length > 0) return zone
  } catch { /* fall through */ }
  return 'UTC'
}

function writeSession(home, id) {
  const dir = path.join(home, 'sessions', 'proj', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'log')
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, `${id}.json`), '{}')
  return dir
}

async function waitForDiscovery(file) {
  const start = Date.now()
  while (Date.now() - start < 4000) {
    if (fs.existsSync(file)) return readJson(file)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('discovery file was not written')
}

async function api(port, token, method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  return { status: response.status, text, body: parsed }
}

function run(bin, args, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, cwd: root })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function runNode(args, env) {
  return run(process.execPath, [path.join(root, 'clients', 'dsh-bridge.mjs'), ...args], env)
}

async function main() {
  const bridgeDir = path.join(root, 'plugins', 'dsh-agent-bridge')
  const deleteDir = path.join(root, 'plugins', 'dsh-session-delete')
  const bridgePkg = assertManifest(bridgeDir, 'dsh-agent-bridge')
  const deletePkg = assertManifest(deleteDir, 'dsh-session-delete')
  assert(bridgePkg.version === '0.1.0', 'bridge version')
  assert(deletePkg.dsh.client?.platform === 'web', 'session delete client platform')
  assert(deletePkg.dsh.client?.immediately === true, 'session delete client immediately')
  assert(deletePkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'), 'workspace inject')
  assert(deletePkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'), 'layout inject')
  assert(readJson(path.join(bridgeDir, 'locale', 'en.json')).meta.title === 'Agent Bridge', 'display name')

  for (const file of [
    path.join(bridgeDir, 'index.js'),
    path.join(deleteDir, 'index.js'),
    path.join(deleteDir, 'client.js'),
    path.join(root, 'clients', 'dsh-bridge.mjs'),
    fileURLToPath(import.meta.url),
  ]) syntaxCheck(file)

  const driveLetter = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\n/)
    lines.forEach((line, index) => {
      assert(!driveLetter.test(line), `${path.relative(root, file)}:${index + 1} contains a drive-letter path`)
    })
  }

  for (const phrase of [
    'GET /ping', 'GET /models', 'GET /workspaces', 'GET /sessions', 'POST /sessions',
    'POST /ask', 'POST /sessions/:id/prompt', 'GET /sessions/:id/messages', 'GET /sessions/:id/raw',
    'POST /sessions/:id/model', 'POST /sessions/:id/cancel', 'POST /sessions/:id/rename',
    'GET /permissions', 'POST /sessions/:id/permission', 'GET /default-model', 'POST /default-model',
    'GET /approval-mode', 'POST /approval-mode', 'POST /sessions/:id/approval-mode',
    'GET /approvals', 'POST /approvals/:id', 'POST /delete',
    'restoreDefault', 'dsh-session-delete', 'dsh-agent-bridge.json', '127.0.0.1',
  ]) {
    assert(fs.readFileSync(path.join(root, 'docs', 'API.md'), 'utf8').includes(phrase), `API.md missing ${phrase}`)
  }
  for (const file of ['AGENTS.md', 'agent-template/SKILL.md', 'agent-template/system-prompt.md', 'README.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const phrase of ['dsh-agent-bridge.json', '127.0.0.1', 'dsh-session-delete', 'DSH_HOME']) {
      assert(text.includes(phrase), `${file} missing ${phrase}`)
    }
  }
  assert(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('0.2.1-rc.2'), 'README version')
  assert(fs.existsSync(path.join(root, 'LICENSE')), 'LICENSE')

  const help = await runNode(['--help'], {})
  assert(help.status === 0, `help failed: ${help.stderr}`)
  assert(help.stdout.includes('--restore-default'), 'help mentions restore')
  assert(help.stdout.includes('--json'), 'help mentions --json')
  const missingHome = path.join(os.tmpdir(), `dsh-missing-${crypto.randomBytes(4).toString('hex')}`)
  const disabled = await runNode(['doctor', '--home', missingHome], { DSH_HOME: missingHome })
  assert(disabled.status === 1, 'doctor should fail when the bridge is off')
  assert(JSON.parse(disabled.stdout).code === 'disabled', 'doctor disabled code')
  const askOff = await runNode(['ask', '--text', 'Say hello to the agent that sent you this message.', '--home', missingHome], { DSH_HOME: missingHome })
  assert(askOff.status === 1 && askOff.stdout === '', `plain ask should not print JSON when off\n${askOff.stdout}`)
  assert(askOff.stderr.includes('enable Agent Bridge'), 'plain ask tells the user to enable the plugin')

  const hermesSkill = fs.readFileSync(path.join(root, 'agent-template', 'hermes', 'SKILL.md'), 'utf8')
  assert(hermesSkill.startsWith('---\n'), 'hermes skill frontmatter')
  const hermesDesc = hermesSkill.match(/^description: "?([^"\n]+)"?$/m)
  assert(hermesDesc && hermesDesc[1].length <= 60 && hermesDesc[1].endsWith('.'), `hermes description length ${hermesDesc && hermesDesc[1].length}`)
  assert(/^name: [a-z0-9-]{1,64}$/m.test(hermesSkill), 'hermes skill name')
  const walkthrough = fs.readFileSync(path.join(root, 'docs', 'walkthrough.md'), 'utf8')
  for (const phrase of ['Say hello', 'dsh-agent-bridge.json', 'enable Agent Bridge', 'ask --text', 'Hermes', 'Claude Code', 'Codex']) {
    assert(walkthrough.includes(phrase), `walkthrough missing ${phrase}`)
  }

  const bridge = await import(pathToFileURL(path.join(bridgeDir, 'index.js')).href)
  const sessionDelete = await import(pathToFileURL(path.join(deleteDir, 'index.js')).href)
  assert(bridge.name === 'dsh-agent-bridge' && typeof bridge.apply === 'function', 'bridge exports')
  assert(sessionDelete.name === 'dsh-session-delete' && typeof sessionDelete.apply === 'function', 'delete exports')
  assert(fs.readFileSync(path.join(bridgeDir, 'index.js'), 'utf8').includes("const VERSION = '0.1.0'"), 'VERSION const')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const disposers = []
  const logs = []
  const live = new Set(['loaded-session'])
  const snapshots = [
    { header: { id: 'child1', parentSession: 'parent1', origin: 'subagent' } },
    { header: { id: 'fork1', parentSession: 'parent1', origin: 'fork' } },
  ]
  const promptSeen = []
  const listeners = {}
  const registeredRoutes = []
  const services = {}
  const selection = { provider: 'kept-provider', model: 'kept-model', reasoningEffort: 'low' }

  function emit(event, ...args) {
    for (const fn of [...(listeners[event] || [])]) fn(...args)
  }

  const ctx = {
    logger: {
      info() {},
      warn(message) { logs.push(String(message)) },
      error(message) { logs.push(String(message)) },
      debug() {},
    },
    agentDefaultModel: {
      currentSelection() { return { ...selection } },
      async saveSelection(next) {
        selection.provider = next.provider
        selection.model = next.model
        selection.reasoningEffort = next.reasoningEffort
      },
    },
    workspaceRegistry: {
      list() {
        return [{
          id: 'ws1',
          name: 'Workspace',
          path: path.join(home, 'workspace'),
          sessionIds: [],
          detachSession: async () => {},
        }]
      },
      async archiveSession() {},
      async unpinSession() {},
      async unarchiveSession() {},
    },
    sessions: { get(id) { return live.has(id) ? { id } : undefined } },
    agents: { get() { return undefined } },
    permissionPresets: {
      catalog() { return { presets: [{ id: 'read-only' }] } },
      set() {},
      current() { return 'read-only' },
    },
    sessionPersistence: {
      root: path.join(home, 'sessions'),
      async list() { return snapshots },
      async stat(id) { return snapshots.find(item => item?.header?.id === id) },
    },
    webServer: {
      register(route) {
        registeredRoutes.push(route)
        return () => {}
      },
    },
    on(event, fn) {
      if (!listeners[event]) listeners[event] = new Set()
      listeners[event].add(fn)
      return () => listeners[event].delete(fn)
    },
    get(name) { return services[name] },
    provide(name, value) { services[name] = value },
    emit() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  ctx.sessionController = {
    async modelCatalog() { return { items: [{ provider: 'kept-provider', model: 'kept-model' }] } },
    async list() { return { items: [] } },
    async create() { return { sessionId: 'created-1' } },
    async selectModel(input) {
      await ctx.agentDefaultModel.saveSelection({
        provider: input.provider,
        model: input.model,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      })
      return { selected: ctx.agentDefaultModel.currentSelection() }
    },
    async rename() { return { renamed: true } },
    async cancel() { return { cancelled: true } },
    async resolveAgent() { return undefined },
    async inspect() {
      return {
        events: [{
          type: 'assistant/message',
          seq: 1,
          time: 1,
          data: { message: { content: [{ type: 'tool-call', id: 'call-1', name: 'example-tool', arguments: '{"path":"a"}' }] } },
        }],
      }
    },
    async prompt(input) {
      promptSeen.push({ selection: ctx.agentDefaultModel.currentSelection(), timeZone: input.clientTimeZone, sessionId: input.sessionId })
      const session = { id: input.sessionId }
      emit('session/event', session, {
        type: 'user/message', seq: 1, time: 1,
        data: { source: { kind: 'user', rpcId: input.requestId }, content: [{ type: 'text', text: 'hi' }] },
      })
      emit('session/event', session, {
        type: 'assistant/message', seq: 2, time: 2,
        data: { turn: 1, step: 1, message: { source: { provider: 'kept-provider', model: 'kept-model' }, content: [{ type: 'text', text: 'bridge-reply' }] } },
      })
      emit('session/event', session, { type: 'turn/end', seq: 3, time: 3, data: {} })
      return { accepted: true }
    },
  }

  try {
    bridge.apply(ctx, {})
    const discoveryPath = path.join(home, 'dsh-agent-bridge.json')
    const info = await waitForDiscovery(discoveryPath)
    assert(info.bind === '127.0.0.1', 'discovery bind')
    assert(Number.isInteger(info.port) && info.port > 0, 'discovery port')
    assert(typeof info.token === 'string' && /^[0-9a-f]{64}$/.test(info.token), 'token format')
    assert(info.pid === process.pid, 'discovery pid')
    const mode = fs.statSync(discoveryPath).mode & 0o777
    assert(mode === 0o600, `discovery mode is ${mode.toString(8)}`)
    const address = servers.at(-1)?.address()
    assert(address && address.address === '127.0.0.1', `server address ${JSON.stringify(address)}`)

    const missing = await api(info.port, null, 'GET', '/ping')
    assert(missing.status === 401 && missing.body?.code === 'unauthorized', 'missing token')
    assert(!missing.text.includes(info.token), '401 leaked the token')
    const wrong = await api(info.port, 'ab', 'GET', '/ping')
    assert(wrong.status === 401 && !wrong.text.includes(info.token), 'short token')

    const ping = await api(info.port, info.token, 'GET', '/ping')
    assert(ping.status === 200 && ping.body.value.pong === true && ping.body.value.plugin === 'dsh-agent-bridge', 'ping')

    const unavailable = await api(info.port, info.token, 'POST', '/delete', { sessionIds: ['parent1'] })
    assert(unavailable.status === 501 && unavailable.body.code === 'delete-unavailable', 'delete before session plugin')

    sessionDelete.apply(ctx)
    assert(typeof services.dshSessionDelete?.delete === 'function', 'dshSessionDelete service')
    assert(registeredRoutes.some(route => route.kind === 'exact' && route.path === '/dsh-session-delete/delete'), 'delete route')

    const anonymous = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value }, end() {} }
    await registeredRoutes[0].handler({ method: 'POST', headers: { 'content-type': 'application/json' } }, anonymous)
    assert(anonymous.statusCode === 403, 'browser route rejects an unauthenticated request')

    const restored = await api(info.port, info.token, 'POST', '/sessions/s1/model', {
      provider: 'other-provider', model: 'other-model', reasoningEffort: 'high', restoreDefault: true,
    })
    assert(restored.body.value.defaultRestored === true, 'restore flag')
    assert(restored.body.value.previousDefault.provider === 'kept-provider', 'previous default captured')
    assert(selection.provider === 'kept-provider' && selection.model === 'kept-model' && selection.reasoningEffort === 'low', 'default restored in memory')

    const changed = await api(info.port, info.token, 'POST', '/sessions/s1/model', {
      provider: 'other-provider', model: 'other-model',
    })
    assert(changed.body.value.defaultMayHaveChanged === true, 'model warns that the default may change')
    assert(changed.body.value.previousDefault.provider === 'kept-provider', 'unrestored call reports the previous default')
    assert(selection.provider === 'other-provider' && selection.model === 'other-model', 'default changed with the session')
    const reset = await api(info.port, info.token, 'POST', '/default-model', {
      provider: 'kept-provider', model: 'kept-model', reasoningEffort: 'low',
    })
    assert(reset.status === 200 && selection.provider === 'kept-provider' && selection.model === 'kept-model', 'default reset')

    const asked = await api(info.port, info.token, 'POST', '/ask', {
      text: 'hello', provider: 'other-provider', model: 'other-model', restoreDefault: true, timeoutSec: 5,
    })
    assert(asked.body.value.reply === 'bridge-reply', `ask reply ${asked.text}`)
    assert(asked.body.value.defaultRestored === true, 'ask restored')
    assert(promptSeen.at(-1).selection.provider === 'kept-provider', 'default restored before the prompt')
    assert(selection.provider === 'kept-provider', 'default still restored after ask')

    const zoned = await api(info.port, info.token, 'POST', '/sessions/created-1/prompt', { text: 'hi', wait: false, timeZone: 'UTC' })
    assert(zoned.body.value.accepted === true, 'prompt accepted')
    assert(promptSeen.at(-1).timeZone === 'UTC', 'explicit zone')
    const zonedDefault = await api(info.port, info.token, 'POST', '/sessions/created-1/prompt', { text: 'hi', wait: false })
    assert(promptSeen.at(-1).timeZone === hostZone(), 'host zone is derived at runtime')

    const cliRestore = await runNode([
      'model', '--session', 's1', '--provider', 'other-provider', '--model', 'other-model', '--restore-default',
    ], { DSH_HOME: home })
    assert(cliRestore.status === 0, `cli restore failed\n${cliRestore.stdout}\n${cliRestore.stderr}`)
    const cliBody = JSON.parse(cliRestore.stdout)
    assert(cliBody.value.defaultRestored === true, 'cli restore payload')
    assert(cliRestore.stderr.includes('Previous default model was restored.'), 'cli restore note')
    assert(!cliRestore.stdout.includes(info.token) && !cliRestore.stderr.includes(info.token), 'cli leaked the token')

    const cliChange = await runNode([
      'model', '--session', 's1', '--provider', 'other-provider', '--model', 'other-model',
    ], { DSH_HOME: home })
    assert(cliChange.status === 0, 'cli model')
    assert(JSON.parse(cliChange.stdout).value.defaultMayHaveChanged === true, 'cli warning payload')
    assert(cliChange.stderr.includes('--restore-default'), 'cli tells the caller how to restore')
    assert(selection.model === 'other-model', 'cli left the changed default')
    const cliReset = await runNode([
      'set-default-model', '--provider', 'kept-provider', '--model', 'kept-model', '--reasoning', 'low',
    ], { DSH_HOME: home })
    assert(cliReset.status === 0 && selection.provider === 'kept-provider', 'cli set-default-model')

    await api(info.port, info.token, 'POST', '/sessions/s1/approval-mode', { mode: 'remote' })
    const handler = [...listeners['approval/request']][0]
    const outcomePromise = handler({
      agent: { session: { id: 's1' } },
      toolName: 'example-tool',
      callId: 'call-1',
      reason: 'needs a look',
    }, () => { throw new Error('ui next should not run') })
    const listed = await api(info.port, info.token, 'GET', '/approvals')
    const approval = listed.body.value.items.find(item => item.decidable && item.callId === 'call-1')
    assert(approval && approval.arguments.includes('path'), 'approval is listed with arguments')
    const decided = await api(info.port, info.token, 'POST', `/approvals/${approval.id}`, { decision: 'allow' })
    assert(decided.body.value.outcome === 'allowed-once', 'approval allow')
    assert(await outcomePromise === 'allowed-once', 'remote approval resolves')

    await api(info.port, info.token, 'POST', '/sessions/s1/approval-mode', { mode: 'ui' })
    let releaseUi
    const uiGate = new Promise(resolve => { releaseUi = resolve })
    const uiPromise = handler({
      agent: { session: { id: 's1' } },
      toolName: 'example-tool',
      callId: 'call-2',
      reason: 'shown in the window',
    }, () => uiGate.then(() => 'from-ui'))
    const uiList = await api(info.port, info.token, 'GET', '/approvals')
    const uiItem = uiList.body.value.items.find(item => item.callId === 'call-2')
    assert(uiItem && uiItem.decidable === false, 'ui approval is not decidable here')
    const rejected = await api(info.port, info.token, 'POST', `/approvals/${uiItem.id}`, { decision: 'reject' })
    assert(rejected.status === 409, 'ui approval cannot be decided by the API')
    releaseUi()
    assert(await uiPromise === 'from-ui', 'ui approval passed through')

    const auto = await handler({
      agent: { session: { id: 'auto-session' } },
      toolName: 'example-tool',
      callId: 'call-3',
    }, () => 'from-ui')
    assert(auto === 'from-ui', 'sessions without a mode stay on ui')
    await api(info.port, info.token, 'POST', '/sessions/auto-session/approval-mode', { mode: 'auto-allow' })
    const allowed = await handler({
      agent: { session: { id: 'auto-session' } },
      toolName: 'example-tool',
      callId: 'call-4',
    }, () => { throw new Error('next') })
    assert(allowed === 'allowed-once', `auto-allow returned ${allowed}`)

    const attachment = path.join(home, 'storages', 'attachments', 'blob.bin')
    fs.mkdirSync(path.dirname(attachment), { recursive: true })
    fs.writeFileSync(attachment, 'keep')
    const canary = path.join(home, 'not-session.txt')
    fs.writeFileSync(canary, 'keep')
    for (const id of ['parent1', 'child1', 'fork1']) writeSession(home, id)
    const outside = path.join(home, 'outside-target')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep')
    try { fs.symlinkSync(outside, path.join(home, 'sessions', 'proj', 'linked-session')) } catch { /* symlink unsupported */ }

    const removed = await api(info.port, info.token, 'POST', '/delete', { sessionIds: ['parent1', 'linked-session', '..'] })
    assert(removed.status === 200 && removed.body.ok === true, `delete failed ${removed.text}`)
    assert(removed.body.value.deleted.includes('parent1') && removed.body.value.deleted.includes('child1'), 'parent and subagent deleted')
    assert(!removed.body.value.deleted.includes('fork1'), 'fork kept')
    assert(!fs.existsSync(path.join(home, 'sessions', 'proj', 'parent1')), 'parent dir gone')
    assert(!fs.existsSync(path.join(home, 'sessions', 'proj', 'child1')), 'child dir gone')
    assert(fs.existsSync(path.join(home, 'sessions', 'proj', 'fork1')), 'fork dir kept')
    assert(fs.readFileSync(attachment, 'utf8') === 'keep', 'attachment kept')
    assert(fs.readFileSync(canary, 'utf8') === 'keep', 'unrelated file kept')
    assert(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'keep', 'symlink target kept')

    writeSession(home, 'live-session')
    live.add('live-session')
    const deferred = await api(info.port, info.token, 'POST', '/delete', { sessionId: 'live-session' })
    assert(deferred.body.value.deferred.includes('live-session'), 'loaded session is deferred')
    assert(fs.existsSync(path.join(home, 'sessions', 'proj', 'live-session')), 'deferred files remain')
    const pendingPath = path.join(home, 'storages', 'dsh-session-delete.pending.json')
    assert(readJson(pendingPath).includes('live-session'), 'pending list')
    live.delete('live-session')
    const purged = await services.dshSessionDelete.purgePending()
    assert(purged.purged.includes('live-session'), 'purge finishes a deferred delete')
    assert(!fs.existsSync(path.join(home, 'sessions', 'proj', 'live-session')), 'purged files removed')

    const invalid = await services.dshSessionDelete.delete(['../nope'])
    assert(invalid.errors.some(item => item.id === '../nope'), 'path-like id rejected')
    assert(fs.readFileSync(canary, 'utf8') === 'keep', 'rejected id did not touch files')

    const doctor = await runNode(['doctor'], { DSH_HOME: home })
    assert(doctor.status === 0 && JSON.parse(doctor.stdout).value.pong === true, 'doctor ping')
    const plainAsk = await runNode(['ask', '--text', 'Say hello to the agent that sent you this message. Reply with a short greeting only.'], { DSH_HOME: home })
    assert(plainAsk.status === 0, `plain ask failed\n${plainAsk.stdout}\n${plainAsk.stderr}`)
    assert(plainAsk.stdout === 'bridge-reply\n', `plain ask stdout ${JSON.stringify(plainAsk.stdout)}`)
    assert(!plainAsk.stdout.includes('{'), 'plain ask leaked JSON')
    const jsonAsk = await runNode(['ask', '--text', 'Say hello', '--json'], { DSH_HOME: home })
    assert(jsonAsk.status === 0 && JSON.parse(jsonAsk.stdout).value.reply === 'bridge-reply', 'ask --json')

    const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'])
    if (pwsh.error?.code === 'ENOENT') {
      console.log('pwsh not on PATH; skipped PowerShell parse')
    } else {
      const parsed = spawnSync('pwsh', ['-NoProfile', '-Command', `
        $errors = $null; $tokens = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, 'clients', 'dsh-bridge.ps1')}', [ref]$tokens, [ref]$errors)
        if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.ToString() }; exit 1 }
        exit 0
      `], { encoding: 'utf8' })
      assert(parsed.status === 0, `PowerShell parse failed\n${parsed.stdout}\n${parsed.stderr}`)
      const ps1 = path.join(root, 'clients', 'dsh-bridge.ps1')
      const psPing = await run('pwsh', ['-NoProfile', '-File', ps1, 'ping'], { DSH_HOME: home })
      assert(psPing.status === 0, `PowerShell ping failed\n${psPing.stdout}\n${psPing.stderr}`)
      assert(JSON.parse(psPing.stdout).value.pong === true, 'PowerShell ping payload')
      assert(!psPing.stdout.includes(info.token), 'PowerShell leaked the token')
      const psModel = await run('pwsh', [
        '-NoProfile', '-File', ps1,
        'model', '-SessionId', 's1', '-Provider', 'other-provider', '-Model', 'other-model', '-RestoreDefault',
      ], { DSH_HOME: home })
      assert(psModel.status === 0, `PowerShell model failed\n${psModel.stdout}\n${psModel.stderr}`)
      assert(JSON.parse(psModel.stdout).value.defaultRestored === true, 'PowerShell restore')
      assert(selection.provider === 'kept-provider' && selection.model === 'kept-model', 'PowerShell restore left the default')
      const psAsk = await run('pwsh', ['-NoProfile', '-File', ps1, 'ask', '-Text', 'Say hello to the agent that sent you this message.'], { DSH_HOME: home })
      assert(psAsk.status === 0, `PowerShell ask failed\n${psAsk.stdout}\n${psAsk.stderr}`)
      assert(psAsk.stdout.trim() === 'bridge-reply', `PowerShell plain ask ${JSON.stringify(psAsk.stdout)}`)
      const psAskJson = await run('pwsh', ['-NoProfile', '-File', ps1, 'ask', '-Text', 'Say hello', '-Json'], { DSH_HOME: home })
      assert(psAskJson.status === 0 && JSON.parse(psAskJson.stdout).value.reply === 'bridge-reply', 'PowerShell ask -Json')
    }

    for (const dispose of disposers.reverse()) {
      const result = dispose()
      if (result && typeof result.then === 'function') await result
    }
    disposers.length = 0
    assert(!fs.existsSync(discoveryPath), 'discovery file removed when the plugin stops')
    let closed = false
    try {
      await fetch(`http://127.0.0.1:${info.port}/ping`, { signal: AbortSignal.timeout(500) })
    } catch { closed = true }
    assert(closed, 'server stopped')
    console.log('check ok')
  } finally {
    process.env.DSH_HOME = previousHome
    for (const dispose of disposers.reverse()) {
      try {
        const result = dispose()
        if (result && typeof result.then === 'function') await result
      } catch { /* already stopped */ }
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exit(1)
})
