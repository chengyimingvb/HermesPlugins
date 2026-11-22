// git-ops desktop half — repo discovery, status, generated commit message, commit / push / pull / discard.
// Plain ESM, no JSX: UI is built with jsx()/jsxs() from react/jsx-runtime.

import {
  atom, host, useValue, usePluginI18n, Button, Textarea, Input,
  Dialog, DialogContent, DialogHeader, DialogTitle, writeClipboardText
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

let rest = null
// The plugin context, kept for its SCOPED lifecycle doors (setTimeout / storage). A bare
// setTimeout survives a plugin reload and stacks a second poller on the first — the host
// can only cancel timers it handed out itself.
let ctxRef = null
let store = null

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
const SEARCH_DEBOUNCE_MS = 150
// A mutation's own /status lands within milliseconds of the event it fires; anything that
// asks for the same repo inside this window is answering the same question twice.
const SELF_REFRESH_MS = 1500
const ROW = 24
const VIRTUAL_AFTER = 150

// ── preferences (ctx.storage) ────────────────────────────────────────────
// Everything that used to be a literal in this file — the .meta filter, the poll cadence,
// the scan depth — is a user preference now, persisted per profile and edited in
// Settings ▸ Plugins ▸ Git Ops.

const PREF_KEY = 'prefs'
const PREF_DEFAULTS = { ignoreSuffixes: '.meta', pollSeconds: 5, scanDepth: 6 }
const POLL_MIN_S = 2
const POLL_MAX_S = 120
const DEPTH_MIN = 1
const DEPTH_MAX = 12

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Stored prefs, coerced — a hand-edited or partially-written record must not poison the pane. */
function readPrefs() {
  let raw = {}
  try {
    raw = (store && store.get(PREF_KEY, {})) || {}
  } catch (err) {
    console.warn('[git-ops] prefs', err && err.message)
  }
  return {
    ignoreSuffixes: typeof raw.ignoreSuffixes === 'string'
      ? raw.ignoreSuffixes
      : PREF_DEFAULTS.ignoreSuffixes,
    pollSeconds: clampInt(raw.pollSeconds, POLL_MIN_S, POLL_MAX_S, PREF_DEFAULTS.pollSeconds),
    scanDepth: clampInt(raw.scanDepth, DEPTH_MIN, DEPTH_MAX, PREF_DEFAULTS.scanDepth)
  }
}

const $prefs = atom(PREF_DEFAULTS)

function savePrefs(next) {
  const clean = {
    ignoreSuffixes: String(next.ignoreSuffixes || ''),
    pollSeconds: clampInt(next.pollSeconds, POLL_MIN_S, POLL_MAX_S, PREF_DEFAULTS.pollSeconds),
    scanDepth: clampInt(next.scanDepth, DEPTH_MIN, DEPTH_MAX, PREF_DEFAULTS.scanDepth)
  }
  try {
    if (store) store.set(PREF_KEY, clean)
  } catch (err) {
    console.warn('[git-ops] prefs save', err && err.message)
  }
  $prefs.set(clean)
  return clean
}

/** '.meta, *.asset' → ['.meta', '.asset'] — the suffix test is a plain endsWith. */
function parseSuffixes(text) {
  return String(text || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\*/, ''))
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : '.' + s))
}

// ── scoped timers ────────────────────────────────────────────────────────
// ctx.setTimeout is cancelled on unload/reload/disable; a raw one is not. The fallback
// keeps an older host working.

const scopedTimeout = (fn, ms) => {
  if (ctxRef && typeof ctxRef.setTimeout === 'function') return ctxRef.setTimeout(fn, ms)
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

// ── repo file index cache ────────────────────────────────────────────────
// Module scope, not a component ref: the settings page rewrites the ignore suffixes and
// must drop every cached listing. Entries expire, and a mutation for that repo drops its
// entry outright — an agent-added file used to stay invisible to search forever.

const FILE_CACHE_TTL_MS = 180000
const FILE_CACHE_MAX = 8
const fileCache = new Map() // `${repo}\0${suffixes}` -> { files: string[], at: number }

// The suffix list is part of the key: a listing filtered by '.meta' must never answer a
// request filtered by '.asset, .meta'.
const cacheKey = (repo, suffixes) => `${repo}\u0000${suffixes.join(',')}`

// A mutation can add or rename paths, so every suffix variant of one repo goes at once.
// Compared on the normalised path: the event carries the backend's spelling of the root.
function invalidateFiles(repo) {
  const wanted = normPath(repo)
  for (const key of [...fileCache.keys()]) {
    if (normPath(key.split('\u0000')[0]) === wanted) fileCache.delete(key)
  }
}

function cacheFiles(key, files) {
  fileCache.set(key, { files, at: Date.now() })
  if (fileCache.size <= FILE_CACHE_MAX) return
  let oldest = ''
  let at = Infinity
  for (const [key, entry] of fileCache) {
    if (entry.at < at) {
      at = entry.at
      oldest = key
    }
  }
  if (oldest) fileCache.delete(oldest)
}

// ── i18n ─────────────────────────────────────────────────────────────────
// Strings live in this plugin's own bundles; the app's active locale picks one. Any new
// user-visible text goes here, never inline in a render.

const MESSAGES = {
  zh: {
    search: {
      toggle: '文件搜索',
      expand: '展开文件搜索',
      collapse: '收起文件搜索',
      term: '文件名关键词',
      suffix: '后缀，如 .py',
      count: (total, matched) => `共 ${total} 个文件，匹配 ${matched}`,
      clear: '清除',
      clearTip: '清除过滤条件',
      empty: '没有匹配的文件',
      emptyRepo: '(空仓库)'
    },
    git: { noRepo: '未找到仓库', clean: '工作区干净', noGit: '无 Git 仓库' },
    tip: {
      row: '点击打开 diff（TortoiseGit / VS Code）',
      openFile: '点击用 VS Code 打开',
      copyPath: '复制工程内路径'
    },
    message: { placeholder: '提交信息（可留空，提交时自动生成）' },
    button: {
      scan: '扫描中…',
      refresh: '刷新',
      generate: '生成信息',
      generating: '生成中…',
      commit: '仅提交',
      committing: '提交中…',
      commitPush: '提交并推送',
      pushing: '推送中…',
      all: '全选',
      none: '清空',
      discard: '放弃修改',
      discarding: '放弃中…',
      pull: '拉取',
      pulling: '拉取中…',
      cancel: '取消',
      confirmDiscard: '确认放弃',
      reset: '恢复默认',
      save: '保存'
    },
    diff: { truncated: 'diff 已截断', loading: '加载中…', failed: (m) => `无法读取 diff: ${m}` },
    discard: {
      title: '放弃修改？',
      body: (n) => `将把 ${n} 个已跟踪文件的索引与工作区还原到 HEAD，不可撤销。未跟踪文件不在其中。`
    },
    toast: {
      generated: (header, truncated) => `生成 ${header}${truncated ? '（diff 已截断）' : ''}`,
      committed: (short, header) => `已提交 ${short} ${header}`,
      pushed: (short) => `已推送 ${short} (verified)`,
      pushUnverified: (short, ahead) => `推送未确认 ${short} ahead=${ahead}`,
      committedNotPushed: '提交已保存，但推送失败',
      pulled: (n, from, to) => `拉取 ${n} 个提交 ${from}→${to}`,
      upToDate: '已是最新',
      discarded: (n) => `已放弃 ${n} 个文件的修改`,
      failed: (m) => `失败: ${m}`,
      filesFailed: (m) => `加载文件列表失败: ${m}`,
      openFailed: (m) => `无法用 VS Code 打开: ${m}`,
      prefsSaved: '设置已保存'
    },
    settings: {
      intro: '面板行为。保存后立即生效。',
      ignoreLabel: '忽略的后缀（逗号分隔）',
      ignoreHint: '文件搜索里隐藏这些后缀，如 .meta 用于 Unity 工程',
      pollLabel: '轮询间隔（秒）',
      pollHint: '空闲时按指数退避放大，最长 12 倍',
      depthLabel: '扫描深度',
      depthHint: '工作区往下找仓库的层数'
    }
  },
  en: {
    search: {
      toggle: 'File search',
      expand: 'Expand file search',
      collapse: 'Collapse file search',
      term: 'Filename keyword',
      suffix: 'Suffix, e.g. .py',
      count: (total, matched) => `${total} files, ${matched} matched`,
      clear: 'Clear',
      clearTip: 'Clear the filters',
      empty: 'No matching file',
      emptyRepo: '(empty repo)'
    },
    git: { noRepo: 'No repository found', clean: 'Working tree clean', noGit: 'No git repository' },
    tip: {
      row: 'Click to open the diff (TortoiseGit / VS Code)',
      openFile: 'Click to open in VS Code',
      copyPath: 'Copy the repo-relative path'
    },
    message: { placeholder: 'Commit message (leave empty to generate one)' },
    button: {
      scan: 'Scanning…',
      refresh: 'Refresh',
      generate: 'Generate',
      generating: 'Generating…',
      commit: 'Commit',
      committing: 'Committing…',
      commitPush: 'Commit & push',
      pushing: 'Pushing…',
      all: 'Select all',
      none: 'Clear',
      discard: 'Discard',
      discarding: 'Discarding…',
      pull: 'Pull',
      pulling: 'Pulling…',
      cancel: 'Cancel',
      confirmDiscard: 'Discard',
      reset: 'Defaults',
      save: 'Save'
    },
    diff: { truncated: 'diff truncated', loading: 'Loading…', failed: (m) => `Cannot read the diff: ${m}` },
    discard: {
      title: 'Discard changes?',
      body: (n) => `Index and work tree of ${n} tracked files go back to HEAD. Irreversible. Untracked files are not included.`
    },
    toast: {
      generated: (header, truncated) => `Generated ${header}${truncated ? ' (diff truncated)' : ''}`,
      committed: (short, header) => `Committed ${short} ${header}`,
      pushed: (short) => `Pushed ${short} (verified)`,
      pushUnverified: (short, ahead) => `Push unconfirmed ${short} ahead=${ahead}`,
      committedNotPushed: 'Commit saved, but the push failed',
      pulled: (n, from, to) => `Pulled ${n} commits ${from}→${to}`,
      upToDate: 'Already up to date',
      discarded: (n) => `Discarded changes in ${n} files`,
      failed: (m) => `Failed: ${m}`,
      filesFailed: (m) => `Cannot load the file list: ${m}`,
      openFailed: (m) => `Cannot open it in VS Code: ${m}`,
      prefsSaved: 'Settings saved'
    },
    settings: {
      intro: 'Pane behaviour. Changes apply as soon as they are saved.',
      ignoreLabel: 'Ignored suffixes (comma separated)',
      ignoreHint: 'Hidden from file search, e.g. .meta for Unity projects',
      pollLabel: 'Poll interval (seconds)',
      pollHint: 'Backs off exponentially while idle, up to 12x',
      depthLabel: 'Scan depth',
      depthHint: 'Levels searched below the workspace'
    }
  }
}

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

function copyPath(path) {
  // Silent: the row itself is the affordance, no toast on success or failure. The SDK
  // helper owns the Electron IPC → Clipboard API → selection-copy ladder.
  void writeClipboardText(path)
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

// Same fixed 13px slot in the 24px row as the folder/file glyphs, so the tree's names
// keep their column when the hover-only button appears.
function CopyIcon() {
  return jsx('svg', {
    className: 'shrink-0', viewBox: '0 0 16 16', width: 13, height: 13,
    fill: 'none', 'aria-hidden': true, style: { color: 'var(--ui-text-tertiary)' },
    children: jsx('path', {
      d: 'M6.5 1.5H11a1 1 0 0 1 1 1V7M4.5 4.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round'
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
  const t = usePluginI18n(ID)
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
          title: `${f.path} · ${t('tip.row')}`,
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
//     that level one step, while a file row opens the file in VS Code and its
//     hover-only button copies the repo-relative path.
//
// File rows share one click/hover contract in both modes: click = open in VS Code,
// hover = reveal the copy button.
function SearchList({ all, files, filterActive, onOpen }) {
  const t = usePluginI18n(ID)
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
      className: 'group flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 text-xs hover:bg-(--ui-row-hover-background)',
      style: { height: ROW, paddingLeft: 4 + it.depth * 12 },
      title: it.isDir ? it.path : `${it.path} · ${t('tip.openFile')}`,
      onClick: () => (it.isDir ? toggle(it.path) : void onOpen(it.path)),
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
        }),
        // The row opens the file, so copying its repo-relative path needs its own door.
        // group-hover (a real emitted rule) fades it in over the row's 24px box; the hit
        // area follows the fade, so a click on the invisible corner still opens the file.
        it.isDir ? null : jsx('button', {
          type: 'button',
          className: 'ml-1 shrink-0 cursor-pointer rounded px-1 py-0.5 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto hover:bg-(--ui-bg-tertiary)',
          title: t('tip.copyPath'),
          'aria-label': t('tip.copyPath'),
          onClick: (e) => { e.stopPropagation(); copyPath(it.path) },
          children: jsx(CopyIcon, {})
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
      : jsx('div', { className: 'p-1', style: MUTED, children: filterActive ? t('search.empty') : t('search.emptyRepo') })
  })
}

function GitPane() {
  const t = usePluginI18n(ID)
  const prefs = useValue($prefs)
  const suffixes = useMemo(() => parseSuffixes(prefs.ignoreSuffixes), [prefs.ignoreSuffixes])
  const pollMs = Math.min(POLL_MAX_S, Math.max(POLL_MIN_S, prefs.pollSeconds)) * 1000

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
  useEffect(() => scopedTimeout(() => setDebTerm(searchTerm), SEARCH_DEBOUNCE_MS), [searchTerm])
  useEffect(() => scopedTimeout(() => setDebSuffix(searchSuffix), SEARCH_DEBOUNCE_MS), [searchSuffix])
  const [fileList, setFileList] = useState([])
  const [fileBusy, setFileBusy] = useState(false)
  // Workspace of the focused chat (falls back to the window cwd) — what the pane acts on.
  const [workspace, setWorkspace] = useState('')
  const base = workspace || cwd

  const toast = useCallback((text, kind = 'info') => {
    host.notify({ kind, message: text })
  }, [])

  // resetPicked=false keeps the user's selection across the poll and after a commit;
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
      const depth = clampInt(prefs.scanDepth, DEPTH_MIN, DEPTH_MAX, PREF_DEFAULTS.scanDepth)
      const data = await api(`/repos?roots=${at}&cwd=${at}&depth=${depth}`)
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
  }, [prefs.scanDepth, refresh])

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
    const key = cacheKey(target, suffixes)
    const cached = fileCache.get(key)
    if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) { setFileList(cached.files); return }
    setFileBusy(true)
    try {
      const data = await api(`/files?repo=${enc(target)}&cwd=${enc(base || target)}`)
      // The ignored-suffix list is a preference now: Unity's .meta is the default, not a rule.
      const paths = (data.files || [])
        .filter((p) => !suffixes.some((suffix) => p.toLowerCase().endsWith(suffix)))
        .sort()
      cacheFiles(key, paths)
      setFileList(paths)
    } catch (err) {
      toast(t('toast.filesFailed', err.message), 'error')
      setFileList([])
    } finally {
      setFileBusy(false)
    }
  }, [base, suffixes, t, toast])

  // A suffix-list change misses every cached key (the suffix set is part of it), and
  // `loadFiles` above is re-created with it — the search-open effect below refetches.
  // Open the search (or switch repo) → fetch that repo's list once; the cache makes a
  // close/reopen instant.
  useEffect(() => {
    if (searchOpen && repo) void loadFiles(repo)
  }, [searchOpen, repo, loadFiles])

  // The agent commits in the same repo from its own tool calls; without a poll the pane
  // would keep showing a stale file list until the user hit 刷新.
  // Chain the poll (no overlapping status calls), back off while nothing changes, and pause
  // while the panel isn't on screen — a fixed setInterval fired a git status every few
  // seconds on a clean repo behind a hidden pane. Every timer here is ctx-scoped, so a
  // plugin reload can never leave a second poller running.
  useEffect(() => {
    if (!repo || busy) return undefined
    let cancelled = false
    let cancelTimer = null
    let lastSig = ''
    let delay = pollMs
    const schedule = (fn, ms) => {
      if (cancelTimer) cancelTimer()
      cancelTimer = scopedTimeout(fn, ms)
    }
    const tick = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule(tick, pollMs)
        return
      }
      // A mutation just refreshed this repo; a read inside that window answers the same
      // question, so wait out the current backoff instead of paying for it twice.
      if (Date.now() - refreshedAt.current < SELF_REFRESH_MS) {
        schedule(tick, delay)
        return
      }
      const st = await refresh(repo, base)
      // head + dirty count collapse thousands of paths to one comparison: an agent commit
      // flips head and resets the cadence, a no-op poll doubles the gap.
      const sig = st ? `${st.head || ''}|${(st.files || []).length}` : ''
      if (st && sig === lastSig) delay = Math.min(delay * 2, pollMs * 12)
      else { delay = pollMs; if (st) lastSig = sig }
      if (!cancelled) schedule(tick, delay)
    }
    void tick()
    return () => { cancelled = true; if (cancelTimer) cancelTimer() }
  }, [repo, base, busy, pollMs, refresh])

  // Event-driven refresh: the agent's own git_commit / git_push / git_pull / git_discard
  // tool calls push plugin.git-ops.<kind> to this session. Only the seq matters — an event
  // for another repo (or from another session, which ctx.onEvent already filtered) is
  // skipped, and a replayed frame from a reconnect never fires here.
  const change = useValue($gitChange)
  useEffect(() => {
    if (!change.seq || !repo) return
    if (change.repo && normPath(change.repo) !== normPath(repo)) return
    // The repo's file index is stale from here on: a commit added or renamed paths.
    invalidateFiles(repo)
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
    setDiff({ path, text: t('diff.loading'), truncated: false })
    try {
      // The porcelain code is already in hand, so the backend never asks git whether the
      // path is untracked — one diff process per click instead of five.
      const d = await api(`/diff?repo=${enc(repo)}&path=${enc(path)}&cwd=${enc(base || repo)}`
        + `&untracked=${untracked ? 'true' : 'false'}`)
      setDiff({ path: d.path, text: d.diff, truncated: d.truncated })
    } catch (err) {
      setDiff({ path, text: t('diff.failed', err.message), truncated: false })
    }
  }, [repo, base, t])

  // File-tree row click: VS Code only. The tree navigates the work tree (no diff to
  // show for a clean file), and /vscode takes every path that exists on disk — a tracked
  // file deleted from the work tree is the one failure, and its reason is reported.
  const openInCode = useCallback(async (path) => {
    if (!repo) return
    try {
      await api('/vscode', { repo, path, cwd: base || repo })
    } catch (err) {
      toast(t('toast.openFailed', err.message), 'error')
    }
  }, [repo, base, t, toast])

  // Row click: TortoiseGit's own window → the file in VS Code → the in-pane dialog.
  // Any /tgit failure falls through (not installed, a path it refuses, a transient
  // backend error), and a binary has no text diff at all, so the editor is the door
  // that always has the file itself to show.
  const openItem = useCallback(async (path, code) => {
    if (!repo) return
    for (const route of ['/tgit', '/vscode']) {
      try {
        await api(route, { repo, path, cwd: base || repo })
        return
      } catch (err) {
        console.warn(`[git-ops] ${route} unavailable:`, err.message)
      }
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
      if (notify) toast(t('toast.failed', err.message), 'error')
      else console.warn('[git-ops]', kind, err.message)
      return null
    } finally {
      setBusy('')
    }
  }, [t, toast])

  const generate = useCallback(async () => {
    if (!repo) return
    const data = await run('info', '/commit-info', { repo, paths: picked, cwd: base },
      (d) => t('toast.generated', d.header, d.truncated))
    if (data) setMessage(data.message)
  }, [repo, picked, base, run, t])

  // poke=false when a push follows immediately: the bar only ever shows the end state, so
  // the commit's probe would be thrown away a moment later by the push's.
  const doCommit = useCallback(async (poke = true) => {
    if (!repo) return null
    const committed = await run('commit', '/commit',
      { repo, paths: picked, message: message.trim() ? message : '', cwd: base },
      (d) => t('toast.committed', d.short, d.header), true, poke)
    if (!committed) return null
    setMessage('')
    await refresh(repo, base)
    return committed
  }, [repo, picked, message, base, run, t, refresh])

  const commitAndPush = useCallback(async () => {
    const committed = await doCommit(false)
    if (!committed) return
    const pushed = await run('push', '/push', { repo, cwd: base },
      (d) => (d.verified ? t('toast.pushed', d.short) : t('toast.pushUnverified', d.short, d.ahead_after)), true)
    await refresh(repo, base)
    // The push's poke never ran: the commit still needs its probe reported.
    if (!pushed) { pokeCodingBar(); toast(t('toast.committedNotPushed'), 'warning') }
  }, [doCommit, repo, base, run, t, refresh, toast])

  const doPull = useCallback(async () => {
    if (!repo) return
    const data = await run('pull', '/pull', { repo, cwd: base, submodules: true },
      (d) => (d.pulled ? t('toast.pulled', d.pulled, d.old, d.new) : t('toast.upToDate')))
    if (data) await refresh(repo, base)
  }, [repo, base, run, t, refresh])

  const doDiscard = useCallback(async () => {
    setConfirmDiscard(false)
    if (!repo || !picked.length) return
    const data = await run('discard', '/discard', { repo, paths: picked, cwd: base },
      (d) => t('toast.discarded', d.discarded.length), true)
    if (data) await refresh(repo, base)
  }, [repo, picked, base, run, t, refresh])

  const files = (status && status.files) || []
  const repoReady = Boolean(repo) && repos.some((r) => r.path === repo)
  const disabled = !repoReady || Boolean(busy)
  const allPicked = files.length > 0 && picked.length === files.length
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
            title: searchOpen ? t('search.collapse') : t('search.expand'),
            children: [
              jsx('span', { className: 'shrink-0', style: MUTED, children: searchOpen ? '▾' : '▸' }),
              jsx('span', { style: MUTED, children: t('search.toggle') }),
              fileBusy ? jsx('span', { style: MUTED, children: ' …' }) : null
            ]
          }),
          jsx(Button, {
            size: 'sm', variant: 'secondary',
            onClick: () => scan(base),
            disabled: Boolean(busy) || !base,
            children: busy === 'scan' ? t('button.scan') : t('button.refresh')
          })
        ]
      }),
      searchOpen
        ? jsxs('div', { className: 'shrink-0 flex flex-col gap-1 px-0.5 pb-1', children: [
            jsxs('div', { className: 'grid grid-cols-2 gap-1', children: [
              jsx('input', {
                value: searchTerm,
                onChange: (e) => setSearchTerm(e.target.value),
                placeholder: t('search.term'),
                className: 'rounded border px-1.5 py-0.5 text-xs',
                style: STROKE
              }),
              jsx('input', {
                value: searchSuffix,
                onChange: (e) => setSearchSuffix(e.target.value),
                placeholder: t('search.suffix'),
                className: 'rounded border px-1.5 py-0.5 text-xs',
                style: STROKE
              })
            ] }),
            jsxs('div', { className: 'flex items-center justify-between px-0.5', children: [
              jsx('span', { className: 'text-xs', style: MUTED,
                children: t('search.count', fileList.length, visibleFiles.length) }),
              jsx('button', {
                type: 'button',
                onClick: () => { setSearchTerm(''); setSearchSuffix('') },
                disabled: !searchTerm && !searchSuffix,
                className: 'rounded px-1 py-0.5 text-xs hover:bg-(--ui-row-hover-background) disabled:opacity-40',
                style: MUTED,
                title: t('search.clearTip'),
                children: t('search.clear')
              })
            ] }),
            jsx(SearchList, {
              all: fileList,
              files: visibleFiles,
              filterActive: Boolean(debTerm || debSuffix),
              onOpen: openInCode
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
          : jsx('div', { className: 'px-1.5 py-1 text-xs', style: MUTED, children: t('git.noRepo') })
      }),
      files.length
        ? jsx(FileList, { files, picked, onPick, onOpen: openItem })
        : jsx('div', {
            className: 'min-h-0 flex-1 overflow-auto rounded border p-1 text-xs',
            style: { ...STROKE, ...MUTED },
            children: jsx('div', { className: 'p-1', children: repoReady ? t('git.clean') : t('git.noGit') })
          }),
      jsx(Textarea, {
        value: message,
        rows: 3,
        placeholder: t('message.placeholder'),
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
          children: busy === 'info' ? t('button.generating') : t('button.generate') }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: () => { void doCommit() },
          children: busy === 'commit' ? t('button.committing') : t('button.commit') }),
        jsx(Button, { size: 'sm', className: 'w-full',
          disabled: disabled || !picked.length, onClick: commitAndPush,
          children: busy === 'push' ? t('button.pushing') : t('button.commitPush') })
      ] }),
      jsxs('div', { className: 'grid shrink-0 grid-cols-3 gap-1', children: [
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || allPicked || !files.length,
          onClick: () => setPicked(files.map((f) => f.path)),
          children: t('button.all') }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: () => setPicked([]),
          children: t('button.none') }),
        jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full',
          disabled: disabled || !picked.length, onClick: () => setConfirmDiscard(true),
          children: busy === 'discard' ? t('button.discarding') : t('button.discard') })
      ] }),
      jsx(Button, { size: 'sm', variant: 'secondary', className: 'w-full shrink-0',
        disabled, onClick: doPull,
        children: busy === 'pull' ? t('button.pulling') : t('button.pull') }),
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
                ? jsx('div', { className: 'text-xs', style: MUTED, children: t('diff.truncated') })
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
                children: jsx(DialogTitle, { className: 'text-sm', children: t('discard.title') })
              }),
              jsx('div', { className: 'text-xs', style: MUTED,
                children: t('discard.body', picked.length) }),
              jsxs('div', { className: 'flex justify-end gap-2', children: [
                jsx(Button, { size: 'sm', variant: 'secondary', onClick: () => setConfirmDiscard(false),
                  children: t('button.cancel') }),
                jsx(Button, { size: 'sm', onClick: doDiscard, children: t('button.confirmDiscard') })
              ] })
            ]
          })
        })
      })
    ]
  })
}

// Settings ▸ Plugins ▸ Git Ops. Local draft, saved on demand — a keystroke must not rewrite
// the stored record (a half-typed suffix would drop every file from search).
function SettingsPage() {
  const t = usePluginI18n(ID)
  const prefs = useValue($prefs)
  const [draft, setDraft] = useState(prefs)
  const set = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))
  return jsxs('div', {
    className: 'flex flex-col gap-3 text-sm',
    children: [
      jsx('div', { className: 'text-xs', style: MUTED, children: t('settings.intro') }),
      jsxs('label', { className: 'flex flex-col gap-1', children: [
        jsx('span', { className: 'text-xs font-medium', children: t('settings.ignoreLabel') }),
        jsx(Input, { value: draft.ignoreSuffixes, onChange: set('ignoreSuffixes') }),
        jsx('span', { className: 'text-xs', style: MUTED, children: t('settings.ignoreHint') })
      ] }),
      jsxs('label', { className: 'flex flex-col gap-1', children: [
        jsx('span', { className: 'text-xs font-medium', children: t('settings.pollLabel') }),
        jsx(Input, {
          type: 'number', min: POLL_MIN_S, max: POLL_MAX_S,
          value: draft.pollSeconds, onChange: set('pollSeconds')
        }),
        jsx('span', { className: 'text-xs', style: MUTED, children: t('settings.pollHint') })
      ] }),
      jsxs('label', { className: 'flex flex-col gap-1', children: [
        jsx('span', { className: 'text-xs font-medium', children: t('settings.depthLabel') }),
        jsx(Input, {
          type: 'number', min: DEPTH_MIN, max: DEPTH_MAX,
          value: draft.scanDepth, onChange: set('scanDepth')
        }),
        jsx('span', { className: 'text-xs', style: MUTED, children: t('settings.depthHint') })
      ] }),
      jsxs('div', { className: 'flex gap-2 pt-1', children: [
        jsx(Button, {
          size: 'sm',
          onClick: () => {
            const clean = savePrefs(draft)
            setDraft(clean)
            // Every cached listing was filtered by the old suffix set.
            fileCache.clear()
            host.notify({ kind: 'success', message: t('toast.prefsSaved') })
          },
          children: t('button.save')
        }),
        jsx(Button, {
          size: 'sm', variant: 'secondary',
          onClick: () => setDraft(savePrefs(PREF_DEFAULTS)),
          children: t('button.reset')
        })
      ] })
    ]
  })
}

export default {
  id: ID,
  name: 'Git Ops',
  register(ctx) {

    rest = ctx.rest
    ctxRef = ctx
    store = ctx.storage

    // Preferences are read once the storage door exists; before register they were defaults.
    $prefs.set(readPrefs())

    // The plugin's own strings, resolved against the app's active locale. Registered here
    // so every render (including the settings page) can translate immediately.
    ctx.i18n.register(MESSAGES)
    ctx.registerSettingsPage({
      id: 'prefs',
      title: 'Git Ops',
      icon: 'git-branch',
      order: 60,
      render: () => jsx(SettingsPage, {})
    })
    // Drop the ctx reference when THIS load is the current one: on a reload the new
    // instance registers before the old one disposes, and an unguarded null here would
    // strip the live plugin of its scoped timers.
    ctx.onDispose(() => { if (ctxRef === ctx) ctxRef = null })

    // ctx.onEvent (not host.onEvent): the loader disposes these on reload/disable, so a
    // module swap cannot stack duplicate listeners. Replayed frames are old turns —
    // refreshing from them would undo nothing but wastes a status call, so drop them.
    const on = typeof ctx.onEvent === 'function' ? ctx.onEvent.bind(ctx) : host.onEvent.bind(host)
    for (const kind of GIT_EVENTS) {
      on(`plugin.${ID}.${kind}`, (event) => {
        if (!event || event.replayed) return
        const payload = event.payload || {}
        if (payload.repo) invalidateFiles(payload.repo)
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
      // 'Git' is a product name in both bundles, so the registration-time title stays literal.
      title: 'Git',
      order: 60,
      data: { placement: 'right', width: '380px' },
      render: () => jsx(GitPane, {})
    })
  }
}
