/**
 * Agent Bridge — Host plugin for DeepSeek Harness.
 *
 * While this plugin is mounted (enabled on the Plugins page) it serves a JSON
 * control API on 127.0.0.1 at a random port, protected by a random Bearer token.
 * It writes <DSH data dir>/dsh-agent-bridge.json = { bind, port, token, pid, startedAt, version }.
 * The data directory is process.env.DSH_HOME when that is set, otherwise ~/.dsh.
 * Unmounting closes the server and deletes that file. A new token is generated on every start.
 *
 * No dependencies: Node built-ins plus Host services injected by the loader.
 * Permanent delete is delegated to the dsh-session-delete plugin (service id dshSessionDelete).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-agent-bridge'
export const inject = ['sessionController', 'workspaceRegistry', 'agentDefaultModel', 'sessions', 'permissionPresets']

const VERSION = '0.1.0'
const MAX_BODY = 1024 * 1024
const DISCOVERY_FILE = 'dsh-agent-bridge.json'
const DELETE_SERVICE = 'dshSessionDelete'

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.length > 0 ? env : path.join(os.homedir(), '.dsh')
}

function hostTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.length > 0) return zone
  } catch { /* use UTC when the runtime cannot name a zone */ }
  return 'UTC'
}

function errorText(error) {
  if (error === undefined || error === null) return String(error)
  const parts = []
  let current = error
  for (let i = 0; i < 5 && current; i++) {
    parts.push(current.message ?? String(current))
    current = current.cause
  }
  return parts.join(' <- ')
}

function errorCode(error) {
  return error?.code ?? error?.remote?.code ?? error?.name ?? 'error'
}

/** Visible text of one message's content blocks. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
}

function toolCalls(content) {
  if (!Array.isArray(content)) return []
  return content.filter(b => b && b.type === 'tool-call').map(b => ({
    id: b.id, name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments.slice(0, 4000) : b.arguments ?? b.input,
  }))
}

/** Text of an assistant settlement: content blocks first, compact stream as fallback. */
function assistantText(data) {
  const fromContent = contentText(data?.message?.content)
  if (fromContent.length > 0) return fromContent
  if (!Array.isArray(data?.stream)) return ''
  return data.stream.filter(r => r && r.type === 'text-chunks').map(r => r.texts.join('')).join('')
}

/** Reduce one durable session event to a readable row, or undefined to skip it. */
function eventRow(event) {
  const d = event.data
  switch (event.type) {
    case 'user/message':
      return { seq: event.seq, time: event.time, role: 'user', source: d?.source?.kind, text: contentText(d?.content) }
    case 'assistant/message':
      return {
        seq: event.seq, time: event.time, role: 'assistant', turn: d?.turn, step: d?.step,
        provider: d?.message?.source?.provider, model: d?.message?.source?.model,
        text: assistantText(d), toolCalls: toolCalls(d?.message?.content),
      }
    case 'tool/result':
      return {
        seq: event.seq, time: event.time, role: 'tool', callId: d?.message?.toolCallId,
        text: contentText(d?.message?.content).slice(0, 4000), isError: d?.message?.isError ?? d?.isError,
      }
    case 'turn/start':
    case 'turn/end':
      return { seq: event.seq, time: event.time, role: 'event', type: event.type, data: d }
    case 'approval/asked':
    case 'approval/decided':
      return { seq: event.seq, time: event.time, role: 'event', type: event.type, data: d }
    default:
      return undefined
  }
}

function sessionIdsFrom(body) {
  const raw = body?.sessionIds !== undefined ? body.sessionIds : body?.sessionId
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return raw.split(/[,;\s]+/).filter(id => id.length > 0)
  return []
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

export function apply(ctx, config = {}) {
  const log = (level, msg) => { try { ctx.logger?.[level]?.(`dsh-agent-bridge: ${msg}`) } catch { /* ignore */ } }
  const file = path.join(dshHome(), DISCOVERY_FILE)
  /** sessionId -> 'ui' | 'remote' | 'auto-allow' */
  const approvalModes = new Map()
  let defaultApprovalMode = ['ui', 'remote', 'auto-allow'].includes(config.defaultApprovalMode) ? config.defaultApprovalMode : 'ui'
  /** id -> pending approval record */
  const pending = new Map()

  // ---------- approvals ----------
  ctx.on('approval/request', (request, next) => {
    const agent = request?.agent
    const sessionId = agent?.session?.id ?? agent?.id
    const mode = approvalModes.get(sessionId) ?? 'ui'
    const id = crypto.randomUUID()
    const record = {
      id, sessionId, mode, toolName: request.toolName, callId: request.callId,
      reason: request.reason, createdAt: new Date().toISOString(),
    }
    if (mode === 'auto-allow') {
      log('info', `auto-allowed ${request.toolName} in ${sessionId}`)
      return Promise.resolve('allowed-once')
    }
    if (mode === 'ui') {
      // Pass through to DSH's own prompt; listed for visibility only.
      pending.set(id, { ...record, decidable: false })
      const settle = () => pending.delete(id)
      const result = next()
      Promise.resolve(result).then(settle, settle)
      return result
    }
    // mode === 'remote': held until the control API decides.
    return new Promise((resolve) => {
      const finish = (outcome) => {
        if (!pending.has(id)) return
        pending.delete(id)
        request.signal?.removeEventListener?.('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => finish('cancelled')
      if (request.signal?.aborted) { resolve('cancelled'); return }
      request.signal?.addEventListener?.('abort', onAbort, { once: true })
      pending.set(id, { ...record, decidable: true, finish })
    })
  }, { prepend: true })

  ctx.effect(() => () => {
    for (const item of pending.values()) item.finish?.('cancelled')
    pending.clear()
  }, 'dsh-agent-bridge: pending approvals')

  // ---------- turn waiting ----------
  /** Wait for the turn that consumes the prompt with rpcId === requestId. */
  function waitForTurn(sessionId, requestId, timeoutMs) {
    const state = { userSeq: undefined, rows: [], errors: [], done: false }
    let resolveFn
    const promise = new Promise((r) => { resolveFn = r })
    const finish = (status) => {
      if (state.done) return
      state.done = true
      clearTimeout(timer)
      disposeEvent(); disposeError()
      const assistant = state.rows.filter(r => r.role === 'assistant')
      resolveFn({
        status,
        reply: assistant.map(r => r.text).filter(t => t && t.length > 0).join('\n\n'),
        lastReply: [...assistant].reverse().find(r => r.text)?.text ?? '',
        errors: state.errors,
        events: state.rows,
      })
    }
    const disposeEvent = ctx.on('session/event', (session, event) => {
      if (session?.id !== sessionId) return
      if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) { state.userSeq = event.seq; return }
      if (state.userSeq === undefined) return
      const row = eventRow(event)
      if (row && row.role !== 'user') state.rows.push(row)
      if (event.type === 'turn/end') finish('turn-ended')
    })
    const disposeError = ctx.on('agent/error', (payload) => {
      const agent = payload?.agent
      if ((agent?.session?.id ?? agent?.id) !== sessionId) return
      state.errors.push(errorText(payload?.error))
    })
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    return { promise, cancel: () => finish('aborted') }
  }

  // ---------- helpers ----------
  const sc = () => ctx.sessionController
  const signal = () => AbortSignal.timeout(60_000)

  function workspaceRows() {
    return ctx.workspaceRegistry.list().map(w => ({
      id: w.id, name: w.name ?? w.title ?? w.label, path: w.path,
      sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : undefined,
    }))
  }

  async function sessionEvents(sessionId) {
    const inspection = await sc().inspect(sessionId)
    return inspection.events ?? []
  }

  async function resolveToolArgs(sessionId, callId) {
    if (!callId) return undefined
    try {
      const events = await sessionEvents(sessionId)
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.type !== 'assistant/message') continue
        const call = toolCalls(e.data?.message?.content).find(c => c.id === callId)
        if (call) return call.arguments
      }
    } catch { /* best effort */ }
    return undefined
  }

  /** Fields DSH's default-model setter accepts. Undefined when the selection cannot be restored. */
  function selectionFields(sel) {
    if (!sel || typeof sel !== 'object') return undefined
    const provider = typeof sel.provider === 'string' ? sel.provider : undefined
    const model = typeof sel.model === 'string' ? sel.model : undefined
    if (!provider || !model) return undefined
    const out = { provider, model }
    if (typeof sel.reasoningEffort === 'string' && sel.reasoningEffort.length > 0) out.reasoningEffort = sel.reasoningEffort
    return out
  }

  /**
   * selectModel may also persist the choice as DSH's default model.
   * When restore is true, write the previous default back after the selection.
   */
  async function applyModelSelection(restore, selectFn) {
    let previousDefault
    try { previousDefault = ctx.agentDefaultModel.currentSelection() } catch { previousDefault = undefined }
    const result = await selectFn()
    let defaultRestored = false
    let restoreError
    if (restore) {
      const prev = selectionFields(previousDefault)
      if (!prev) restoreError = 'no previous default model to restore'
      else {
        try {
          await ctx.agentDefaultModel.saveSelection(prev)
          defaultRestored = true
        } catch (error) {
          restoreError = errorText(error)
        }
      }
    }
    const extra = {
      previousDefault: previousDefault ?? null,
      defaultMayHaveChanged: !defaultRestored,
      defaultRestored,
    }
    if (restoreError) extra.restoreError = restoreError
    if (result && typeof result === 'object' && !Array.isArray(result)) return { ...result, ...extra }
    return { result, ...extra }
  }

  function modelInput(sessionId, body) {
    return {
      sessionId,
      provider: body.provider,
      model: body.model,
      ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
    }
  }

  // ---------- routes ----------
  async function route(method, parts, query, body) {
    const [a, b, c] = parts
    if (method === 'GET' && a === 'ping') {
      return { pong: true, plugin: name, version: VERSION, bind: '127.0.0.1', pid: process.pid }
    }
    if (method === 'GET' && a === 'models') return await sc().modelCatalog()
    if (method === 'GET' && a === 'permissions') return ctx.permissionPresets.catalog()
    if (method === 'GET' && a === 'workspaces') return { items: workspaceRows() }
    if (a === 'default-model') {
      if (method === 'GET') return { selected: ctx.agentDefaultModel.currentSelection() }
      if (method === 'POST') {
        if (!body?.provider || !body?.model) throw new HttpError(400, 'bad-request', 'provider and model are required')
        const sel = { provider: body.provider, model: body.model, ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}) }
        await ctx.agentDefaultModel.saveSelection(sel)
        return { selected: ctx.agentDefaultModel.currentSelection() }
      }
    }
    if (a === 'approval-mode' && !b) {
      if (method === 'GET') return { defaultForNewSessions: defaultApprovalMode, sessions: Object.fromEntries(approvalModes) }
      if (method === 'POST') {
        if (!['ui', 'remote', 'auto-allow'].includes(body?.mode)) throw new HttpError(400, 'bad-request', 'mode must be ui, remote or auto-allow')
        defaultApprovalMode = body.mode
        return { defaultForNewSessions: defaultApprovalMode }
      }
    }
    if (a === 'approvals') {
      if (method === 'GET' && !b) {
        const items = []
        for (const p of pending.values()) {
          const { finish, ...rest } = p
          items.push({ ...rest, arguments: await resolveToolArgs(p.sessionId, p.callId) })
        }
        return { items }
      }
      if (method === 'POST' && b) {
        const p = pending.get(b)
        if (!p) throw new HttpError(404, 'not-found', `no pending approval ${b}`)
        if (!p.decidable) throw new HttpError(409, 'not-decidable', 'this approval is shown in the DSH window (session mode "ui"); answer it there, or set the session mode to "remote" for future requests')
        const decision = body?.decision
        const outcome = decision === 'allow' ? 'allowed-once' : decision === 'reject' ? 'rejected' : decision === 'cancel' ? 'cancelled' : undefined
        if (!outcome) throw new HttpError(400, 'bad-request', 'decision must be allow, reject or cancel')
        p.finish(outcome)
        return { id: b, outcome }
      }
    }
    if (method === 'POST' && a === 'ask') {
      // One shot: new session (+ optional model) then prompt and wait for the reply.
      const created = await route('POST', ['sessions'], query, { ...body, text: undefined })
      const answer = await route('POST', ['sessions', created.sessionId, 'prompt'], query, {
        text: body?.text,
        wait: body?.wait,
        timeoutSec: body?.timeoutSec,
        mode: body?.mode,
        timeZone: body?.timeZone,
      })
      return { ...created, ...answer }
    }
    if (method === 'POST' && a === 'delete') {
      // Permanent delete through dsh-session-delete (must be installed and enabled).
      const service = ctx.get(DELETE_SERVICE)
      if (!service) throw new HttpError(501, 'delete-unavailable', 'Permanent delete is unavailable. Install and enable the dsh-session-delete plugin.')
      const ids = sessionIdsFrom(body)
      if (ids.length === 0 || ids.some(id => typeof id !== 'string' || id.length === 0)) {
        throw new HttpError(400, 'bad-request', 'sessionIds is required')
      }
      for (const id of ids) approvalModes.delete(id)
      return await service.delete(ids)
    }
    if (a === 'sessions') {
      if (!b) {
        if (method === 'GET') {
          const listed = await sc().list({}, signal())
          const limit = Number(query.get('limit') ?? 50)
          const items = (listed.items ?? []).slice(0, limit)
          if (query.get('full') === '1') return { items }
          return {
            items: items.map((it) => {
              const v = it.projections?.values ?? {}
              return {
                sessionId: it.sessionId, title: v.title ?? null, cwd: it.cwd, running: it.running, blank: it.blank,
                updatedAt: it.updatedAt ? new Date(it.updatedAt).toISOString() : undefined,
                model: v.modelSelection?.next ?? v.modelSelection?.lastUsed ?? null,
                permission: v.permissions?.currentValue, turns: v.sessionStats?.turns,
                approvalMode: approvalModes.get(it.sessionId) ?? 'ui',
                pendingQuestions: Array.isArray(v.userQuestions?.active) ? v.userQuestions.active.length : undefined,
              }
            }),
          }
        }
        if (method === 'POST') {
          if ((body?.provider && !body?.model) || (!body?.provider && body?.model)) {
            throw new HttpError(400, 'bad-request', 'provider and model must be set together')
          }
          let workspaceId = body?.workspaceId
          const cwd = body?.cwd
          if (!workspaceId && !cwd) workspaceId = ctx.workspaceRegistry.list()[0]?.id
          const created = await sc().create({ ...(workspaceId ? { workspaceId } : {}), ...(cwd && !workspaceId ? { cwd } : {}) })
          const mode = ['ui', 'remote', 'auto-allow'].includes(body?.approvalMode) ? body.approvalMode : defaultApprovalMode
          approvalModes.set(created.sessionId, mode)
          let modelSelection
          if (body?.provider && body?.model) {
            modelSelection = await applyModelSelection(body.restoreDefault === true, () => sc().selectModel(modelInput(created.sessionId, body)))
          }
          if (body?.title) await sc().rename({ sessionId: created.sessionId, title: String(body.title) })
          if (body?.permission) await route('POST', ['sessions', created.sessionId, 'permission'], query, { preset: body.permission })
          return { sessionId: created.sessionId, workspaceId, approvalMode: mode, ...(modelSelection ?? {}) }
        }
      }
      const sessionId = b
      if (method === 'POST' && c === 'model') {
        if (!body?.provider || !body?.model) throw new HttpError(400, 'bad-request', 'provider and model are required')
        return await applyModelSelection(body?.restoreDefault === true, () => sc().selectModel(modelInput(sessionId, body)))
      }
      if (method === 'POST' && c === 'approval-mode') {
        if (!['ui', 'remote', 'auto-allow'].includes(body?.mode)) throw new HttpError(400, 'bad-request', 'mode must be ui, remote or auto-allow')
        approvalModes.set(sessionId, body.mode)
        return { sessionId, mode: body.mode }
      }
      if (method === 'POST' && c === 'permission') {
        const preset = body?.preset
        if (typeof preset !== 'string' || preset.length === 0) throw new HttpError(400, 'bad-request', 'preset is required (see GET /permissions)')
        let session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          const resolved = await sc().resolveAgent(sessionId)
          session = resolved?.agent?.session ?? resolved?.value?.session ?? ctx.sessions.get(sessionId)
        }
        if (session === undefined) throw new HttpError(404, 'not-found', `session ${sessionId} is not loaded`)
        ctx.permissionPresets.set(session, preset)
        return { sessionId, permission: ctx.permissionPresets.current(session) }
      }
      if (method === 'POST' && c === 'rename') return await sc().rename({ sessionId, title: String(body?.title ?? '') })
      if (method === 'POST' && c === 'cancel') return await sc().cancel({ sessionId })
      if (method === 'POST' && c === 'prompt') {
        const text = body?.text
        if (typeof text !== 'string' || !/\S/.test(text)) throw new HttpError(400, 'bad-request', 'text is required')
        const requestId = crypto.randomUUID()
        const wait = body?.wait !== false
        const timeoutMs = Math.min(Math.max(Number(body?.timeoutSec ?? 300), 5), 3600) * 1000
        const waiter = wait ? waitForTurn(sessionId, requestId, timeoutMs) : undefined
        const timeZone = typeof body?.timeZone === 'string' && body.timeZone.length > 0 ? body.timeZone : hostTimeZone()
        try {
          await sc().prompt({
            requestId,
            sessionId,
            mode: body?.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: timeZone,
          }, signal())
        } catch (error) {
          waiter?.cancel()
          throw error
        }
        if (!waiter) return { accepted: true, requestId }
        const result = await waiter.promise
        return { accepted: true, requestId, ...result }
      }
      if (method === 'GET' && c === 'messages') {
        const events = await sessionEvents(sessionId)
        const rows = events.map(eventRow).filter(r => r !== undefined)
        const limit = Number(query.get('limit') ?? 50)
        const includeEvents = query.get('events') === '1'
        const all = query.get('all') === '1'
        const visible = all ? rows : rows.filter(r => !(r.role === 'user' && r.source && r.source !== 'user'))
        const filtered = includeEvents ? visible : visible.filter(r => r.role !== 'event')
        return { sessionId, total: filtered.length, items: filtered.slice(-limit) }
      }
      if (method === 'GET' && c === 'raw') {
        const events = await sessionEvents(sessionId)
        const limit = Number(query.get('limit') ?? 20)
        return { items: events.slice(-limit).map(e => JSON.parse(JSON.stringify(e, (k, v) => typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v))) }
      }
    }
    throw new HttpError(404, 'not-found', `no route ${method} /${parts.join('/')}`)
  }

  // The bundle toggle mounts this plugin inside DSH's HMR transaction, and Node
  // async context would leak that "inside a transaction" mark into every request
  // served later, so config writes (default model) would fail with
  // "HMR transactions cannot be nested". Run the server outside that context.
  const outsideHmr = (fn) => {
    try {
      const hmr = ctx.get('hmr')
      const als = hmr?.executing
      if (als && typeof als.exit === 'function') return als.exit(fn)
    } catch { /* fall through */ }
    return fn()
  }

  // ---------- server ----------
  ctx.effect(() => outsideHmr(() => {
    const token = crypto.randomBytes(32).toString('hex')
    const server = http.createServer((req, res) => {
      const send = (status, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text)
      }
      const remote = req.socket.remoteAddress ?? ''
      if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return send(403, { ok: false, code: 'forbidden', error: 'loopback only' })
      const auth = req.headers.authorization ?? ''
      const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '')
      const expected = Buffer.from(token)
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return send(401, { ok: false, code: 'unauthorized', error: 'missing or wrong Bearer token' })
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) { send(413, { ok: false, code: 'too-large', error: 'body too large' }); req.destroy() } else chunks.push(chunk)
      })
      req.on('end', async () => {
        if (res.writableEnded) return
        let body
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          body = raw.trim().length > 0 ? JSON.parse(raw) : {}
        } catch {
          return send(400, { ok: false, code: 'bad-json', error: 'body is not valid JSON' })
        }
        try {
          const value = await route(req.method ?? 'GET', parts, url.searchParams, body)
          send(200, { ok: true, value })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          send(status, { ok: false, code: errorCode(error), error: errorText(error) })
        }
      })
    })
    server.listen(Number(config.port ?? 0), '127.0.0.1', () => {
      const address = server.address()
      const info = {
        bind: '127.0.0.1',
        port: address.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: VERSION,
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
        fs.renameSync(tmp, file)
        try { fs.chmodSync(file, 0o600) } catch { /* best effort on platforms that ignore mode */ }
        log('info', `listening on 127.0.0.1:${address.port}`)
      } catch (error) {
        log('error', `could not write discovery file: ${errorText(error)}`)
      }
    })
    server.on('error', (error) => log('error', `server error: ${errorText(error)}`))
    // If the Host exits without unloading plugins, still remove the token file.
    const onExit = () => {
      try {
        const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
        if (current?.token === token) fs.rmSync(file, { force: true })
      } catch { /* ignore */ }
    }
    process.once('exit', onExit)
    return () => new Promise((resolve) => {
      process.removeListener('exit', onExit)
      try {
        const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
        if (current?.token === token) fs.rmSync(file, { force: true })
      } catch { try { fs.rmSync(file, { force: true }) } catch { /* ignore */ } }
      server.close(() => resolve())
      server.closeAllConnections?.()
      log('info', 'stopped')
    })
  }), 'dsh-agent-bridge: control server')
}
