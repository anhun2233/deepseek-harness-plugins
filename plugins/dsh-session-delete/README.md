# Session Delete (`dsh-session-delete`)

Host and client plugin for DeepSeek Harness desktop. DSH can archive a session. This plugin adds a way to remove one.

Tested with DeepSeek Harness desktop 0.2.1-rc.2. No build step and no dependencies.

## What you see

A red **Delete permanently** item at the bottom of the session `…` menu. In a Chinese locale the label is **永久删除**. Choosing it opens a confirm dialog. Nothing is removed until you confirm.

## What is removed

Only data inside the DSH data directory (`DSH_HOME` if set, otherwise `~/.dsh`):

- `<data-dir>/sessions/<project>/<session-id>/` — the session log
- `<data-dir>/storages/session_projcache/sessions/<session-id>.json` — the projection cache
- The session's entries in the workspace list, the archive set, and the pin set (through the workspace registry, not by rewriting files by hand)

Subagent child sessions are deleted with the parent. A forked session is its own session and is left in place.

## What is not removed

- Attachments and other content-addressed blobs in shared storage
- Files the agent wrote into the workspace directory
- Anything outside the session storage root
- Symbolic links (they are not followed)

## Loaded sessions

If the session's agent is loaded in this process, a plugin cannot drop the open write handle. The session leaves the list immediately (it is archived and detached first). Its files are deleted when DSH exits, or on the next start if the process dies first. Until then the id is listed in `<data-dir>/storages/dsh-session-delete.pending.json`.

## For other plugins

```js
const result = await ctx.get('dshSessionDelete').delete([sessionId])
// result: { deleted, deferred, notFound, removedPaths, errors }
```

The client talks to `POST /dsh-session-delete/delete` on DSH's own web server. That route uses DSH's browser authentication and rejects the request when no authenticated connection is present.

## Install

In DSH: **Plugins → Add plugin → install a third-party plugin** from a local folder or a link. Choose this folder (the one that contains `package.json`), then enable **Session Delete** on the Plugins page.
