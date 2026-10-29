/**
 * Deferred-delete pending list helper (F-01).
 *
 * v0.1.0 stored a bare JSON array of session id strings. A deferred session's
 * log directories are removed by the exit hook or by the next purge, so a bare
 * id alone can never be re-scanned afterwards; historically the purge path
 * then deleted "unknown references" as unrelated orphans — exactly the F-01
 * over-deletion bug.
 *
 * v0.2.0+ therefore stores `{ version: 2, sessions: [...] }`, persisting the
 * attachment hashes captured BEFORE the session logs are removed:
 *
 *     { id, attachmentHashes: ["<64 hex>"], referencesComplete: boolean }
 *
 * Legacy string entries stay readable, but their references are unknown: the
 * purge feeds such ids into `attachmentsSkipped` instead of attachment
 * cleanup, so a queued attachment auto-clean never runs unscoped.
 */
import fs from 'node:fs'
import path from 'node:path'
import { errorText } from './attachments.js'

/**
 * Session-id grammar for pending records. Must remain the exact pattern
 * index.js validates delete targets against (kept in sync there and here).
 */
export const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/

const HASH_RE = /^[a-f0-9]{64}$/

function hashList(value) {
  const hashes = Array.isArray(value?.attachmentHashes) ? value.attachmentHashes : []
  return [...new Set(hashes.filter(hash => typeof hash === 'string' && HASH_RE.test(hash)))].sort()
}

/**
 * Normalize any historical or malformed pending JSON into stable records.
 * Unknown shapes and invalid ids are dropped; a repeated id keeps the LAST
 * record so a failed reference refresh can downgrade an older
 * referencesComplete marker instead of accidentally authorizing a later
 * cleanup.
 */
export function normalizePendingRecords(values) {
  const list = Array.isArray(values)
    ? values
    : Array.isArray(values?.sessions) ? values.sessions : []
  const unique = new Map()
  for (const value of list) {
    const id = typeof value === 'string' ? value : value?.id
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) continue
    unique.set(id, {
      id,
      attachmentHashes: typeof value === 'object' ? hashList(value) : [],
      referencesComplete: typeof value === 'object' && value?.referencesComplete === true,
    })
  }
  return [...unique.values()]
}

/** Read the pending file. Any read/parse failure behaves like "nothing pending". */
export function readPendingRecords(file) {
  try {
    return normalizePendingRecords(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch { return [] }
}

/**
 * Write v2 records; an empty list removes the file (same observable behavior
 * as v0.1.0). Write failures are logged, never thrown: session deletion must
 * not fail because waiting-list housekeeping could not persist.
 */
export function writePendingRecords(file, records, log) {
  const normalized = normalizePendingRecords(records)
  try {
    if (normalized.length === 0) { fs.rmSync(file, { force: true }); return }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: normalized }, null, 2), 'utf8')
  } catch (error) { log?.('warn', `pending list write failed: ${errorText(error)}`) }
}
