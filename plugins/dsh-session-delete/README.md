# Session Delete (`dsh-session-delete`)

Host and client plugin for DeepSeek Harness desktop. DSH can archive a session. This plugin adds a way to remove one, and (from 0.2.2) can clean orphan attachments.

Tested with DeepSeek Harness desktop 0.2.x. Requires Node.js ≥ 22.15.0 (`zlib.zstdDecompressSync`). No build step.

## What you see

A red **Delete permanently** item at the bottom of the session `…` menu. In a Chinese locale the label is **永久删除**. Choosing it opens a confirm dialog. Nothing is removed until you confirm.

## What is removed

Only data inside the DSH data directory (`DSH_HOME` if set, otherwise `~/.dsh`):

- `<data-dir>/sessions/<project>/<session-id>/` — the session log
- `<data-dir>/storages/session_projcache/sessions/<session-id>.json` — the projection cache
- The session's entries in the workspace list, the archive set, and the pin set (through the workspace registry, not by rewriting files by hand)

Subagent child sessions are deleted with the parent. A forked session is its own session and is left in place.

## Attachment cleanup (0.2.2)

Setting **`autoDeleteAttachments` is ON by default** (disable in plugin settings). When enabled, after a session is deleted the plugin:

1. Captures attachment hashes from the deleted parent and its subagent children
2. Scans every remaining session on disk (including archived) plus enumerable in-memory sessions
3. Deletes only hashes that no remaining session still references

Loaded (deferred) sessions use a **dedicated scope**: references are captured before logs are removed and stored in the pending record (v2). Later `purgePending` passes `onlyHashes` for exactly that set. A deferred id whose references cannot be recovered (legacy bare-id pending record, logs already gone, or a failed capture) is **skipped** for attachment auto-clean — an unscoped all-orphan sweep never runs after a deferred delete.

Session logs are decoded **frame by frame**. Real DSH logs are concatenated multi-frame zstd streams (one flush = one frame). Some runtimes' one-shot `zlib.zstdDecompressSync` decode only the first frame without error; the parser walks frame boundaries itself (including skippable frames `0x184D2A50`–`0x184D2A5F`). A torn/corrupt frame or trailing garbage marks the session unparseable → the whole round keeps every blob (fail-closed).

Cleanup covers `attachments/v1` objects / file-objects / files hardlinks, derived caches under `cache/attachments/`, and matching `files-v3.json` entries. Index updates are atomic (temp → fsync → rename) with conflict retries. Symlinks are never followed; attachment directories are never recursively deleted.

Actual deletions append to:

`<data-dir>/storages/dsh-session-delete/attachment-deletions.jsonl`

## What is not removed (unless attachment cleanup qualifies a blob)

- Files the agent wrote into the workspace directory
- Anything outside the session / attachment storage roots
- Symbolic links (they are not followed)
- Attachment blobs still referenced by any remaining session

## Loaded sessions

If the session's agent is loaded in this process, a plugin cannot drop the open write handle. The session leaves the list immediately (it is archived and detached first). Its files (and eligible captured attachments when auto-clean is on) are deleted when DSH exits, or on the next start if the process dies first. Until then the id is listed in `<data-dir>/storages/dsh-session-delete.pending.json`.

## Commands

```text
/dsh-session-delete-attachments
```

Dry-run by default: lists orphan hashes and sizes, changes nothing.

```text
/dsh-session-delete-attachments --confirm
```

Fresh scan, then delete only still-unreferenced hashes.

## For other plugins

```js
const service = ctx.get('dshSessionDelete')
const result = await service.delete([sessionId])
// result: { deleted, deferred, notFound, removedPaths, errors, attachments? }
await service.scanAttachments()
await service.cleanOrphanAttachments({ confirm: false })
```

The client talks to `POST /dsh-session-delete/delete` on DSH's own web server. That route uses DSH's browser authentication and rejects the request when no authenticated connection is present.

## Install

In DSH: **Plugins → Add plugin → install a third-party plugin** from a local folder or a link. Choose this folder (the one that contains `package.json`), then enable **Session Delete** on the Plugins page.

---

## 中文摘要

在侧栏会话「…」菜单加入红色 **永久删除**。确认后删除会话日志、投影缓存与 Workspace 记录；子代理子会话一并删除。`autoDeleteAttachments` **默认开启**，删除会话后只清理不再被任何会话引用的附件。已加载会话先移出列表，磁盘与合格附件在退出/下次启动时清理。待删列表：`$DSH_HOME/storages/dsh-session-delete.pending.json`。扫描命令：`/dsh-session-delete-attachments`（默认 dry-run，加 `--confirm` 才删除）。
