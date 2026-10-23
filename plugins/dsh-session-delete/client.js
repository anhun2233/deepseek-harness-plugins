/* Session Delete — client half: a "Delete permanently" row in the session "…" menu, plus a confirm dialog in shell.overlay. */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const UI = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const zh = () => /^zh/i.test(document.documentElement.lang || navigator.language || '')
    const T = {
      menu: () => zh() ? '永久删除' : 'Delete permanently',
      title: () => zh() ? '永久删除会话？' : 'Delete session permanently?',
      desc: (t) => zh()
        ? `「${t || '未命名会话'}」的全部消息、记录和缓存会从 DSH 存储中删除，无法恢复。`
        : `All messages, logs and caches of "${t || 'Untitled session'}" are removed from DSH storage. This cannot be undone.`,
      cancel: () => zh() ? '取消' : 'Cancel',
      confirm: () => zh() ? '永久删除' : 'Delete',
      busy: () => zh() ? '正在删除…' : 'Deleting…',
      close: () => zh() ? '关闭' : 'Close',
      deferred: () => zh()
        ? '会话已移出列表。它正在本次运行中使用，磁盘文件会在退出或下次启动 DSH 时清除。'
        : 'Removed from the list. It is loaded in this run, so its files are removed when DSH exits or next starts.',
    }

    // Tiny shared store: the menu row raises a request, the overlay dialog answers it.
    let request = null
    const listeners = new Set()
    const setRequest = (next) => { request = next; for (const l of listeners) l() }
    const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
    const useRequest = () => React.useSyncExternalStore(subscribe, () => request)

    async function deleteSession(sessionId) {
      const response = await fetch('dsh-session-delete/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload = {}
      try { payload = await response.json() } catch { /* empty */ }
      if (!response.ok) throw new Error(payload.error || (payload.errors && payload.errors[0] && payload.errors[0].error) || `HTTP ${response.status}`)
      return payload
    }

    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(UI.MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: h(UI.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => { setMenuOpen(false); setRequest({ sessionId, displayTitle, phase: 'confirm' }) },
      }, T.menu())
    }

    function ConfirmDialog() {
      const current = useRequest()
      if (current === null) return null
      const busy = current.phase === 'busy'
      const close = () => { if (!busy) setRequest(null) }
      const confirm = () => {
        setRequest({ ...current, phase: 'busy', error: null })
        deleteSession(current.sessionId).then((result) => {
          if (result.deferred && result.deferred.length > 0 && (!result.deleted || !result.deleted.includes(current.sessionId))) {
            setRequest({ ...current, phase: 'done', note: T.deferred() })
          } else {
            setRequest(null)
          }
        }).catch((error) => {
          setRequest({ ...current, phase: 'confirm', error: error instanceof Error ? error.message : String(error) })
        })
      }
      const footer = current.phase === 'done'
        ? h(UI.Button, { variant: 'outline', onClick: () => setRequest(null) }, T.close())
        : h(React.Fragment, null,
          h(UI.Button, { variant: 'outline', disabled: busy, onClick: close }, T.cancel()),
          h(UI.Button, { variant: 'primary', disabled: busy, onClick: confirm, 'data-dsh-delete-confirm': '1' }, busy ? T.busy() : T.confirm()))
      return h(UI.Modal, {
        open: true,
        onClose: close,
        closeLabel: T.close(),
        title: T.title(),
        description: T.desc(current.displayTitle),
        footer,
      },
      current.note ? h('div', { role: 'status', style: { fontSize: 13, lineHeight: '20px' } }, current.note) : null,
      current.error ? h('div', { role: 'alert', style: { color: 'var(--dsw-color-text-error, #e5484d)', fontSize: 13 } }, current.error) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-delete', order: 900 },
          DeleteMenuItem,
        ))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-session-delete-confirm', order: 900 },
          ConfirmDialog,
        ))
        ctx.effect(() => () => setRequest(null))
      },
    }
  },
})
