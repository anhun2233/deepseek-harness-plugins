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
 * Forked sessions are left alone.
 *
 * Attachment cleanup (v0.2.x, on by default via autoDeleteAttachments): after
 * deletion, remove content-addressed blobs that no remaining disk, archived, or
 * in-memory session still references. Deferred deletions persist captured
 * attachment hashes (pending v2) and clean only that set. Session logs are
 * decoded frame-by-frame so multi-frame zstd streams are never truncated.
 *
 * Only paths inside DSH session storage / attachment stores are ever touched.
 * The data directory is process.env.DSH_HOME when that is set, otherwise ~/.dsh.
 * Service: ctx.get('dshSessionDelete').delete(ids) / scanAttachments / cleanOrphanAttachments.
 * Web route: POST /dsh-session-delete/delete {sessionId}, browser-authenticated.
 * Command: /dsh-session-delete-attachments [--confirm]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createAttachmentCleanup, errorText, inside, safeLstat } from './attachments.js'
import {
  SESSION_ID_RE,
  readPendingRecords as readPendingFile,
  writePendingRecords as writePendingFile,
} from './pending.js'

export const name = 'dsh-session-delete'
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents', 'webServer']
export const Config = z.object({
  autoDeleteAttachments: z.boolean().default(true),
})

const ROUTE = '/dsh-session-delete/delete'
const ID_RE = SESSION_ID_RE // Grammar must stay shared with the pending records.
const SCAN_COMMAND = 'dsh-session-delete-attachments'

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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatAttachmentResult(result) {
  const lines = []
  if (result.dryRun) {
    lines.push(`扫描完成（dry-run）：${result.orphans.length} 个孤儿附件，实体 ${formatBytes(result.orphanBytes)}，含硬链接和缓存共 ${formatBytes(result.orphanPathBytes)}。`)
    for (const item of result.orphans) {
      lines.push(`${item.hash}  ${formatBytes(item.blobBytes)}  files=${item.paths.length} indexEntries=${item.indexEntries}`)
    }
    if (result.orphans.length > 0) lines.push(`确认删除请执行：/${SCAN_COMMAND} --confirm`)
  } else {
    lines.push(`清理完成：${result.deleted.length} 个附件哈希，跳过 ${result.skipped.length} 个。`)
    for (const item of result.deleted) lines.push(`${item.hash}  removed=${item.removedPaths.length} indexEntries=${item.indexEntries} errors=${item.errors.length}`)
  }
  if (result.deferred) lines.push('仍有已加载的待删会话；已收集其磁盘/内存引用，不会仅凭待删状态全局阻止清理。')
  if (!result.safe) lines.push('检测到不可读会话、实时引用形状或索引错误；按 fail-safe 策略未删除任何候选。')
  for (const error of result.errors) lines.push(`ERROR ${error.path}: ${error.error}`)
  if (result.warnings.length > 0) lines.push(`另有 ${result.warnings.length} 个非常规路径被跳过（未跟随符号链接）。`)
  if (result.orphans.length === 0 && result.deleted.length === 0 && result.errors.length === 0) lines.push('没有可清理的孤儿附件。')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const log = (level, msg) => { try { ctx.logger?.[level]?.(`dsh-session-delete: ${msg}`) } catch { /* ignore */ } }
  const home = dshHome()
  const pendingFile = path.join(home, 'storages', 'dsh-session-delete.pending.json')
  const autoDeleteAttachments = () => config?.autoDeleteAttachments === true

  const sessionRoot = () => {
    const configured = ctx.sessionPersistence?.root
    return path.resolve(typeof configured === 'string' && configured.length > 0 ? configured : path.join(home, 'sessions'))
  }
  const projcacheDir = () => path.resolve(home, 'storages', 'session_projcache', 'sessions')

  // Pending file: v2 records persist each deferred session's captured
  // attachment hashes (see pending.js); legacy record strings remain readable
  // but carry no hashes, so their attachment cleanup is skipped (F-01).
  const readPendingRecords = () => readPendingFile(pendingFile)
  const readPending = () => readPendingRecords().map(record => record.id)
  /** F-01: never persist an unscoped pending entry — hashes ride along. */
  const writePending = records => writePendingFile(pendingFile, records, log)

  /** Session-owned directories for one id under the JSONL root (one per project dir it may live in). */
  const sessionDirs = (id) => {
    const root = sessionRoot()
    const leaf = encodeSegment(id)
    const found = []
    let projects = []
    try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return found }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      const dir = path.join(root, project.name, leaf)
      try {
        // F-09: validate EVERY component below the root (project dir and leaf).
        // A Dirent can report directories for Windows junctions where
        // isSymbolicLink() is unreliable, so safeLstat's per-component lstat
        // is the real gate; anything unsafe is skipped, never traversed.
        const st = safeLstat(root, dir)
        if (st !== null && st.isDirectory() && inside(root, dir)) found.push(dir)
      } catch { /* absent, symlinked or escaping: skip */ }
    }
    return found
  }

  const projcacheFiles = (id) => {
    const dir = projcacheDir()
    const names = new Set([`${id}.json`, `${encodeSegment(id)}.json`])
    const found = []
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const st = safeLstat(dir, file)
        if (st !== null && st.isFile()) found.push(file)
      } catch { /* absent or unsafe: skip */ }
    }
    return found
  }

  /**
   * Remove files of one non-live session; returns removed paths.
   * F-10 (low): each path is revalidated with safeLstat immediately before
   * removal, so a directory swapped for a symlink between enumeration and
   * deletion is skipped instead of traversed.
   */
  const removeFiles = (id) => {
    const removed = []
    for (const dir of sessionDirs(id)) {
      try {
        // Session-owned directory: log generations, temporary publish files.
        const st = safeLstat(sessionRoot(), dir)
        if (st === null || !st.isDirectory()) continue
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
        removed.push(dir)
      } catch (error) { log('warn', `skip session dir ${dir}: ${errorText(error)}`) }
    }
    for (const file of projcacheFiles(id)) {
      try {
        const st = safeLstat(projcacheDir(), file)
        if (st === null || !st.isFile()) continue
        fs.rmSync(file, { force: true })
        removed.push(file)
      } catch (error) { log('warn', `skip projcache file ${file}: ${errorText(error)}`) }
    }
    return removed
  }

  const isLive = id => ctx.sessions.get(id) !== undefined || ctx.agents.get(id) !== undefined
  const attachments = createAttachmentCleanup({
    home,
    // F-03: pass the closure, not a one-shot resolution, so attachment scans
    // re-resolve ctx.sessionPersistence?.root on every scan/clean instead of
    // being captured at construction time.
    sessionRoot: sessionRoot,
    hasLivePending: () => readPending().some(isLive),
    getLiveSessions: async () => {
      const values = []
      for (const service of [ctx.sessions, ctx.agents]) {
        if (service === undefined || service === null) continue
        if (typeof service.list !== 'function') {
          // F-05: a present-but-unlistable service means in-memory references
          // cannot be enumerated; fail closed instead of assuming there are none.
          throw new Error('live session service provides no list(); in-memory references are unknown')
        }
        const listed = await service.list()
        if (listed !== undefined && listed !== null) values.push(...listed)
      }
      return values
    },
    log: msg => log('info', msg),
  })

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
    const targetIds = [...new Set(queue)]
    // Capture each id's references before ANY parent/subagent log is removed.
    // Deferred ids persist their own set, so purge never needs a global scan.
    const collectedById = new Map()
    for (const id of targetIds) collectedById.set(id, attachments.collectFromDirectories(sessionDirs(id)))
    const pending = readPendingRecords()
    for (const id of targetIds) {
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
          const previous = pending.find(record => record.id === id)
          const collected = collectedById.get(id)
          const hashes = new Set(previous?.attachmentHashes ?? [])
          for (const hash of collected?.refs ?? []) hashes.add(hash)
          pending.push({
            id,
            attachmentHashes: [...hashes],
            referencesComplete: (collected?.ok === true && collected.scannedSessions > 0)
              || (collected?.scannedSessions === 0 && previous?.referencesComplete === true),
          })
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
    writePending(pending.filter(record => !result.deleted.includes(record.id)))
    const deletedRefs = new Set()
    const deletedRefErrors = []
    for (const id of result.deleted) {
      const collected = collectedById.get(id)
      if (!collected?.ok) deletedRefErrors.push(...(collected?.errors ?? [{ path: id, error: 'deleted session references are unknown' }]))
      for (const hash of collected?.refs ?? []) deletedRefs.add(hash)
    }
    if (autoDeleteAttachments() && deletedRefs.size > 0) {
      if (deletedRefErrors.length > 0) {
        result.attachments = {
          safe: false, deferred: false, dryRun: false, confirmed: true,
          orphans: [], deleted: [], skipped: [{ reason: 'unparseable-deleted-session' }],
          errors: deletedRefErrors, warnings: [],
        }
      } else {
        result.attachments = await attachments.clean({
          confirm: true,
          onlyHashes: deletedRefs,
          source: 'dsh-session-delete',
          sessionIds: result.deleted,
        })
      }
    }
    log('info', `deleted=${result.deleted.length} deferred=${result.deferred.length}`)
    return result
  })

  /** Finish deferred deletions whose Agent is no longer loaded. */
  const purgePending = () => serial(async () => {
    const left = []
    const done = []
    const cleanupRecords = []
    const attachmentsSkipped = []
    for (const record of readPendingRecords()) {
      const id = record.id
      if (isLive(id)) { left.push(record); continue }
      const hashes = new Set(record.attachmentHashes)
      let referencesComplete = record.referencesComplete
      // Refresh cached refs while logs still exist. If they are already gone,
      // only a complete v2 pending record can authorize attachment cleanup.
      const directories = sessionDirs(id)
      if (directories.length > 0) {
        const collected = attachments.collectFromDirectories(directories)
        if (collected.ok && collected.scannedSessions > 0) {
          for (const hash of collected.refs) hashes.add(hash)
          referencesComplete = true
        } else {
          referencesComplete = false
        }
      }
      const refreshed = { id, attachmentHashes: [...hashes].sort(), referencesComplete }
      try {
        removeFiles(id)
        try { await ctx.get('sessionProjectionCache')?.table?.delete?.(id) } catch { /* ignore */ }
        await forgetInRegistry(id)
        try { ctx.emit('api-session/removed', id) } catch { /* ignore */ }
        done.push(id)
        if (referencesComplete) cleanupRecords.push(refreshed)
        else attachmentsSkipped.push(id) // Never turn unknown refs into all-orphan deletion.
      } catch (error) { left.push(refreshed); log('warn', `purge ${id}: ${errorText(error)}`) }
    }
    writePending(left)
    let attachmentResult
    const eligible = cleanupRecords.filter(record => record.attachmentHashes.length > 0)
    if (autoDeleteAttachments() && eligible.length > 0) {
      const onlyHashes = new Set(eligible.flatMap(record => record.attachmentHashes))
      attachmentResult = await attachments.clean({
        confirm: true,
        onlyHashes,
        source: 'pending-dsh-session-delete',
        sessionIds: eligible.map(record => record.id),
      })
    }
    return {
      purged: done,
      stillPending: left.map(record => record.id),
      ...(attachmentsSkipped.length > 0 ? { attachmentsSkipped } : {}),
      ...(attachmentResult ? { attachments: attachmentResult } : {}),
    }
  })

  // Host exit removes logs only; v2 pending hashes survive for the next purge.
  const onExit = () => {
    for (const id of readPending()) {
      try { removeFiles(id) } catch { /* next start retries */ }
    }
  }
  ctx.effect(() => { process.once('exit', onExit); return () => { process.removeListener('exit', onExit) } }, 'dsh-session-delete: exit hook')

  // Start-up: finish what a previous run deferred.
  ctx.effect(() => { void purgePending().catch(() => {}); return () => {} }, 'dsh-session-delete: startup purge')

  ctx.provide('dshSessionDelete', {
    delete: deleteSessions,
    purgePending,
    pending: readPending,
    scanAttachments: options => attachments.scan(options),
    cleanOrphanAttachments: options => attachments.clean({ ...options, confirm: options?.confirm === true }),
    attachmentDeleteLog: attachments.deleteLog,
  })

  ctx.inject(['commands'], (host) => {
    const commands = host.get('commands')
    const definition = {
      name: SCAN_COMMAND,
      description: '扫描孤儿附件（默认 dry-run）；使用 --confirm 显式删除 / Scan orphan attachments; --confirm deletes.',
      input: { hint: '[--confirm]' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim()
        if (raw !== '' && raw !== '--confirm' && raw !== 'confirm') {
          return { kind: 'error', text: `用法：/${SCAN_COMMAND} [--confirm]` }
        }
        const confirm = raw === '--confirm' || raw === 'confirm'
        const result = await attachments.clean({ confirm, source: 'command' })
        return { kind: confirm && (!result.safe || result.errors.length > 0) ? 'error' : 'success', text: formatAttachmentResult(result) }
      },
    }
    try { commands.register(definition) } catch (error) {
      try { commands.register({ ...definition, name: 'dsh-session-delete-scan-attachments' }) } catch { log('warn', `attachment scan command registration failed: ${errorText(error)}`) }
    }
  })

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
