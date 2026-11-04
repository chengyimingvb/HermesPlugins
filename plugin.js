/**
 * Turn indicator — a plugin-only replacement for the tail status row.
 *
 * Why: the built-in row (`[data-slot=aui_response-loading]` /
 * `[data-slot=aui_turn-activity]`) hides itself for TURN_QUIET_S after any
 * progress and again while a tail tool call narrates its own timer, so the
 * pulse flickers off in the middle of a turn. This keeps ONE indicator mounted
 * from the moment the focused chat starts working until it stops, with a label
 * and a live timer, without touching core code.
 *
 * Placement: `composer.underside` — the chrome-free strip directly below the
 * composer, i.e. at the bottom of the conversation. The contribution is
 * registered ONLY while the turn is working (disposer on idle), so the strip
 * is empty:hidden and takes no space when the chat is idle.
 *
 * Data: host.state atoms + their events. `busy` is the focused chat's own flag
 * and can lag a tab switch, so the per-session map covers a chat that is still
 * mid-turn after focus moved away.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, styles are inline (Tailwind
 * classes are compiled from core source and would not exist for a plugin).
 * Only @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { atom, host, useValue } from '@hermes/plugin-sdk'

const ID = 'turn-indicator'

const isChinese = () => {
  const fromDom = typeof document === 'undefined' ? '' : document.documentElement.lang || ''
  const fromNavigator = typeof navigator === 'undefined' ? '' : navigator.language || ''
  return (fromDom || fromNavigator).toLowerCase().startsWith('zh')
}

const zh = (zhText, enText) => (isChinese() ? zhText : enText)

// Resolved per render, not at module scope: the app can switch locale live,
// and a module-level DOM read breaks any non-browser loader (the harness).
const label = () => zh('思考中', 'Thinking')

/**
 * What the turn is doing RIGHT NOW, derived from gateway events, so the
 * indicator narrates the same thing the transcript would.
 *
 * '' means "no specific activity" and the component falls back to 思考中.
 * Writes are deduped by hand: nanostores notifies on a same-value set, and
 * `message.delta` arrives ~30×/s, so an unguarded set would re-render the
 * strip for every token.
 */
const $activity = atom('')

const setActivity = next => {
  if ($activity.get() !== next) {
    $activity.set(next)
  }
}

/** Last path segment of the tool's target, for "Editing plugin.js". */
const baseName = path => {
  if (typeof path !== 'string' || !path) {
    return ''
  }

  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/** Verb per tool family. Unknown tools keep their raw name rather than vanish. */
const describeTool = payload => {
  const name = String(payload?.name || '')
  const args = payload?.args || {}
  const file = baseName(args.path || args.file_path || args.filename || payload?.preview || '')

  switch (name) {
    case 'patch':
    case 'edit_file':
    case 'write_file':
    case 'multi_edit':
      return file ? zh(`编辑 ${file}`, `Editing ${file}`) : zh('编辑文件', 'Editing files')
    case 'read_file':
    case 'read_multiple_files':
      return file ? zh(`读取 ${file}`, `Reading ${file}`) : zh('读取文件', 'Reading files')
    case 'terminal':
      return zh('执行命令', 'Running a command')
    case 'search_files':
    case 'grep':
    case 'glob':
      return zh('搜索代码', 'Searching the code')
    case 'web_search':
    case 'web_extract':
      return zh('查阅资料', 'Looking things up')
    case 'todo':
    case 'todo_list':
      return zh('整理待办', 'Updating the todo list')
    case 'delegate_task':
      return zh('分派子任务', 'Delegating work')
    case 'browser_exec':
      return zh('操作浏览器', 'Driving the browser')
    default:
      return name ? zh(`调用 ${name}`, `Running ${name}`) : ''
  }
}

const boxStyle = {
  display: 'inline-block',
  width: '11px',
  height: '11px',
  borderRadius: '2px',
  // Same texture as the core `.dither` pulse, so it reads as the same widget.
  background:
    'repeating-conic-gradient(currentColor 0% 25%, transparent 0% 50%) 0 0 / 0.125rem 0.125rem',
  color: 'var(--ui-accent)',
  flex: '0 0 auto'
}

function turnSeconds(since) {
  if (!since) {
    return 0
  }

  return Math.max(0, Math.floor((Date.now() - since) / 1000))
}

function Indicator() {
  const busy = useValue(host.state.busy)
  const busyBySession = useValue(host.state.busyBySession)
  const focusedSessionId = useValue(host.state.focusedSessionId)
  const activity = useValue($activity)
  const working = Boolean(busy || (focusedSessionId && (busyBySession || {})[focusedSessionId]))

  const boxRef = useRef(null)
  const [since, setSince] = useState(() => (working ? Date.now() : null))
  const [tick, setTick] = useState(0)

  // One clock per turn: starts when the chat starts working, resets when it
  // stops, so the next turn counts from zero again.
  useEffect(() => {
    if (working) {
      setSince(previous => previous ?? Date.now())
      return
    }

    setSince(null)
  }, [working])

  useEffect(() => {
    if (!working) {
      return
    }

    const id = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(id)
  }, [working])

  // Continuous pulse. WAAPI rather than a CSS keyframe: a plugin has no
  // stylesheet of its own, and the app pauses its own CSS animations when the
  // window is hidden while this cancellation is explicit.
  useEffect(() => {
    const el = boxRef.current

    if (!el || typeof el.animate !== 'function') {
      return
    }

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    const animation = el.animate(
      [
        { opacity: 0.28, boxShadow: '0 0 0 0 var(--ui-accent)' },
        { opacity: 1, boxShadow: '0 0 6px 1px var(--ui-accent)' },
        { opacity: 0.28, boxShadow: '0 0 0 0 var(--ui-accent)' }
      ],
      { duration: 1500, iterations: Infinity, easing: 'ease-in-out' }
    )

    return () => animation.cancel()
  }, [working])

  // `tick` exists to re-render once a second; the value itself is recomputed
  // from the clock so a paused/throttled interval cannot drift the label.
  void tick
  const elapsed = turnSeconds(since)

  // Idle still renders: a floating pane's card chrome is owned by the host and
  // stays on screen, so returning null would leave an empty card. An explicit
  // "idle" line is the honest state for that surface.
  const text = working ? activity || label() : zh('空闲', 'Idle')

  return jsx('div', {
    'aria-live': 'polite',
    role: 'status',
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      gap: '6px',
      padding: '2px 4px',
      color: 'var(--ui-text-secondary)',
      fontSize: '11px',
      lineHeight: '1.55',
      fontVariantNumeric: 'tabular-nums',
      userSelect: 'none',
      pointerEvents: 'none'
    },
    children: [
      jsx('span', { key: 'box', ref: boxRef, style: boxStyle }),
      jsx('span', { key: 'label', children: text }),
      working ? jsx('span', { key: 'timer', style: { opacity: 0.7 }, children: `${elapsed}s` }) : null
    ]
  })
}

export default {
  id: ID,
  name: 'Turn indicator',
  register(ctx) {
    // Hide the transcript's "N files changed" card that closes out a turn
    // (`[data-slot=aui_changed-files]`, changed-files-card.tsx). It has no
    // config gate in core, so the only user-level way to drop it is a rule.
    // Idempotent by id: a hot reload re-runs register() without duplicating it.
    if (typeof document !== 'undefined') {
      // Ids are unique per window, but the CONTENT must be rewritten on every
      // register(): a hot reload re-runs this with a new rule set, and a
      // cached element would keep serving the old text.
      let style = document.getElementById('turn-indicator-hide-changes')

      if (!style) {
        style = document.createElement('style')
        style.id = 'turn-indicator-hide-changes'
        document.head.appendChild(style)
      }

      // The whole desktop tool feed is hidden from here, not from config:
      // `display.tool_progress` lives in config.yaml and applies to every
      // surface (CLI + messaging included), so the plugin owns the desktop half.
      // `tool-block` is every tool row (reads, searches, commands, edits) AND
      // the row's inline `tool-progress` span (fallback.tsx:362) — one rule
      // covers both, since the progress text lives inside the row's header.
      // Approval cards are NOT touched — the user has to answer those.
      style.textContent = '[data-slot="tool-block"] { display: none !important; }'

      // The <style> is not a registered contribution, so disabling the plugin
      // would leave it in the document until the window reloads. Tie it to the
      // plugin's own lifetime instead: dispose on disable/reload, and the next
      // register() puts it back.
      if (typeof ctx.onDispose === 'function') {
        ctx.onDispose(() => style.remove())
      }
    }

    // A floating pane: the host draws its card (header + drag + persisted
    // position), so the component must ALWAYS render something — an idle line
    // instead of null, or the card would sit empty.
    ctx.register({
      id: 'turn-indicator-strip',
      // SDK does not export PANES_AREA at runtime (importing it throws
      // "PANES_AREA is not defined"), so the literal is the supported form.
      area: 'panes',
      title: '运行状态',
      data: { placement: 'floating', anchor: 'bottom-right', width: 210, height: 62 },
      render: () => jsx(Indicator, {})
    })

    // ── Live label ───────────────────────────────────────────────────────────
    // Gateway events for the FOCUSED chat only: the stream is per-gateway, so a
    // tool row from another tab would relabel this one. `replayed` frames are
    // old turns re-sent on reconnect — never live activity.
    const isMine = event => {
      const eventSession = event?.session_id
      const focused = host.state.focusedSessionId.get()
      return !focused || !eventSession || focused === eventSession
    }

    ctx.onEvent('tool.start', event => {
      if (isMine(event) && !event.replayed) {
        setActivity(describeTool(event.payload))
      }
    })

    ctx.onEvent('tool.generating', event => {
      if (isMine(event) && !event.replayed) {
        setActivity(zh('准备工具参数', 'Preparing a tool call'))
      }
    })

    ctx.onEvent('tool.complete', event => {
      if (isMine(event)) {
        setActivity('')
      }
    })

    ctx.onEvent('message.delta', event => {
      if (isMine(event) && !event.replayed) {
        setActivity(zh('生成回复', 'Writing the reply'))
      }
    })

    ctx.onEvent('thinking.delta', event => {
      if (isMine(event) && !event.replayed) {
        setActivity('')
      }
    })

    ctx.onEvent('status.update', event => {
      if (isMine(event) && event.payload?.kind === 'compacting') {
        setActivity(zh('整理上下文', 'Summarizing the thread'))
      }
    })

    ctx.onEvent('message.complete', () => setActivity(''))

    // A new turn starts from a clean slate: no label carried over from the last
    // turn's last tool call.
    const unsubscribeBusy = host.state.busy.subscribe(isBusy => {
      if (isBusy) {
        setActivity('')
      }
    })

    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(unsubscribeBusy)
    }
  }
}
