/**
 * Attachment reference scanning and fail-safe orphan cleanup.
 * All deletion is file-granular; no directory is recursively removed here.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

export const ATTACHMENT_ID_RE = /^sha256:([a-f0-9]{64})$/
export const HASH_RE = /^[a-f0-9]{64}$/
// F-12 (low, cheap): match versioned session logs only. `session-backup…
// .jsonl.zstd` and other look-alikes are not session logs; an unmatched or
// differently-shaped future format fails parse and keeps being fail-safe.
const SESSION_FILE_RE = /^session(?:\.v\d+)?\.jsonl\.zstd$/
export const INDEX_CONFLICT = 'FILES_V3_CONFLICT'

export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT'
}

function recordError(errors, file, error) {
  errors.push({ path: file, error: errorText(error) })
}

/** lstat every component below root, rejecting symlinks/junctions and escapes. */
export function safeLstat(root, target) {
  const base = path.resolve(root)
  const file = path.resolve(target)
  if (file !== base && !inside(base, file)) throw new Error(`path escapes storage root: ${file}`)
  const rel = path.relative(base, file)
  let current = base
  let stat
  try { stat = fs.lstatSync(current) } catch (error) { if (isMissing(error)) return null; throw error }
  if (stat.isSymbolicLink()) throw new Error(`symbolic link is not followed: ${current}`)
  if (rel.length === 0) return stat
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment)
    try { stat = fs.lstatSync(current) } catch (error) { if (isMissing(error)) return null; throw error }
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is not followed: ${current}`)
  }
  return stat
}

function readDir(root, dir) {
  const stat = safeLstat(root, dir)
  if (stat === null) return null
  if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`)
  return fs.readdirSync(dir, { withFileTypes: true })
}

/** Collect only structured attachment references, never hashes quoted as prose. */
export function collectAttachmentIds(value, refs = new Set(), seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return refs
  if (seen.has(value)) return refs
  seen.add(value)
  const attachment = value.attachment
  if (attachment && typeof attachment === 'object' && typeof attachment.attachmentId === 'string') {
    const match = ATTACHMENT_ID_RE.exec(attachment.attachmentId)
    if (match) refs.add(match[1])
  }
  for (const key of Object.keys(value)) collectAttachmentIds(value[key], refs, seen)
  return refs
}

// ——— multi-frame zstd decoding ————————————————————————————————————————————
// A DSH session log appends one zstd frame per flush, so real files are 5–887
// CONCATENATED frames (04-验证报告 §B.2). One-shot zlib.zstdDecompressSync has
// single-frame semantics on some runtimes (Node 24.21.0 / zlib
// 1.3.2.1-motley inside Electron 44.7.0 decodes only the first frame and
// returns WITHOUT an error), which silently reduced every session read to the
// header line, emptied the reference set, and let the plugin delete
// still-referenced attachment blobs. The reader below walks the frame stream
// itself instead of trusting a runtime's multi-frame behavior. Fail-safe
// policy: a truncated header/block/checksum, a decode failure in ANY frame
// (including content-checksum mismatch), reserved or unknown magic bytes, or
// bytes left unconsumed at the end all throw, so the session stays unparseable
// and the existing fail-safe path keeps every blob.
const ZSTD_CONTENT_FRAME_MAGIC = 0xfd2fb528 // little-endian read of '28 b5 2f fd'
const SKIPPABLE_FRAME_MAGIC_MIN = 0x184d2a50
const SKIPPABLE_FRAME_MAGIC_MAX = 0x184d2a5f

function frameNeed(buffer, offset, count, part) {
  if (offset + count > buffer.length) {
    const remaining = buffer.length - offset
    throw new Error(`zstd ${part} is truncated at offset ${offset}: needs ${count} byte(s), ${remaining} remain`)
  }
}

/**
 * Byte length of the zstd frame (content or skippable) beginning at `start`,
 * measured from the frame header (RFC 8878: descriptor bits, window descriptor,
 * dictionary id, content size) plus every block header and the optional
 * content checksum. Returns null when the bytes do not begin with any known
 * frame magic; throws on anything truncated or spec-invalid.
 */
function zstdFrameLengthAt(buffer, start) {
  frameNeed(buffer, start, 4, 'frame magic')
  const magic = buffer.readUInt32LE(start)
  if (magic >= SKIPPABLE_FRAME_MAGIC_MIN && magic <= SKIPPABLE_FRAME_MAGIC_MAX) {
    frameNeed(buffer, start, 8, 'skippable frame size')
    const size = buffer.readUInt32LE(start + 4)
    frameNeed(buffer, start, 8 + size, 'skippable frame payload')
    return 8 + size
  }
  if (magic !== ZSTD_CONTENT_FRAME_MAGIC) return null
  frameNeed(buffer, start, 5, 'frame header descriptor')
  const descriptor = buffer[start + 4]
  if ((descriptor & 0x18) !== 0) {
    throw new Error(`unsupported zstd frame header descriptor 0x${descriptor.toString(16).padStart(2, '0')} at offset ${start}: reserved or undefined bits are set`)
  }
  // Frame_Content_Size flag (bits 7-6), Single_Segment_flag (bit 5),
  // Content_Checksum_flag (bit 2), Dictionary_ID flag (bits 1-0).
  const singleSegment = (descriptor & 0x20) !== 0
  const dictFlag = descriptor & 3
  const dictIdSize = dictFlag === 3 ? 4 : dictFlag
  const fcsFlag = descriptor >> 6
  const fcsSize = fcsFlag === 3 ? 8 : fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : 4
  const headerLength = 5 + (singleSegment ? 0 : 1) + dictIdSize + fcsSize
  frameNeed(buffer, start, headerLength, 'frame header')
  let cursor = start + headerLength
  for (;;) {
    frameNeed(buffer, cursor, 3, 'block header')
    const blockHeader = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const blockType = (blockHeader >> 1) & 3
    if (blockType === 3) {
      throw new Error(`zstd frame at offset ${start} uses the reserved block type 3 at offset ${cursor - 3}`)
    }
    // bit0 = last block; type 1 is an RLE block (1 payload byte), types
    // 0 (raw) and 2 (compressed) skip blockSize bytes.
    const payloadBytes = blockType === 1 ? 1 : blockHeader >> 3
    frameNeed(buffer, cursor, payloadBytes, 'block payload')
    cursor += payloadBytes
    if ((blockHeader & 1) !== 0) break // the last block ends the frame
  }
  if ((descriptor & 0x04) !== 0) {
    frameNeed(buffer, cursor, 4, 'content checksum')
    cursor += 4
  }
  return cursor - start
}

/**
 * Decode a possibly-concatenated zstd stream: parse every frame boundary,
 * decompress each content frame independently and skip skippable frames
 * (0x184D2A50..0x184D2A5F). No single call ever sees more than one frame, so
 * runtimes whose one-shot decoder stops after the first frame behave exactly
 * like the ones that continue. Returns { data, frames, skippableFrames }.
 */
export function zstdDecodeAllFrames(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('zstd decode needs a Buffer input')
  const parts = []
  let frames = 0
  let skippableFrames = 0
  let consumed = 0
  while (consumed < buffer.length) {
    const length = zstdFrameLengthAt(buffer, consumed)
    if (length === null) {
      throw new Error(`zstd decode stopped at offset ${consumed} of ${buffer.length}: bytes do not start with a zstd content frame or skippable frame magic`)
    }
    if (buffer.readUInt32LE(consumed) === ZSTD_CONTENT_FRAME_MAGIC) {
      const slice = buffer.subarray(consumed, consumed + length)
      let part
      try { part = zlib.zstdDecompressSync(slice) } catch (error) {
        throw new Error(`zstd frame at offset ${consumed} (byte length ${length}) failed to decompress: ${errorText(error)}`)
      }
      parts.push(part)
      frames++
    } else {
      skippableFrames++
    }
    consumed += length
  }
  // Belt-and-braces guard: the walk below ends exactly at buffer.length, but
  // the consumption invariant is load-bearing (no silent truncation is ever
  // acceptable), so it is asserted explicitly here.
  if (consumed !== buffer.length) {
    throw new Error(`zstd decode consumed ${consumed} of ${buffer.length} bytes: trailing data is not a complete frame`)
  }
  return { data: Buffer.concat(parts), frames, skippableFrames }
}

export function readSessionReferences(file, root = path.dirname(file)) {
  const stat = safeLstat(root, file)
  if (stat === null || !stat.isFile()) throw new Error(`not a regular session file: ${file}`)
  // Older Node releases have no synchronous zstd decoder. Callers turn this
  // explicit error into a fail-closed scan, so blobs stay put and Host stays up.
  if (typeof zlib.zstdDecompressSync !== 'function') {
    const error = new Error('zlib.zstdDecompressSync is unavailable; attachment deletion requires Node.js >=22.15.0')
    error.code = 'ERR_ZSTD_UNAVAILABLE'
    throw error
  }
  // zstdDecodeAllFrames throws on any truncated/corrupt frame or leftover
  // byte, so a partially written or damaged log is recorded as unparseable by
  // the callers → scan.safe=false → the whole round keeps every blob.
  const decoded = zstdDecodeAllFrames(fs.readFileSync(file))
  const text = decoded.data.toString('utf8')
  if (text.trim().length === 0) throw new Error(`empty session log: ${file}`)
  const refs = new Set()
  let records = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    collectAttachmentIds(JSON.parse(line), refs)
    records++
  }
  if (records === 0) throw new Error(`session log has no JSON records: ${file}`)
  return refs
}

/** Enumerate session generations without crossing a symlink. */
export function listSessionFiles(root) {
  const files = []
  const walk = (dir) => {
    const entries = readDir(root, dir)
    if (entries === null) return
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      const stat = safeLstat(root, file)
      if (stat === null) continue
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile() && SESSION_FILE_RE.test(entry.name)) files.push(file)
    }
  }
  walk(path.resolve(root))
  return files
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchingIndexEntry(value, hash) {
  return isObject(value) && value.attachmentId === `sha256:${hash}`
}

function inspectIndexEntries(value, hash, info) {
  if (Array.isArray(value)) {
    for (const item of value) inspectIndexEntries(item, hash, info)
    return
  }
  if (!isObject(value)) return
  if (matchingIndexEntry(value, hash)) {
    info.entries++
    if (typeof value.variantId === 'string') {
      const match = ATTACHMENT_ID_RE.exec(value.variantId)
      if (match) info.variants.add(match[1])
    }
  }
  for (const child of Object.values(value)) inspectIndexEntries(child, hash, info)
}

/** Remove matching records from arrays at any supported files-v3 nesting level. */
function filterIndexEntries(value, hash, state) {
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      if (matchingIndexEntry(item, hash)) { state.entries++; continue }
      out.push(filterIndexEntries(item, hash, state))
    }
    return out
  }
  if (!isObject(value)) return value
  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = filterIndexEntries(child, hash, state)
  return out
}

function ensureDirectory(root, dir) {
  const base = path.resolve(root)
  const target = path.resolve(dir)
  if (target !== base && !inside(base, target)) throw new Error(`directory escapes storage root: ${target}`)
  const baseStat = safeLstat(base, base)
  if (baseStat === null || !baseStat.isDirectory()) throw new Error(`storage root is not a directory: ${base}`)
  let current = base
  const rel = path.relative(base, target)
  if (rel.length === 0) return
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (!isMissing(error)) throw error
      fs.mkdirSync(current)
      stat = fs.lstatSync(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe storage directory: ${current}`)
  }
}

function indexConflict(file) {
  const error = new Error(`files-v3 changed during read-modify-write: ${file}`)
  error.code = INDEX_CONFLICT
  return error
}

function assertIndexUnchanged(root, file, expectedRaw) {
  const stat = safeLstat(root, file)
  // F-08: a missing target means "opponent simultaneously removed the file";
  // refuse loudly instead of creating a brand-new files-v3.json under it.
  if (stat === null) throw new Error(`refusing to replace or create missing JSON file: ${file}`)
  if (!stat.isFile()) throw indexConflict(file)
  let current
  try { current = fs.readFileSync(file, 'utf8') } catch (error) {
    if (isMissing(error)) throw indexConflict(file)
    throw error
  }
  if (current !== expectedRaw) throw indexConflict(file)
}

/**
 * Replace an existing regular JSON file via same-directory temp, fsync, rename.
 * Preconditions (F-08):
 *  - the target already exists as a regular, non-symlink file; missing targets
 *    are NEVER created;
 *  - `expectedRaw` is the exact UTF-8 contents seen by the caller's last read.
 * The compare runs twice (before staging and immediately before rename) to
 * detect concurrent DSH writes (F-04); the caller retries the whole
 * read-modify-write cycle on INDEX_CONFLICT. Exported for failure-injection
 * tests; production callers only use removeIndexEntries().
 */
export function atomicWriteJson(root, file, value, expectedRaw) {
  if (typeof expectedRaw !== 'string') throw new Error(`files-v3 comparison snapshot is required: ${file}`)
  assertIndexUnchanged(root, file, expectedRaw)
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  if (!inside(root, temp)) throw new Error(`temporary JSON path escapes storage root: ${temp}`)
  let handle
  try {
    handle = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    assertIndexUnchanged(root, file, expectedRaw)
    fs.renameSync(temp, file)
  } catch (error) {
    if (handle !== undefined) { try { fs.closeSync(handle) } catch { /* ignore */ } }
    try { fs.rmSync(temp, { force: true }) } catch { /* ignore */ }
    throw error
  }
}

function liveLogValue(value) {
  if (Array.isArray(value?.log)) return value.log
  if (Array.isArray(value?.session?.log)) return value.session.log
  if (Array.isArray(value?.events)) return value.events
  if (Array.isArray(value?.session?.events)) return value.session.events
  // A metadata-only list entry proves nothing about in-memory references.
  // Silently treating it as an empty log could unlink a live attachment.
  throw new Error('live session entry has no log/events array; attachment references are unknown')
}

export function createAttachmentCleanup(options) {
  const home = path.resolve(options.home)
  // F-03: a callable sessionRoot is re-resolved per scan/clean so runtime
  // changes of ctx.sessionPersistence?.root are never captured as a stale
  // snapshot that would silently miss sessions written under the new root.
  const sessionRootOption = options.sessionRoot ?? path.join(home, 'sessions')
  const sessionRoot = () => {
    const configured = typeof sessionRootOption === 'function' ? sessionRootOption() : sessionRootOption
    return path.resolve(typeof configured === 'string' && configured.length > 0 ? configured : path.join(home, 'sessions'))
  }
  const storageDir = path.resolve(options.storageDir ?? path.join(home, 'storages', 'dsh-session-delete'))
  const deleteLog = path.join(storageDir, 'attachment-deletions.jsonl')
  const getLiveSessions = options.getLiveSessions
  const hasLivePending = options.hasLivePending
  const log = typeof options.log === 'function' ? options.log : () => {}
  const attachmentRoot = path.join(home, 'attachments', 'v1')
  const cacheRoot = path.join(home, 'cache', 'attachments')
  const indexPaths = [
    path.join(home, 'llm-deepseek', 'files-v3.json'),
    path.join(home, 'storages', 'llm-deepseek', 'files-v3.json'),
  ]

  const loadIndexes = () => {
    const indexes = []
    const errors = []
    for (const file of indexPaths) {
      try {
        const stat = safeLstat(home, file)
        if (stat === null) continue
        if (!stat.isFile()) throw new Error(`not a regular files-v3 index: ${file}`)
        const raw = fs.readFileSync(file, 'utf8')
        indexes.push({ path: file, data: JSON.parse(raw), raw })
      } catch (error) { recordError(errors, file, error) }
    }
    return { indexes, errors }
  }

  const collectFromDirectories = (directories) => {
    const refs = new Set()
    const errors = []
    let scannedSessions = 0
    for (const dir of [...new Set(directories.map(dir => path.resolve(dir)))]) {
      let files
      try { files = listSessionFiles(dir) } catch (error) { recordError(errors, dir, error); continue }
      for (const file of files) {
        try {
          for (const hash of readSessionReferences(file, dir)) refs.add(hash)
          scannedSessions++
        } catch (error) { recordError(errors, file, error) }
      }
    }
    return { refs, errors, scannedSessions, ok: errors.length === 0 }
  }

  const scanReferences = async () => {
    const refs = new Set()
    const errors = []
    let files = []
    try { files = listSessionFiles(sessionRoot()) } catch (error) { recordError(errors, sessionRoot(), error) }
    let scannedSessions = 0
    for (const file of files) {
      try {
        for (const hash of readSessionReferences(file, sessionRoot())) refs.add(hash)
        scannedSessions++
      } catch (error) { recordError(errors, file, error) }
    }
    let liveSessions = 0
    if (typeof getLiveSessions === 'function') {
      try {
        const values = await getLiveSessions()
        for (const value of values ?? []) {
          collectAttachmentIds(liveLogValue(value), refs)
          liveSessions++
        }
      } catch (error) { recordError(errors, '<in-memory sessions>', error) }
    }
    return { refs, errors, scannedSessions, liveSessions }
  }

  const inventory = () => {
    const blobs = new Map()
    const errors = []
    const warnings = []
    const recordFor = (hash) => {
      if (!blobs.has(hash)) blobs.set(hash, { hash, paths: [] })
      return blobs.get(hash)
    }
    const add = (hash, kind, file, stat, entity) => {
      recordFor(hash).paths.push({
        kind,
        path: file,
        relativePath: path.relative(home, file),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        entity,
      })
    }
    for (const kind of ['objects', 'file-objects']) {
      const base = path.join(attachmentRoot, kind)
      let prefixes
      try { prefixes = readDir(home, base) } catch (error) { recordError(errors, base, error); continue }
      if (prefixes === null) continue
      for (const prefix of prefixes) {
        if (!/^[a-f0-9]{2}$/.test(prefix.name)) continue
        const prefixDir = path.join(base, prefix.name)
        let entries
        try { entries = readDir(home, prefixDir) } catch (error) { warnings.push({ path: prefixDir, error: errorText(error) }); continue }
        if (entries === null) continue
        for (const entry of entries) {
          if (!HASH_RE.test(entry.name) || !entry.name.startsWith(prefix.name)) continue
          const file = path.join(prefixDir, entry.name)
          try {
            const stat = safeLstat(home, file)
            if (stat !== null && stat.isFile()) add(entry.name, kind, file, stat, true)
          } catch (error) { warnings.push({ path: file, error: errorText(error) }) }
        }
      }
    }
    const filesRoot = path.join(attachmentRoot, 'files')
    let prefixes
    try { prefixes = readDir(home, filesRoot) } catch (error) { recordError(errors, filesRoot, error) }
    if (prefixes) {
      for (const prefix of prefixes) {
        if (!/^[a-f0-9]{2}$/.test(prefix.name)) continue
        const prefixDir = path.join(filesRoot, prefix.name)
        let hashDirs
        try { hashDirs = readDir(home, prefixDir) } catch (error) { warnings.push({ path: prefixDir, error: errorText(error) }); continue }
        if (hashDirs === null) continue
        for (const hashDir of hashDirs) {
          if (!HASH_RE.test(hashDir.name) || !hashDir.name.startsWith(prefix.name)) continue
          const dir = path.join(prefixDir, hashDir.name)
          let entries
          try { entries = readDir(home, dir) } catch (error) { warnings.push({ path: dir, error: errorText(error) }); continue }
          if (entries === null) continue
          for (const entry of entries) {
            const file = path.join(dir, entry.name)
            try {
              const stat = safeLstat(home, file)
              if (stat !== null && stat.isFile()) add(hashDir.name, 'files', file, stat, false)
            } catch (error) { warnings.push({ path: file, error: errorText(error) }) }
          }
        }
      }
    }
    return { blobs, errors, warnings }
  }

  const cachePaths = (hashes) => {
    const selected = new Set([...hashes].filter(hash => HASH_RE.test(hash)))
    const paths = []
    const warnings = []
    const walk = (dir) => {
      let entries
      try { entries = readDir(home, dir) } catch (error) { warnings.push({ path: dir, error: errorText(error) }); return }
      if (entries === null) return
      for (const entry of entries) {
        const file = path.join(dir, entry.name)
        try {
          const stat = safeLstat(home, file)
          if (stat === null) continue
          if (stat.isDirectory()) walk(file)
          else if (stat.isFile() && selected.has(entry.name)) paths.push({
            kind: 'attachment-cache',
            path: file,
            relativePath: path.relative(home, file),
            bytes: stat.size,
            mtimeMs: stat.mtimeMs,
            entity: false,
          })
        } catch (error) { warnings.push({ path: file, error: errorText(error) }) }
      }
    }
    if (selected.size > 0) walk(cacheRoot)
    return { paths, warnings }
  }

  const scan = async ({ onlyHashes } = {}) => {
    const selected = onlyHashes === undefined ? null : new Set([...onlyHashes].filter(hash => typeof hash === 'string' && HASH_RE.test(hash)))
    const [references, stored, indexed] = await Promise.all([
      scanReferences(),
      Promise.resolve().then(inventory),
      Promise.resolve().then(loadIndexes),
    ])
    const errors = [...references.errors, ...stored.errors, ...indexed.errors]
    const warnings = [...stored.warnings]
    let deferred = false
    if (typeof hasLivePending === 'function') {
      try { deferred = (await hasLivePending()) === true } catch (error) { recordError(errors, '<pending sessions>', error) }
    }
    const orphans = []
    for (const [hash, record] of stored.blobs) {
      if (references.refs.has(hash) || (selected !== null && !selected.has(hash))) continue
      const indexInfo = { entries: 0, variants: new Set() }
      for (const index of indexed.indexes) inspectIndexEntries(index.data, hash, indexInfo)
      const cached = cachePaths(new Set([hash, ...indexInfo.variants]))
      warnings.push(...cached.warnings)
      const paths = [...record.paths, ...cached.paths]
      const blobBytes = record.paths.filter(file => file.entity).reduce((sum, file) => sum + file.bytes, 0)
      const pathBytes = paths.reduce((sum, file) => sum + file.bytes, 0)
      orphans.push({
        hash,
        bytes: blobBytes,
        blobBytes,
        pathBytes,
        paths,
        indexEntries: indexInfo.entries,
        variants: [...indexInfo.variants].sort(),
      })
    }
    orphans.sort((a, b) => a.hash.localeCompare(b.hash))
    return {
      // Unknown disk/live/index state blocks deletion globally. A live pending
      // session alone does not: its disk and live event references are inputs.
      safe: errors.length === 0,
      deferred,
      scannedSessions: references.scannedSessions,
      liveSessions: references.liveSessions,
      referencedHashes: [...references.refs].sort(),
      orphans,
      orphanBytes: orphans.reduce((sum, item) => sum + item.blobBytes, 0),
      orphanPathBytes: orphans.reduce((sum, item) => sum + item.pathBytes, 0),
      errors,
      warnings,
    }
  }

  const removeIndexEntries = (hash) => {
    let removedEntries = 0
    // F-04: DSH does not share our lock. Re-read and retry the complete
    // transform on an exact-content conflict (FILES_V3_CONFLICT); on Windows a
    // rename over a file DSH still holds open surfaces as EPERM/EBUSY, which
    // gets the same bounded retry. After three failed attempts every blob is
    // kept and the failure surfaces through clean()'s per-hash failures.
    const indexRetryable = code => code === INDEX_CONFLICT || code === 'EPERM' || code === 'EBUSY'
    for (let attempt = 0; attempt < 3; attempt++) {
      const { indexes, errors } = loadIndexes()
      if (errors.length > 0) throw new Error(`files-v3 preflight failed: ${errors.map(item => item.error).join('; ')}`)
      const changes = []
      for (const index of indexes) {
        const state = { entries: 0 }
        const data = filterIndexEntries(index.data, hash, state)
        if (state.entries > 0) changes.push({ ...index, data, entries: state.entries })
      }
      try {
        // Parse and transform every index before publishing any one of them.
        for (const change of changes) {
          atomicWriteJson(home, change.path, change.data, change.raw)
          removedEntries += change.entries
        }
        return removedEntries
      } catch (error) {
        if (!indexRetryable(error?.code) || attempt === 2) throw error
      }
    }
    return removedEntries
  }

  const appendDeleteLog = (entry) => {
    ensureDirectory(home, storageDir)
    const stat = safeLstat(storageDir, deleteLog)
    if (stat !== null && !stat.isFile()) throw new Error(`delete log is not a regular file: ${deleteLog}`)
    fs.appendFileSync(deleteLog, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
  }

  const clean = async ({ confirm = false, onlyHashes, source = 'command', sessionIds = [] } = {}) => {
    const initial = await scan({ onlyHashes })
    const result = {
      ...initial,
      errors: [...initial.errors],
      dryRun: !confirm,
      confirmed: confirm === true,
      deleted: [],
      skipped: [],
    }
    if (!confirm || !initial.safe) return result
    for (const candidate of initial.orphans) {
      // Concurrency guard: never rely on the first dry-run/scan for this hash.
      const latest = await scan({ onlyHashes: [candidate.hash] })
      if (!latest.safe) {
        result.skipped.push({ hash: candidate.hash, reason: 'recheck-failed' })
        result.errors.push(...latest.errors)
        continue
      }
      const current = latest.orphans.find(item => item.hash === candidate.hash)
      if (!current) {
        result.skipped.push({ hash: candidate.hash, reason: 'referenced-on-recheck' })
        continue
      }
      const removedPaths = []
      const failures = []
      let indexEntries = 0
      let indexFailed = false
      try {
        // Safer order: publish files-v3 removal before unlinking any blob. If
        // the index races or cannot be replaced, this candidate keeps all data.
        indexEntries = removeIndexEntries(candidate.hash)
      } catch (error) {
        indexFailed = true
        failures.push({ path: '<files-v3>', error: errorText(error) })
      }
      if (failures.length === 0) {
        const rank = kind => kind === 'attachment-cache' ? 0 : kind === 'files' ? 1 : 2
        const paths = [...current.paths].sort((a, b) => rank(a.kind) - rank(b.kind) || a.path.localeCompare(b.path))
        for (const file of paths) {
          try {
            // Re-read every disk/live session immediately before EACH unlink.
            const latestReferences = await scanReferences()
            if (latestReferences.errors.length > 0) {
              failures.push(...latestReferences.errors)
              break
            }
            if (latestReferences.refs.has(candidate.hash)) {
              failures.push({ path: file.path, error: 'hash became referenced before unlink' })
              break
            }
            const stat = safeLstat(home, file.path)
            if (stat === null) continue
            if (!stat.isFile()) throw new Error('not a regular file')
            if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.bytes) {
              throw new Error(`file changed since recheck (mtime/size): ${file.path}`)
            }
            // Residual TOCTOU: another process can add a reference or replace
            // the path after these checks but before unlinkSync. No shared lock
            // exists with DSH, so this is best-effort, never atomic protection.
            fs.unlinkSync(file.path)
            removedPaths.push({ ...file, bytes: stat.size })
          } catch (error) {
            failures.push({ path: file.path, error: errorText(error) })
            break // Keep primary entities when an alias/cache cannot be removed.
          }
        }
      }
      const entry = {
        time: new Date().toISOString(),
        action: removedPaths.length > 0 ? 'attachment-delete' : 'attachment-delete-skipped',
        source,
        sessionIds: [...sessionIds],
        hash: candidate.hash,
        bytes: candidate.blobBytes,
        pathBytes: removedPaths.reduce((sum, file) => sum + file.bytes, 0),
        removedPaths: removedPaths.map(file => file.path),
        indexEntries,
        errors: failures,
      }
      try { appendDeleteLog(entry) } catch (error) { failures.push({ path: deleteLog, error: errorText(error) }) }
      if (removedPaths.length === 0 && failures.length > 0) {
        result.skipped.push({ hash: candidate.hash, reason: indexFailed ? 'index-update-failed' : 'unlink-aborted' })
      } else {
        result.deleted.push({ hash: candidate.hash, bytes: candidate.blobBytes, removedPaths, indexEntries, errors: failures })
      }
      result.errors.push(...failures)
      log(`attachments hash=${candidate.hash} removed=${removedPaths.length} indexEntries=${indexEntries} errors=${failures.length}`)
    }
    return result
  }

  return {
    home,
    sessionRoot,
    storageDir,
    deleteLog,
    collectFromDirectories,
    scan,
    clean,
  }
}
