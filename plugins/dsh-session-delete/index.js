/**
 * Session Delete — Host half.
 *
 * DSH has archive but no delete, and its persistence seam has no deletion API.
 * This plugin removes a session permanently:
 *   1. archive it (stopping running work) so nothing resumes it,
 *   2. remove its session-owned directory under the JSONL session root,
 *   3. remove its projection-cache record,
 *   4. drop it from the workspace registry (session list, archive and pin sets),
 *   5. tell connected clients it is gone.
 * A session whose agent is loaded in this process cannot release its write
 * handle from a plugin, so its files are removed when the Host exits or at the
 * next start (it stays hidden meanwhile). Subagent children go with the parent.
 * Forked sessions are left alone. Attachments in shared content-addressed
 * storage are not touched. Only paths inside DSH session storage are removed.
 *
 * The data directory is process.env.DSH_HOME when that is set, otherwise ~/.dsh.
 * Service: ctx.get('dshSessionDelete').delete(ids) — used by dsh-agent-bridge.
 * Web route: POST /dsh-session-delete/delete {sessionId}, browser-authenticated.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-session-delete'
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents', 'webServer']

const ROUTE = '/dsh-session-delete/delete'
const SERVICE = 'dshSessionDelete'
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.length > 0 ? env : path.join(os.homedir(), '.dsh')
}

/** Same injective escaping the JSONL backend uses for a session directory name. */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function inside(root, target) {
  const rel = path.relative(root, target)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx) {
  const log = (level, msg) => { try { ctx.logger?.[level]?.(`dsh-session-delete: ${msg}`) } catch { /* ignore */ } }
  const home = dshHome()
  const pendingFile = path.join(home, 'storages', 'dsh-session-delete.pending.json')

  const sessionRoot = () => {
    const configured = ctx.sessionPersistence?.root
    return path.resolve(typeof configured === 'string' && configured.length > 0 ? configured : path.join(home, 'sessions'))
  }
  const projcacheDir = () => path.resolve(home, 'storages', 'session_projcache', 'sessions')

  const readPending = () => {
    try {
      const list = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
      return Array.isArray(list) ? list.filter(id => typeof id === 'string' && ID_RE.test(id)) : []
    } catch { return [] }
  }
  const writePending = (ids) => {
    const unique = [...new Set(ids)]
    try {
      if (unique.length === 0) { fs.rmSync(pendingFile, { force: true }); return }
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
      fs.writeFileSync(pendingFile, JSON.stringify(unique, null, 2), 'utf8')
    } catch (error) { log('warn', `pending list write failed: ${errorText(error)}`) }
  }

  /** Session-owned directories for one id under the JSONL root (one per project dir it may live in). */
  const sessionDirs = (id) => {
    const root = sessionRoot()
    const leaf = encodeSegment(id)
    const found = []
    let projects = []
    try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return found }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = path.join(root, project.name, leaf)
      try {
        const st = fs.lstatSync(dir)
        if (st.isDirectory() && !st.isSymbolicLink() && inside(root, dir)) found.push(dir)
      } catch { /* absent */ }
    }
    return found
  }

  const projcacheFiles = (id) => {
    const dir = projcacheDir()
    const names = new Set([`${id}.json`, `${encodeSegment(id)}.json`])
    return [...names].map(n => path.join(dir, n)).filter(f => inside(dir, f) && fs.existsSync(f))
  }

  /** Remove files of one non-live session; returns removed paths. */
  const removeFiles = (id) => {
    const removed = []
    for (const dir of sessionDirs(id)) {
      // Session-owned directory: log generations, temporary publish files.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      removed.push(dir)
    }
    for (const file of projcacheFiles(id)) {
      fs.rmSync(file, { force: true })
      removed.push(file)
    }
    return removed
  }

  const isLive = id => ctx.sessions.get(id) !== undefined || ctx.agents.get(id) !== undefined

  const forgetInRegistry = async (id) => {
    const registry = ctx.workspaceRegistry
    for (const ws of registry.list()) {
      try { await ws.detachSession?.(id) } catch (error) { log('warn', `detach ${id}: ${errorText(error)}`) }
    }
    try { await registry.unpinSession(id) } catch { /* not pinned */ }
    try { await registry.unarchiveSession(id) } catch { /* not archived */ }
  }

  const children = async (id) => {
    const out = []
    let all = []
    try { all = await ctx.sessionPersistence.list() } catch { return out }
    const walk = (parent) => {
      for (const snap of all) {
        const h = snap?.header
        if (h && h.parentSession === parent && h.origin === 'subagent' && !out.includes(h.id)) { out.push(h.id); walk(h.id) }
      }
    }
    walk(id)
    return out
  }

  let chain = Promise.resolve()
  const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run }

  /** Permanently delete sessions. */
  const deleteSessions = (ids) => serial(async () => {
    const result = { deleted: [], deferred: [], notFound: [], removedPaths: [], errors: [] }
    const queue = []
    for (const id of ids) {
      if (typeof id !== 'string' || !ID_RE.test(id)) { result.errors.push({ id, error: 'invalid session id' }); continue }
      queue.push(...(await children(id)).reverse(), id)
    }
    const pending = readPending()
    for (const id of [...new Set(queue)]) {
      try {
        let known = isLive(id) || sessionDirs(id).length > 0
        if (!known) { try { known = (await ctx.sessionPersistence.stat(id)) !== undefined } catch { /* unknown */ } }
        // Archive first (stops running work, keeps it from being resumed).
        if (known) {
          try { await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true }) } catch (error) { log('debug', `archive ${id}: ${errorText(error)}`) }
        }
        if (isLive(id)) {
          for (const ws of ctx.workspaceRegistry.list()) { try { await ws.detachSession?.(id) } catch { /* ignore */ } }
          try { await ctx.workspaceRegistry.unpinSession(id) } catch { /* ignore */ }
          pending.push(id)
          result.deferred.push(id)
          continue
        }
        const removed = removeFiles(id)
        result.removedPaths.push(...removed)
        try { await ctx.get('sessionProjectionCache')?.table?.delete?.(id) } catch { /* fs removal already done */ }
        await forgetInRegistry(id)
        try { ctx.emit('api-session/removed', id) } catch { /* no clients */ }
        if (known || removed.length > 0) result.deleted.push(id); else result.notFound.push(id)
      } catch (error) {
        result.errors.push({ id, error: errorText(error) })
      }
    }
    writePending(pending.filter(id => !result.deleted.includes(id)))
    log('info', `deleted=${result.deleted.length} deferred=${result.deferred.length}`)
    return result
  })

  /** Finish deferred deletions whose agent is no longer loaded. */
  const purgePending = () => serial(async () => {
    const left = []
    const done = []
    for (const id of readPending()) {
      if (isLive(id)) { left.push(id); continue }
      try {
        removeFiles(id)
        try { await ctx.get('sessionProjectionCache')?.table?.delete?.(id) } catch { /* ignore */ }
        await forgetInRegistry(id)
        try { ctx.emit('api-session/removed', id) } catch { /* ignore */ }
        done.push(id)
      } catch (error) { left.push(id); log('warn', `purge ${id}: ${errorText(error)}`) }
    }
    writePending(left)
    return { purged: done, stillPending: left }
  })

  // Host exit: every agent has been drained by now, so finish deferred work synchronously.
  const onExit = () => {
    for (const id of readPending()) {
      try { for (const dir of sessionDirs(id)) fs.rmSync(dir, { recursive: true, force: true }); for (const f of projcacheFiles(id)) fs.rmSync(f, { force: true }) } catch { /* next start retries */ }
    }
  }
  ctx.effect(() => { process.once('exit', onExit); return () => { process.removeListener('exit', onExit) } }, 'dsh-session-delete: exit hook')

  // Start-up: finish what a previous run deferred.
  ctx.effect(() => { void purgePending().catch(() => {}); return () => {} }, 'dsh-session-delete: startup purge')

  ctx.provide(SERVICE, { delete: deleteSessions, purgePending, pending: readPending })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const connection = ctx.get('connection') ?? Reflect.get(ctx, 'connection')
      const rejection = connection?.requestRejection ? connection.requestRejection(req) : 403
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); send(405, { ok: false, error: 'POST only' }); return }
      const essence = String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase()
      if (essence !== 'application/json') { send(415, { ok: false, error: 'content-type must be application/json' }); return }
      let size = 0
      const chunks = []
      try {
        for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('too large'); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const ids = Array.isArray(body?.sessionIds) ? body.sessionIds : [body?.sessionId]
        const result = await deleteSessions(ids)
        send(result.errors.length > 0 && result.deleted.length + result.deferred.length === 0 ? 500 : 200, { ok: result.errors.length === 0, ...result })
      } catch (error) {
        send(400, { ok: false, error: errorText(error) })
      }
    },
  }), `dsh-session-delete: POST ${ROUTE}`)
}
