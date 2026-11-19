// git-ops desktop half — repo discovery, status, generated commit message, commit / push / pull / discard.
// Plain ESM, no JSX: UI is built with jsx()/jsxs() from react/jsx-runtime.

import { atom, host, useValue, Button, Textarea, Dialog, DialogContent, DialogHeader, DialogTitle } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

let rest = null

const ID = 'git-ops'
// The backend emits one of these after every mutating tool call (commit / push / pull /
// discard), so the pane refreshes on the change instead of waiting out its poll backoff.
const GIT_EVENTS = ['commit', 'push', 'pull', 'discard']
// Last change this session was told about; the pane reads it with useValue and refreshes
// when the count moves. `repo` is the resolved work-tree root the backend acted on.
const $gitChange = atom({ seq: 0, kind: '', repo: '' })

// The composer's coding status bar (branch / ahead-behind / ±) belongs to the app core:
// there is no plugin-facing refresh door (the loader's import allowlist is
// @hermes/plugin-sdk + react, and `host` exposes no repo slot), and a pane-driven mutation
// is a REST call — no tool.complete, so the core's workspace-change edge never fires. The
// one edge the core does leave open is its `window` focus listener
// (apps/desktop/src/store/coding-status.ts), so a finished mutation pokes that edge instead
// of leaving the bar stale until the next turn settles. Its listeners are bounded read-only
// refreshes (fleet roster, metrics, background sync, sidebar), so this fires once per
// mutation — never once per repo row.
const pokeCodingBar = () => {
  try {
    window.dispatchEvent(new FocusEvent('focus'))
  } catch (err) {
    console.warn('[git-ops] coding-bar refresh', err && err.message)
  }
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const GET_TIMEOUT = 120000
const POST_TIMEOUT = 180000
const POLL_MS = 5000
const MAX_POLL_MS = 60000
const SEARCH_DEBOUNCE_MS = 150
// A mutation's own /status lands within milliseconds of the event it fires; anything that
// asks for the same repo inside this window is answering the same question twice.
const SELF_REFRESH_MS = 1500
const ROW = 24
const VIRTUAL_AFTER = 150

async function api(path, body) {
  if (!rest) throw new Error('backend not ready')
  const res = body === undefined
    ? await rest(path, { method: 'GET', timeoutMs: GET_TIMEOUT })
    : await rest(path, { method: 'POST', body, timeoutMs: POST_TIMEOUT })
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'request failed')
  return res.data
}

const enc = encodeURIComponent
const MUTED = { color: 'var(--ui-text-tertiary)' }
const STROKE = { borderColor: 'var(--ui-stroke-secondary)' }
const MONO = { fontFamily: 'var(--font-mono, ui-monospace)' }

function fallbackCopy(text) {
  // navigator.clipboard can be blocked outside a secure context; execCommand is the
  // webview-safe fallback.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (err) { return false }
}

function copyPath(path) {
  // Silent: the row itself is the affordance, no toast on success or failure.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(path).catch(() => fallbackCopy(path))
  } else {
    fallbackCopy(path)
  }
}

// Workspace rows get a status-driven text color from the porcelain-v2 XY code
// backend sends (X=index, Y=worktree; whole tokens ?? untracked, !! ignored).
// Checked by severity so a rename-with-edit or staged-delete reads as the more
// destructive status, not the more recent edit.
function codeColor(code) {
  const c = code || ''
  if (c[0] === 'U' || c[1] === 'U') return 'var(--ui-danger)'    // conflict / unmerged
  if (c === '??') return 'var(--ui-cyan)'                          // untracked
  if (c === '!!') return undefined                                 // ignored → default muted
  if (c[0] === 'D' || c[1] === 'D') return 'var(--ui-red)'         // deleted
  if (c[0] === 'R' || c[1] === 'R') return 'var(--ui-blue)'        // renamed
  if (c[0] === 'C' || c[1] === 'C') return 'var(--ui-blue)'        // copied
  if (c[0] === 'A' || c[1] === 'A') return 'var(--ui-green)'       // added
  if (c[0] === 'T' || c[1] === 'T') return 'var(--ui-orange)'      // type changed
  if (c[0] === 'M' || c[1] === 'M') return 'var(--ui-yellow)'      // modified
  return undefined
}

// Display only the workspace's own folder name; the full path stays in the tooltip.
function baseName(full) {
  const trimmed = (full || '').replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || ''
}

// Small inline SVGs for the tree. currentColor keeps them theme-aware; the two slots
// share a fixed width so folder and file NAMES align at every depth.
function FolderIcon() {
  return jsx('svg', {
    className: 'shrink-0', viewBox: '0 0 16 16', width: 14, height: 14,
    fill: 'none', 'aria-hidden': true, style: { color: 'var(--ui-text-secondary)' },
    children: jsx('path', {
      d: 'M1.5 4.5A1.5 1.5 0 0 1 3 3h2.9l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4.5Z',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round'
    })
  })
}

function FileIcon() {
  return jsx('svg', {
    className: 'shrink-0', viewBox: '0 0 16 16', width: 14, height: 14,
    fill: 'none', 'aria-hidden': true, style: { color: 'var(--ui-text-tertiary)' },
    children: jsx('path', {
      d: 'M5 1.5h3.7L12 4.8V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.5A1 1 0 0 1 5 1.5Z',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round'
    })
  })
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
      const color = line.startsWith('+++') || line.startsWith('---') ? 'var(--ui-text-tertiary)'
        : line.startsWith('+') ? 'var(--ui-green)'
        : line.startsWith('-') ? 'var(--ui-red)'
        : line.startsWith('@@') ? 'var(--ui-text-tertiary)'
        : 'var(--ui-text-secondary)'
      return jsx('div', { style: { color }, children: line || ' ' }, i)
    })
  })
}

// Rows are windowed past VIRTUAL_AFTER entries: a repo with thousands of dirty files
// must not put thousands of checkboxes in the DOM on every status poll.
function FileList({ files, picked, onPick, onOpen }) {
  const ref = useRef(null)
  const [view, setView] = useState({ top: 0, height: 320 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight || 320 })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const total = files.length
  const virtual = total > VIRTUAL_AFTER
  const start = virtual ? Math.max(0, Math.floor(view.top / ROW) - 6) : 0
  const end = virtual ? Math.min(total, Math.ceil((view.top + view.height) / ROW) + 6) : total
  const renderRow = (f) => {
    const stColor = codeColor(f.code)
    const stStyle = stColor ? { color: stColor } : undefined
    return jsxs('div', {
      className: 'flex items-center gap-2 px-1 text-xs',
      style: { height: ROW },
      children: [
        jsx('input', {
          type: 'checkbox',
          className: 'cursor-pointer',
          checked: picked.includes(f.path),
          onChange: (e) => onPick(f.path, e.target.checked)
        }),
        jsx('span', {
          className: 'flex min-w-0 flex-1 cursor-pointer items-center gap-2',
          title: `${f.path} · 点击查看 diff`,
          onClick: () => void onOpen(f.path, f.code),
          children: [
            jsx('span', { style: { ...MONO, ...(stColor ? { color: stColor } : MUTED) }, children: f.code }),
            jsx('span', { className: 'truncate font-medium', style: stStyle, children: f.path.split('/').pop() })
          ]
        })
      ]
    }, f.path + f.code)
  }
  return jsx('div', {
    ref,
    // Read scrollTop into a local BEFORE setView: React nulls e.currentTarget once the
    // handler returns, and the functional updater may run later — dereferencing it there
    // throws 'Cannot read properties of null (reading scrollTop)' and kills the pane.
    onScroll: (e) => { if (virtual) { const st = e.currentTarget ? e.currentTarget.scrollTop : 0; setView((v) => (v.top === st ? v : { ...v, top: st })) } },
    className: 'min-h-0 flex-1 overflow-auto rounded border p-1',
    style: STROKE,
    children: jsx('div', {
      style: virtual ? { position: 'relative', height: total * ROW } : undefined,
      children: jsx('div', {
        style: virtual ? { position: 'absolute', top: start * ROW, left: 0, right: 0 } : undefined,
        children: files.slice(start, end).map(renderRow)
      })
    })
  })
}

// Windowed the same way FileList does: past VIRTUAL_AFTER entries, only the visible
// window sits in the DOM, driven by scroll position.
//
// Two render modes, switched by whether a filter is active:
//   * filterActive (关键词/后缀非空) → flat filtered list (existing behaviour).
//   * otherwise → repo file tree; all dirs start collapsed, a click expands
//     that level one step, while a file row copies its path.
function SearchList({ all, files, filterActive }) {
  const ref = useRef(null)
  const [view, setView] = useState({ top: 0, height: 320 })
  // null = "user hasn't expanded anything yet" → all dirs start collapsed;
  // the first toggle materialises a concrete Set and keeps its state from then on.
  const [expanded, setExpanded] = useState(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight || 320 })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Build the prefix tree once per repo list; rebuild only when the list or mode changes.
  const tree = useMemo(() => {
    if (filterActive) return null
    const root = { name: '', path: '', isDir: true, children: new Map() }
    for (const p of all) {
      const parts = p.split('/')
      let node = root
      parts.forEach((seg, i) => {
        const last = i === parts.length - 1
        let child = node.children.get(seg)
        if (!child) {
          child = { name: seg, path: parts.slice(0, i + 1).join('/'), isDir: !last, children: last ? null : new Map() }
          node.children.set(seg, child)
        }
        node = child
      })
    }
    return root
  }, [all, filterActive])
  const open = useMemo(() => (expanded === null ? new Set() : expanded), [expanded])
  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const cur = new Set(prev === null ? new Set() : prev)
      if (cur.has(path)) cur.delete(path); else cur.add(path)
      return cur
    })
  }, [])
  // Unified windowed item list: directory rows (expandable) or flat filtered paths.
  const items = useMemo(() => {
    if (filterActive) {
      return files.map((p) => ({ path: p, name: p.split('/').pop(), depth: 0, isDir: false }))
    }
    if (!tree) return []
    const rows = []
    const walk = (node, depth) => {
      // Folders first, then files; alphabetical within each group.
      const kids = [...node.children.values()].sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
      )
      for (const child of kids) {
        rows.push({ path: child.path, name: child.name, depth, isDir: child.isDir })
        if (child.isDir && child.children && open.has(child.path)) walk(child, depth + 1)
      }
    }
    walk(tree, 0)
    return rows
  }, [filterActive, files, tree, open])
  const total = items.length
  const virtual = total > VIRTUAL_AFTER
  const start = virtual ? Math.max(0, Math.floor(view.top / ROW) - 6) : 0
  const end = virtual ? Math.min(total, Math.ceil((view.top + view.height) / ROW) + 6) : total
  const renderRow = (it) => {
    const isOpen = it.isDir && open.has(it.path)
    return jsxs('div', {
      className: 'flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 text-xs hover:bg-(--ui-row-hover-background)',
      style: { height: ROW, paddingLeft: 4 + it.depth * 12 },
      title: it.path,
      onClick: () => (it.isDir ? toggle(it.path) : copyPath(it.path)),
      children: [
        it.isDir
          ? jsx('svg', {
              className: 'shrink-0 text-(--ui-text-tertiary) transition-transform duration-150',
              style: { transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', width: 14, height: 14 },
              viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
              children: jsx('path', { d: 'M6 4l4 4-4 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })
            })
          : jsx('span', { className: 'shrink-0', style: { width: 14 } }),
        it.isDir ? jsx(FolderIcon, {}) : jsx(FileIcon, {}),
        jsx('span', {
          className: 'min-w-0 flex-1 truncate font-medium',
          style: it.isDir ? undefined : MUTED,
          children: it.name
        })
      ]
    }, it.path)
  }
  return jsx('div', {
    ref,
    // Read scrollTop into a local BEFORE setView: React nulls e.currentTarget once the
    // handler returns, and the functional updater may run later — dereferencing it there
    // throws 'Cannot read properties of null (reading scrollTop)' and kills the pane.
    onScroll: (e) => { if (virtual) { const st = e.currentTarget ? e.currentTarget.scrollTop : 0; setView((v) => (v.top === st ? v : { ...v, top: st })) } },
    className: 'max-h-64 min-h-0 overflow-auto rounded border p-1',
    style: STROKE,
    children: total
      ? jsx('div', {
          style: virtual ? { position: 'relative', height: total * ROW } : undefined,
          children: jsx('div', {
            style: virtual ? { position: 'absolute', top: start * ROW, left: 0, right: 0 } : undefined,
            children: items.slice(start, end).map(renderRow)
          })
        })
      : jsx('div', { className: 'p-1', style: MUTED, children: filterActive ? '没有匹配的文件' : '(空仓库)' })
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
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // File search: list fetched once per repo, filtered in the client.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchSuffix, setSearchSuffix] = useState('')
  // Debounced copies feed the flat file-list filter, so typing doesn't rescan a huge
  // (e.g. Unity) tree on every keystroke; the inputs still reflect keystrokes instantly.
  const [debTerm, setDebTerm] = useState('')
  const [debSuffix, setDebSuffix] = useState('')
  useEffect(() => { const id = setTimeout(() => setDebTerm(searchTerm), SEARCH_DEBOUNCE_MS); return () => clearTimeout(id) }, [searchTerm])
  useEffect(() => { const id = setTimeout(() => setDebSuffix(searchSuffix), SEARCH_DEBOUNCE_MS); return () => clearTimeout(id) }, [searchSuffix])
  const [fileList, setFileList] = useState([])
  const [fileBusy, setFileBusy] = useState(false)
  const fileCache = useRef(new Map())
  // Workspace of the focused chat (falls back to the window cwd) — what the pane acts on.
  const [workspace, setWorkspace] = useState('')
  const base = workspace || cwd

  const toast = useCallback((text, kind = 'info') => {
    host.notify({ kind, message: text })
  }, [])

  // resetPicked=false keeps the user's selection across the 5s poll and after a commit;
  // it only resets on a workspace/repo switch.
  const refreshedAt = useRef(0)
  const refresh = useCallback(async (target, at, resetPicked = false) => {
    if (!target) return null
    refreshedAt.current = Date.now()
    try {
      const st = await api(`/status?repo=${enc(target)}&cwd=${enc(at || target)}`)
      setStatus(st)
      // The repo row carries its own copy of branch/ahead/behind/dirty (scan builds it); a
      // commit or push changes them without a re-scan, so fold the fresh status back in.
      setRepos((prev) => prev.map((r) => (normPath(r.path) === normPath(st.path)
        ? { ...r, branch: st.branch, upstream: st.upstream, ahead: st.ahead,
            behind: st.behind, dirty: (st.files || []).length }
        : r)))
      const keep = new Set(st.files.map((f) => f.path))
      // A Set, not `paths.includes(p)` inside the filter: that was O(files × picked) every
      // refresh, which a repo with thousands of dirty files felt on each poll.
      setPicked((prev) => (resetPicked ? [...keep] : prev.filter((p) => keep.has(p))))
      return st
    } catch (err) {
      setStatus(null)
      console.warn('[git-ops] status', err.message)
      return null
    }
  }, [])

  // The workspace IS the root: no editing, and a workspace switch re-scans and re-selects.
  const scan = useCallback(async (root) => {
    const target = (root || '').trim()
    if (!target) return
    setBusy('scan')
    try {
      const at = enc(target)
      const data = await api(`/repos?roots=${at}&cwd=${at}&depth=6`)
      let found = data.repos
      if (!found.length) {
        // Workspace is a plain subdirectory: ask which repo owns it.
        try {
          const st = await api(`/status?repo=${at}&cwd=${at}`)
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
      if (pick) await refresh(pick.path, target, true)
    } catch (err) {
      console.warn('[git-ops] scan', err.message)
    } finally {
      setBusy('')
    }
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    setMessage('')
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
      // Same project (same resolved cwd) as already shown: keep the pane's data —
      // switching between sessions in one workspace must not force a re-scan.
      if (target === base && repos.length) {
        setWorkspace(target)
        return
      }
      setStatus(null)
      setPicked([])
      setRepos([])
      setRepo('')
      setDiff(null)
      setWorkspace(target || '')
      if (target) await scan(target)
    })()
    return () => { cancelled = true }
  }, [cwd, sessionKey, sessionId, scan, base, repos.length])

  const loadFiles = useCallback(async (target) => {
    if (!target) return
    const cached = fileCache.current.get(target)
    if (cached) { setFileList(cached); return }
    setFileBusy(true)
    try {
      const data = await api(`/files?repo=${enc(target)}&cwd=${enc(base || target)}`)
      // Drop Unity .meta companion files from the search index.
      const paths = (data.files || []).filter((p) => !p.toLowerCase().endsWith('.meta')).sort()
      fileCache.current.set(target, paths)
      setFileList(paths)
    } catch (err) {
      toast('加载文件列表失败: ' + err.message, 'error')
      setFileList([])
    } finally {
      setFileBusy(false)
    }
  }, [base, toast])

  // Open the search (or switch repo) → fetch that repo's list once; the cache makes a
  // close/reopen instant.
  useEffect(() => {
    if (searchOpen && repo) void loadFiles(repo)
  }, [searchOpen, repo, loadFiles])

  // The agent commits in the same repo from its own tool calls; without a poll the pane
  // would keep showing a stale file list until the user hit 刷新.
  // Chain the poll (no overlapping status calls), back off while nothing changes, and pause
  // while the panel isn't on screen — a fixed 5s setInterval fired a git status every 5s on
  // a clean repo behind a hidden pane.
  useEffect(() => {
    if (!repo || busy) return undefined
    let cancelled = false
    let timer = null
    let lastSig = ''
    let delay = POLL_MS
    const tick = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, POLL_MS)
        return
      }
      // A mutation just refreshed this repo; a read inside that window answers the same
      // question, so wait out the current backoff instead of paying for it twice.
      if (Date.now() - refreshedAt.current < SELF_REFRESH_MS) {
        timer = setTimeout(tick, delay)
        return
      }
      const st = await refresh(repo, base)
      // head + dirty count collapse thousands of paths to one comparison: an agent commit
      // flips head and resets the cadence, a no-op poll doubles the gap up to MAX_POLL_MS.
      const sig = st ? `${st.head || ''}|${(st.files || []).length}` : ''
      if (st && sig === lastSig) delay = Math.min(delay * 2, MAX_POLL_MS)
      else { delay = POLL_MS; if (st) lastSig = sig }
      if (!cancelled) timer = setTimeout(tick, delay)
    }
    void tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [repo, base, busy, refresh])

  // Event-driven refresh: the agent's own git_commit / git_push / git_pull / git_discard
  // tool calls push plugin.git-ops.<kind> to this session. Only the seq matters — an event
  // for another repo (or from another session, which ctx.onEvent already filtered) is
  // skipped, and a replayed frame from a reconnect never fires here.
  const change = useValue($gitChange)
  useEffect(() => {
    if (!change.seq || !repo) return
    if (change.repo && normPath(change.repo) !== normPath(repo)) return
    // Our own commit/push/discard already refreshed a few milliseconds ago — its event is the
    // same state, so a second status call would be pure waste. Agent-side events aren't
    // inside the window (no pane mutation ran) and still refresh the pane.
    if (Date.now() - refreshedAt.current < SELF_REFRESH_MS) return
    // keep the user's selection across the refresh, exactly like the poll does
    void refresh(repo, base)
  }, [change.seq, change.repo, repo, base, refresh])

  const onPick = useCallback((path, on) => {
    // Avoid the double array copy + Set build on the hot path: an include-guard is enough.
    setPicked((prev) => (on ? (prev.includes(path) ? prev : [...prev, path]) : prev.filter((p) => p !== path)))
  }, [])

  const openDiff = useCallback(async (path, untracked = false) => {
    if (!repo) return
    setDiff({ path, text: '加载中…', truncated: false })
    try {
      // The porcelain code is already in hand, so the backend never asks git whether the
      // path is untracked — one diff process per click instead of five.
      const d = await api(`/diff?repo=${enc(repo)}&path=${enc(path)}&cwd=${enc(base || repo)}`
        + `&untracked=${untracked ? 'true' : 'false'}`)
      setDiff({ path: d.path, text: d.diff, truncated: d.truncated })
    } catch (err) {
      setDiff({ path, text: '无法读取 diff: ' + err.message, truncated: false })
    }
  }, [repo, base])

  // The row opens TortoiseGit's own diff window; the in-pane dialog is the fallback
  // (no TortoiseGit, untracked/binary file, or a path TortoiseGit refuses).
  const openItem = useCallback(async (path, code) => {
    if (!repo) return
    try {
      await api('/tgit', { repo, path, cwd: base || repo })
      return
    } catch (err) {
      console.warn('[git-ops] tortoisegit unavailable:', err.message)
    }
    await openDiff(path, code === '??')
  }, [repo, base, openDiff])

  const run = useCallback(async (kind, path, body, describe, notify = false, poke = true) => {
    setBusy(kind)
    // Own the window before the call: the mutation's event can land before this promise
    // resolves, and the refresh below covers the state either way.
    refreshedAt.current = Date.now()
    try {
      const data = await api(path, body)
      // A mutation just landed in the working tree: the pane refreshes below, and the
      // composer's coding bar needs the poke because REST emits no tool.complete.
      if (poke && GIT_EVENTS.includes(kind)) pokeCodingBar()
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
      (d) => `生成 ${d.header}${d.truncated ? ' (diff 已截断)' : ''}`)
    if (data) setMessage(data.message)
  }, [repo, picked, base, run])

  // poke=false when a push follows immediately: the bar only ever shows the end state, so
  // the commit's probe would be thrown away a moment later by the push's.
  const doCommit = useCallback(async (poke = true) => {
    if (!repo) return null
    const committed = await run('commit', '/commit',
      { repo, paths: picked, message: message.trim() ? message : '', cwd: base },
      (d) => `已提交 ${d.short} ${d.header}`, true, poke)
    if (!committed) return null
    setMessage('')
    await refresh(repo, base)
    return committed
  }, [repo, picked, message, base, run, refresh])

  const commitAndPush = useCallback(async () => {
    const committed = await doCommit(false)
    if (!committed) return
    const pushed = await run('push', '/push', { repo, cwd: base },
      (d) => (d.verified ? `已推送 ${d.short} (verified)` : `推送未确认 ${d.short} ahead=${d.ahead_after}`), true)
    await refresh(repo, base)
    // The push's poke never ran: the commit still needs its probe reported.
    if (!pushed) { pokeCodingBar(); toast('提交已保存，但推送失败', 'warning') }
  }, [doCommit, repo, base, run, refresh, toast])

  const doPull = useCallback(async () => {
    if (!repo) return
    const data = await run('pull', '/pull', { repo, cwd: base, submodules: true },
      (d) => (d.pulled ? `拉取 ${d.pulled} 个提交 ${d.old}→${d.new}` : '已是最新'))
    if (data) await refresh(repo, base)
  }, [repo, base, run, refresh])

  const doDiscard = useCallback(async () => {
    setConfirmDiscard(false)
    if (!repo || !picked.length) return
    const data = await run('discard', '/discard', { repo, paths: picked, cwd: base },
      (d) => `已放弃 ${d.discarded.length} 个文件的修改`, true)
    if (data) await refresh(repo, base)
  }, [repo, picked, base, run, refresh])

  const files = (status && status.files) || []
  const repoReady = Boolean(repo) && repos.some((r) => r.path === repo)
  const disabled = !repoReady || Boolean(busy)
  const allPicked = files.length > 0 && picked.length === files.length
  const repoLabel = useMemo(() => (repo ? baseName(repo) : ''), [repo])
  // Client-side search filter: term matches anywhere in the repo-relative path,
  // suffix matches the bytes after the last dot ('.py' and '*.py' both accepted).
  const visibleFiles = useMemo(() => {
    const term = debTerm.trim().toLowerCase()
    const suffix = debSuffix.trim().replace(/^\*/, '').replace(/^\./, '').toLowerCase()
    return fileList.filter((p) => {
      if (term && !p.toLowerCase().includes(term)) return false
      if (suffix) {
        const dot = p.lastIndexOf('.')
        if (dot < 0 || p.slice(dot + 1).toLowerCase() !== suffix) return false
      }
      return true
    })
  }, [fileList, debTerm, debSuffix])

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 overflow-hidden p-3 text-sm',
    children: [
      jsxs(Row, {
        children: [
          jsx('button', {
            type: 'button',
            onClick: () => setSearchOpen((o) => !o),
            className: 'flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs',
            title: searchOpen ? '收起文件搜索' : '展开文件搜索',
            children: [
              jsx('span', { className: 'shrink-0', style: MUTED, children: searchOpen ? '▾' : '▸' }),
              jsx('span', { style: MUTED, children: '文件搜索' }),
              fileBusy ? jsx('span', { style: MUTED, children: ' …' }) : null
            ]
          }),
          jsx(Button, {
            size: 'sm', variant: 'secondary',
            onClick: () => scan(base),
            disabled: Boolean(busy) || !base,
            children: busy === 'scan' ? '扫描中…' : '刷新'
          })
        ]
      }),
      searchOpen
        ? jsxs('div', { className: 'shrink-0 flex flex-col gap-1 px-0.5 pb-1', children: [
            jsxs('div', { className: 'grid grid-cols-2 gap-1', children: [
              jsx('input', {
                value: searchTerm,
                onChange: (e) => setSearchTerm(e.target.value),
                placeholder: '文件名关键词',
                className: 'rounded border px-1.5 py-0.5 text-xs',
                style: STROKE
              }),
              jsx('input', {
                value: searchSuffix,
                onChange: (e) => setSearchSuffix(e.target.value),
                placeholder: '后缀，如 .py',
                className: 'rounded border px-1.5 py-0.5 text-xs',
                style: STROKE
              })
            ] }),
            jsxs('div', { className: 'flex items-center justify-between px-0.5', children: [
              jsx('span', { className: 'text-xs', style: MUTED,
                children: `共 ${fileList.length} 个文件，匹配 ${visibleFiles.length}` }),
              jsx('button', {
                type: 'button',
                onClick: () => { setSearchTerm(''); setSearchSuffix('') },
                disabled: !searchTerm && !searchSuffix,
                className: 'rounded px-1 py-0.5 text-xs hover:bg-(--ui-row-hover-background) disabled:opacity-40',
                style: MUTED,
                title: '清除过滤条件',
                children: '清除'
              })
            ] }),
            jsx(SearchList, {
              all: fileList,
              files: visibleFiles,
              filterActive: Boolean(debTerm || debSuffix)
            })
          ] })
        : null,
        // Hairline dividing the File module (search) from the Git module below.
        jsx('div', { className: 'h-px shrink-0', style: { background: 'var(--ui-stroke-secondary)' } }),
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
                  setPicked([])
                  void refresh(r.path, base, true)
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
      files.length
        ? jsx(FileList, { files, picked, onPick, onOpen: openItem })
        : jsx('div', {
            className: 'min-h-0 flex-1 overflow-auto rounded border p-1 text-xs',
            style: { ...STROKE, ...MUTED },
            children: jsx('div', { className: 'p-1', children: repoReady ? '工作区干净' : '无 Git 仓库' })
          }),
      jsx(Textarea, {
        value: message,
        rows: 3,
        placeholder: '提交信息（可留空，提交时自动生成）',
        onChange: (e) => setMessage(e.target.value),
        className: 'text-xs',
        // Same hairline as the workspace box above: the shared input chrome
        // tints its border off --dt-input-border (7% / 4% in dark), which reads
        // too dark next to the stroke-secondary borders around it.
        style: STROKE
      }),
      jsxs('div', { className: 'grid shrink-0 grid-cols-3 gap-1', children: [
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: generate,
          children: busy === 'info' ? '生成中…' : '生成信息' }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: () => { void doCommit() },
          children: busy === 'commit' ? '提交中…' : '仅提交' }),
        jsx(Button, { size: 'sm', className: 'w-full',
          disabled: disabled || !picked.length, onClick: commitAndPush,
          children: busy === 'push' ? '推送中…' : '提交并推送' })
      ] }),
      jsxs('div', { className: 'grid shrink-0 grid-cols-3 gap-1', children: [
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || allPicked || !files.length,
          onClick: () => setPicked(files.map((f) => f.path)),
          children: '全选' }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: () => setPicked([]),
          children: '清空' }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: () => setConfirmDiscard(true),
          children: busy === 'discard' ? '放弃中…' : '放弃修改' })
      ] }),
      jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full shrink-0',
        disabled, onClick: doPull,
        children: busy === 'pull' ? '拉取中…' : '拉取' }),
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
      }),
      jsx(Dialog, {
        open: confirmDiscard,
        onOpenChange: setConfirmDiscard,
        children: jsx(DialogContent, {
          className: 'max-w-md',
          children: jsxs('div', {
            className: 'flex flex-col gap-3',
            children: [
              jsx(DialogHeader, {
                children: jsx(DialogTitle, { className: 'text-sm', children: '放弃修改？' })
              }),
              jsx('div', { className: 'text-xs', style: MUTED,
                children: `将把 ${picked.length} 个已跟踪文件的索引与工作区还原到 HEAD，不可撤销。未跟踪文件不在其中。` }),
              jsxs('div', { className: 'flex justify-end gap-2', children: [
                jsx(Button, { size: 'sm', variant: 'secondary', onClick: () => setConfirmDiscard(false),
                  children: '取消' }),
                jsx(Button, { size: 'sm', onClick: doDiscard, children: '确认放弃' })
              ] })
            ]
          })
        })
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Git Ops',
  register(ctx) {

    rest = ctx.rest

    // ctx.onEvent (not host.onEvent): the loader disposes these on reload/disable, so a
    // module swap cannot stack duplicate listeners. Replayed frames are old turns —
    // refreshing from them would undo nothing but wastes a status call, so drop them.
    const on = typeof ctx.onEvent === 'function' ? ctx.onEvent.bind(ctx) : host.onEvent.bind(host)
    for (const kind of GIT_EVENTS) {
      on(`plugin.${ID}.${kind}`, (event) => {
        if (!event || event.replayed) return
        const payload = event.payload || {}
        const prev = $gitChange.get()
        $gitChange.set({ seq: prev.seq + 1, kind, repo: payload.repo || '' })
        // An agent-side tool call did this one; no pane mutation ran, so the coding
        // bar still needs the poke.
        pokeCodingBar()
      })
    }

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

