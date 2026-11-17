// git-ops desktop half — repo discovery, status, generated commit message, commit / push / pull.
// Plain ESM, no JSX: UI is built with jsx()/jsxs() from react/jsx-runtime.

import { host, useValue, Button, Textarea, Dialog, DialogContent, DialogHeader, DialogTitle } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'

let rest = null

async function api(path, body) {
  if (!rest) throw new Error('backend not ready')
  const res = body === undefined
    ? await rest(path, { method: 'GET', timeoutMs: 120000 })
    : await rest(path, { method: 'POST', body, timeoutMs: 180000 })
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'request failed')
  return res.data
}

const MUTED = { color: 'var(--ui-text-tertiary)' }
const STROKE = { borderColor: 'var(--ui-stroke-secondary)' }
const MONO = { fontFamily: 'var(--font-mono, ui-monospace)' }

// Display only the workspace's own folder name; the full path stays in the tooltip.
function baseName(full) {
  const trimmed = (full || '').replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || ''
}


function Row({ children, style }) {
  return jsx('div', { className: 'flex items-center gap-2', style, children })
}

function DiffBody({ text }) {
  const lines = (text || '').split('\n')
  return jsx('pre', {
    className: 'max-h-[60vh] overflow-auto rounded border p-2 text-xs leading-5',
    style: { ...MONO, ...STROKE },
    children: lines.map((line, i) => {
      const head = line.slice(0, 3)
      const color = head.startsWith('+++') || head.startsWith('---') ? 'var(--ui-text-tertiary)'
        : line.startsWith('+') ? 'var(--ui-green)'
        : line.startsWith('-') ? 'var(--ui-red)'
        : line.startsWith('@@') ? 'var(--ui-text-tertiary)'
        : 'var(--ui-text-secondary)'
      return jsx('div', { style: { color }, children: line || ' ' }, i)
    })
  })
}

function GitPane() {
  const cwd = useValue(host.state.cwd)
  // Sessions switch within one workspace without moving cwd, and host.state.cwd tracks the
  // primary chat — so resolve the FOCUSED chat's own cwd over RPC and fall back to cwd.
  const sessionId = useValue(host.state.focusedSessionId)
  const storedSessionId = useValue(host.state.focusedStoredSessionId)
  const sessionKey = sessionId || storedSessionId || ''
  const cwdCache = useRef(new Map())
  const [repos, setRepos] = useState([])
  const [repo, setRepo] = useState('')
  const [status, setStatus] = useState(null)
  const [picked, setPicked] = useState([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [diff, setDiff] = useState(null)
  // Workspace of the focused chat (falls back to the window cwd) — what the pane acts on.
  const [workspace, setWorkspace] = useState('')
  const base = workspace || cwd
  const cwdName = baseName(base)

  const toast = useCallback((message, kind = 'info') => {
    host.notify({ kind, message })
  }, [])

  const refresh = useCallback(async (target, base) => {
    if (!target) return
    try {
      const st = await api(`/status?repo=${encodeURIComponent(target)}&cwd=${encodeURIComponent(base || target)}`)
      setStatus(st)
      setPicked(st.files.map((f) => f.path))
    } catch (err) {
      setStatus(null)
      console.warn('[git-ops] status', err.message)
    }
  }, [])

  // The workspace IS the root: no editing, and a workspace switch re-scans and re-selects.
  const scan = useCallback(async (root) => {
    const target = (root || '').trim()
    if (!target) return
    setBusy('scan')
    try {
      const base = encodeURIComponent(target)
      const data = await api(`/repos?roots=${base}&cwd=${base}&depth=6`)
      let found = data.repos
      if (!found.length) {
        // Workspace is a plain subdirectory: ask which repo owns it.
        try {
          const st = await api(`/status?repo=${base}&cwd=${base}`)
          found = [{ path: st.path, kind: 'main', parent: '', branch: st.branch,
            upstream: st.upstream, ahead: st.ahead, behind: st.behind, dirty: st.files.length }]
        } catch {
          found = []
        }
      }
      setRepos(found)
      const lower = target.replace(/\\/g, '/').toLowerCase()
      const owner = found
        .filter((r) => r.path.toLowerCase() === lower || lower.startsWith(r.path.toLowerCase() + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0]
      const pick = owner || found.find((r) => r.kind === 'main') || found[0]
      setRepo(pick ? pick.path : '')
      if (pick) await refresh(pick.path, target)
    } catch (err) {
      console.warn('[git-ops] scan', err.message)
    } finally {
      setBusy('')
    }
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setPicked([])
    setMessage('')
    setRepos([])
    setRepo('')
    setDiff(null)
    void (async () => {
      let target = cwd
      if (sessionKey) {
        const cached = cwdCache.current.get(sessionKey)
        if (cached) target = cached
        else if (sessionId) {
          try {
            const info = await host.request('session.info', { session_id: sessionId })
            if (info && info.cwd) {
              cwdCache.current.set(sessionKey, info.cwd)
              target = info.cwd
            }
          } catch (err) {
            console.warn('[git-ops] session.info', err && err.message)
          }
        }
      }
      if (cancelled) return
      setWorkspace(target || '')
      if (target) await scan(target)
    })()
    return () => { cancelled = true }
  }, [cwd, sessionKey, sessionId, scan])

  const onPick = useCallback((path, on) => {
    setPicked((prev) => (on ? [...new Set([...prev, path])] : prev.filter((p) => p !== path)))
  }, [])

  const openDiff = useCallback(async (path) => {
    if (!repo) return
    setDiff({ path, text: '加载中…', truncated: false })
    try {
      const d = await api(`/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`
        + `&cwd=${encodeURIComponent(base || repo)}`)
      setDiff({ path: d.path, text: d.diff, truncated: d.truncated })
    } catch (err) {
      setDiff({ path, text: '无法读取 diff: ' + err.message, truncated: false })
    }
  }, [repo, base])

  const run = useCallback(async (kind, path, body, describe, notify = false) => {
    setBusy(kind)
    try {
      const data = await api(path, body)
      if (notify) toast(describe(data), 'success')
      return data
    } catch (err) {
      if (notify) toast('失败: ' + err.message, 'error')
      else console.warn('[git-ops]', kind, err.message)
      return null
    } finally {
      setBusy('')
    }
  }, [toast])

  const generate = useCallback(async () => {
    if (!repo) return
    const data = await run('info', '/commit-info', { repo, paths: picked, cwd: base },
      (d) => `生成 ${d.header}${d.truncated ? ' (diff 已截断)' : ''}`, true)
    if (data) setMessage(data.message)
  }, [repo, picked, base, run])

  const commitAndPush = useCallback(async () => {
    if (!repo) return
    const committed = await run('commit', '/commit',
      { repo, paths: picked, message: message.trim() ? message : '', cwd: base },
      (d) => `已提交 ${d.short} ${d.header}`, true)
    if (!committed) return
    setMessage('')
    const pushed = await run('push', '/push', { repo, cwd: base },
      (d) => (d.verified ? `已推送 ${d.short} (verified)` : `推送未确认 ${d.short} ahead=${d.ahead_after}`), true)
    await refresh(repo)
    if (!pushed) toast('提交已保存，但推送失败', 'warning')
  }, [repo, picked, message, base, run, refresh, toast])

  const doPull = useCallback(async () => {
    if (!repo) {
      console.warn('[git-ops] pull skipped: no repo in the current workspace')
      return
    }
    const data = await run('pull', '/pull', { repo, cwd: base, submodules: true },
      (d) => (d.pulled ? `拉取 ${d.pulled} 个提交 ${d.old}→${d.new}` : '已是最新'))
    if (data) await refresh(repo)
  }, [repo, base, run, refresh])

  const repoReady = Boolean(repo) && repos.some((r) => r.path === repo)
  const disabled = !repoReady || Boolean(busy)

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 overflow-hidden p-3 text-sm',
    children: [
      jsxs(Row, {
        children: [
          jsx('div', {
            className: 'h-7 flex-1 truncate rounded border px-2 py-1 text-xs',
            style: { ...STROKE, ...MONO, color: 'var(--ui-text-secondary)' },
            title: base || '',
            children: cwdName || '(无激活工作区)'
          }),
          jsx(Button, {
            size: 'sm', variant: 'secondary',
            onClick: () => scan(base),
            disabled: Boolean(busy) || !base,
            children: busy === 'scan' ? '扫描中…' : '刷新'
          })
        ]
      }),
      jsx('div', {
        className: 'max-h-28 shrink-0 overflow-auto rounded border',
        style: { ...STROKE, background: 'var(--ui-bg-tertiary)' },
        children: repos.length
          ? repos.map((r) => {
              const active = r.path === repo
              return jsx('button', {
                type: 'button',
                onClick: () => {
                  setRepo(r.path)
                  setMessage('')
                  setDiff(null)
                  refresh(r.path)
                },
                className: 'flex w-full items-center gap-1 px-1.5 py-1 text-left text-xs',
                style: {
                  background: active ? 'var(--ui-row-active-background)' : 'transparent',
                  borderLeft: `2px solid ${active ? 'var(--ui-accent)' : 'transparent'}`,
                  color: 'var(--ui-text-primary)',
                  fontWeight: active ? 500 : 400
                },
                title: r.path,
                children: [
                  jsx('span', { className: 'truncate', children: `${r.kind === 'submodule' ? '↳ ' : ''}${r.path.split('/').pop()}` }),
                  jsx('span', { className: 'ml-auto shrink-0', style: MUTED,
                    children: `${r.branch} ↑${r.ahead ?? '?'} ↓${r.behind ?? '?'}${r.dirty ? ` *${r.dirty}` : ''}` })
                ]
              }, r.path)
            })
          : jsx('div', { className: 'px-1.5 py-1 text-xs', style: MUTED, children: '未找到仓库' })
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-auto rounded border p-1',
        style: STROKE,
        children: status && status.files.length
          ? status.files.map((f) => jsxs('div', {
              className: 'flex items-center gap-2 px-1 py-0.5 text-xs',
              children: [
                jsx('input', {
                  type: 'checkbox',
                  className: 'cursor-pointer',
                  checked: picked.includes(f.path),
                  onChange: (e) => onPick(f.path, e.target.checked)
                }),
                jsx('span', {
                  className: 'flex min-w-0 flex-1 cursor-pointer items-center gap-2',
                  title: '点击查看 diff',
                  onClick: () => void openDiff(f.path),
                  children: [
                    jsx('span', { style: { ...MONO, ...MUTED }, children: f.code }),
                    jsx('span', { className: 'truncate', children: f.path })
                  ]
                })
              ]
            }, f.path + f.code))
          : jsx('div', { className: 'p-1 text-xs', style: MUTED,
              children: repoReady ? '工作区干净' : '无 Git 仓库' })
      }),
      jsx(Textarea, {
        value: message,
        rows: 4,
        placeholder: '提交信息（可留空，提交时自动生成）',
        onChange: (e) => setMessage(e.target.value),
        className: 'text-xs',
        // Same hairline as the workspace box above: the shared input chrome
        // tints its border off --dt-input-border (7% / 4% in dark), which reads
        // too dark next to the stroke-secondary borders around it.
        style: STROKE
      }),
      jsxs('div', { className: 'grid shrink-0 grid-cols-3 gap-1', children: [
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full', disabled: disabled || !picked.length,
          onClick: generate, children: busy === 'info' ? '生成中…' : '生成信息' }),
        jsx(Button, { size: 'sm', className: 'w-full', disabled: disabled || !picked.length,
          onClick: commitAndPush,
          children: busy === 'commit' ? '提交中…' : busy === 'push' ? '推送中…' : '提交并推送' }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full', disabled, onClick: doPull,
          children: busy === 'pull' ? '拉取中…' : '拉取' })
      ] }),
      jsx(Dialog, {
        open: Boolean(diff),
        onOpenChange: (open) => { if (!open) setDiff(null) },
        children: jsx(DialogContent, {
          className: 'max-w-3xl',
          children: jsxs('div', {
            className: 'flex flex-col gap-2',
            children: [
              jsx(DialogHeader, {
                children: jsx(DialogTitle, {
                  className: 'truncate text-sm',
                  style: MONO,
                  children: diff ? diff.path : ''
                })
              }),
              jsx(DiffBody, { text: diff ? diff.text : '' }),
              diff && diff.truncated
                ? jsx('div', { className: 'text-xs', style: MUTED, children: 'diff 已截断' })
                : null
            ]
          })
        })
      })
    ]
  })
}

export default {
  id: 'git-ops',
  name: 'Git Ops',
  register(ctx) {
    rest = ctx.rest
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Git',
      order: 60,
      data: { placement: 'right', width: '380px' },
      render: () => jsx(GitPane, {})
    })
  }
}
