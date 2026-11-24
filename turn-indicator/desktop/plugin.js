/**
 * Turn indicator — one plugin for what the transcript chrome was missing: the
 * composer status row (below), the `::turn{}` inline twin, hiding every tool row,
 * and the breathing glow on the bubble of the turn in progress.
 *
 * Why: the built-in row (`[data-slot=aui_response-loading]` /
 * `[data-slot=aui_turn-activity]`) hides itself for TURN_QUIET_S after any
 * progress and again while a tail tool call narrates its own timer, so the
 * pulse flickers off in the middle of a turn. This keeps ONE indicator mounted
 * from the moment the focused chat starts working until it stops, with a label
 * and a live timer, without touching core code.
 *
 * Placement: `composer.top` — the full-width line inside the composer card,
 * directly above the textarea; it renders null while the chat is idle, so the
 * slot's `empty:hidden` wrapper leaves no gap. A second contribution renders
 * the `::turn{}` twin inline in the transcript.
 *
 * Data: host.state atoms + their events. `busy` is the FOCUSED chat's own flag
 * and drops across every gap inside a turn, so the latch is held by the focused
 * session's per-session busy flag plus its own in-flight tool count. Other
 * sessions are counted (their calls must be closed out) but never light this
 * pane: `composer.top` is one chat's strip, not a global activity light.
 *
 * Cost: one timer per `settleMs` while a turn is open, plus a debounced repaint
 * when the transcript mutates. Nothing is polled.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, styles are inline (Tailwind
 * classes are compiled from core source and would not exist for a plugin).
 * Only @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { atom, host, useValue, Button, Input } from '@hermes/plugin-sdk'

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
 */
const $activity = atom('')

/**
 * Whether the row is mounted. NOT the same thing as the gateway's `busy`: that
 * flag drops between two tool calls, while a long tool runs, and across a
 * message boundary inside one turn — and every drop unmounted the row mid-turn.
 * The turn is held open by its own live signals (`busy`, a tool call in flight,
 * any streaming delta) and closed only once nothing has been live for
 * SETTLE_MS, so the row is continuous for the whole turn.
 */
const $turn = atom(false)

// ── preferences (ctx.storage) ────────────────────────────────────────────
// Everything a user could disagree with is a preference, edited in
// Settings ▸ Plugins ▸ Turn indicator and persisted per profile. Read through a
// COERCING reader: a hand-edited or half-written record must not poison the row.

const PREF_KEY = 'prefs'
const PREF_DEFAULTS = {
  composerRow: true,
  toolRows: true,
  // Core's own row under the bubble is the SECOND narrator of a turn. With the
  // tool rows hidden the composer line above already says what is running, so
  // the row is redundant chrome; the switch exists because removing it leaves
  // the bubble side empty for the idle windows core suppresses its pulse in.
  hideActivityRow: true,
  bubbleGlow: true,
  glowMs: 1200,
  glowStrength: 55,
  settleMs: 3000,
  inlineDirective: true
}
const GLOW_MS_MIN = 400
const GLOW_MS_MAX = 4000
const STRENGTH_MIN = 5
const STRENGTH_MAX = 100
const SETTLE_MIN_MS = 500
const SETTLE_MAX_MS = 20000

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value))

  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

let store = null

function readPrefs() {
  let raw = {}

  try {
    raw = (store && store.get(PREF_KEY, {})) || {}
  } catch (error) {
    console.warn('[turn-indicator] prefs', error instanceof Error ? error.message : error)
  }

  return {
    composerRow: asBool(raw.composerRow, PREF_DEFAULTS.composerRow),
    toolRows: asBool(raw.toolRows, PREF_DEFAULTS.toolRows),
    hideActivityRow: asBool(raw.hideActivityRow, PREF_DEFAULTS.hideActivityRow),
    bubbleGlow: asBool(raw.bubbleGlow, PREF_DEFAULTS.bubbleGlow),
    glowMs: clampInt(raw.glowMs, GLOW_MS_MIN, GLOW_MS_MAX, PREF_DEFAULTS.glowMs),
    glowStrength: clampInt(raw.glowStrength, STRENGTH_MIN, STRENGTH_MAX, PREF_DEFAULTS.glowStrength),
    settleMs: clampInt(raw.settleMs, SETTLE_MIN_MS, SETTLE_MAX_MS, PREF_DEFAULTS.settleMs),
    inlineDirective: asBool(raw.inlineDirective, PREF_DEFAULTS.inlineDirective)
  }
}

/** Persist, clamped on the way IN as well as on the way out. */
function savePrefs(next) {
  const clean = readPrefsFrom(next)

  try {
    if (store) {
      store.set(PREF_KEY, clean)
    }
  } catch (error) {
    console.warn('[turn-indicator] prefs save', error instanceof Error ? error.message : error)
  }

  // The atom is what the running instance reads (CSS string, latch window, the
  // inline capsule's render), so a saved record has to land in it too — the store
  // write alone changes nothing until the next register().
  $prefs.set(clean)

  return clean
}

/** `readPrefs`' coercion over an in-memory draft (the settings page's shape). */
function readPrefsFrom(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}

  return {
    composerRow: asBool(source.composerRow, PREF_DEFAULTS.composerRow),
    toolRows: asBool(source.toolRows, PREF_DEFAULTS.toolRows),
    hideActivityRow: asBool(source.hideActivityRow, PREF_DEFAULTS.hideActivityRow),
    bubbleGlow: asBool(source.bubbleGlow, PREF_DEFAULTS.bubbleGlow),
    glowMs: clampInt(source.glowMs, GLOW_MS_MIN, GLOW_MS_MAX, PREF_DEFAULTS.glowMs),
    glowStrength: clampInt(source.glowStrength, STRENGTH_MIN, STRENGTH_MAX, PREF_DEFAULTS.glowStrength),
    settleMs: clampInt(source.settleMs, SETTLE_MIN_MS, SETTLE_MAX_MS, PREF_DEFAULTS.settleMs),
    inlineDirective: asBool(source.inlineDirective, PREF_DEFAULTS.inlineDirective)
  }
}

const $prefs = atom(PREF_DEFAULTS)

const prefs = () => $prefs.get()

/** Debounce for the event-driven repaint of the glow / pulse tags. */
const REPAINT_MS = 200

/**
 * A reload disposes the previous incarnation BEFORE registering the new one
 * (`runtime-loader`: unload, then activate) and re-evaluates the module from a
 * fresh blob URL, so every module-scope binding here (`$turn`, `$activity`,
 * `$prefs`) belongs to exactly one loaded revision and no dispose can reach
 * across into its replacement. That is why neither the stylesheet element nor
 * the latch needs an owner guard.
 */

/** Attribute on the turn pair whose bubbles breathe (`turn-glow`). */
const GLOW_ATTR = 'turn-glow'

/**
 * Attribute on the core activity row of the turn in progress (`ti-live`).
 *
 * Core's own row (`[data-slot=aui_turn-activity]`) drops to `sr-only` — and
 * unmounts its pulse entirely (`{active && ...}`) — whenever a tool call is
 * narrating the wait or the turn has been quiet for under `TURN_QUIET_S`. That
 * is the right call while the tool rows are on screen, but this plugin hides
 * every tool row, so those two gates were the whole turn with nothing to look
 * at. The tag lets a stylesheet put the pulse back for exactly those windows.
 *
 * Dormant while `hideActivityRow` is on: the row is display:none then, so there
 * is nothing to repair and nothing is tagged (see `paintActivity`).
 */
const ACT_ATTR = 'ti-live'

/**
 * Both jobs in one stylesheet — a plugin has no stylesheet of its own:
 *   1. every tool row in the transcript is hidden, live and settled alike, since
 *      the composer line above already narrates what is running;
 *   2. the bubble of the turn in progress breathes — the user's own bubble, which
 *      is the only element with a bubble shape (the assistant side is full-width
 *      prose, so ringing it would mean inventing a rounded box around the whole
 *      reading column, i.e. painting on the chrome around the bubble).
 * Either job can be turned off in settings; the built string is what the style
 * element carries, so a change is one `textContent` write.
 *
 * `--ui-accent` keeps it on-theme; reduced motion needs no guard (core's blanket
 * `!important` kill takes every animation out for a user who asks for it).
 *
 * The style ELEMENT id stays `turn-indicator-hide-changes` even though it now
 * carries two jobs: it is the id an already-installed revision's element was
 * created with, and renaming it would leave that element in the document
 * serving the old rules until the window reloads.
 */
const buildCss = p => {
  let css = ''

  if (p.toolRows) {
    css += '[data-slot="tool-block"] { display: none !important; }\n'

    // With the rows gone, core's own pulse is the only thing left on the bubble
    // side — and core suppresses it exactly while a tool call runs or the turn
    // has been quiet for under 2s, i.e. most of a turn. Restore that row for
    // those windows only: `data-state="active"` keeps core's real node (with its
    // timer text), `idle` gets the same dither square this plugin draws above
    // the composer. `sr-only`'s declarations are overridden one by one because
    // core ships it as a utility class — and `clip-path` is the one that matters:
    // Tailwind v4's `sr-only` is `clip-path: inset(50%)` (it ships no `clip` at
    // all), so resetting `clip` alone left the restored row laid out but painted
    // empty.
    //
    // Skipped entirely when the row is hidden (`hideActivityRow`): repairing a
    // node nothing can see is dead weight in the stylesheet.
    if (!p.hideActivityRow) {
      css +=
        `[data-${ACT_ATTR}][data-slot="aui_turn-activity"][data-state="idle"] {\n` +
        '  position: static;\n' +
        '  width: auto;\n' +
        '  height: auto;\n' +
        '  margin: 0;\n' +
        '  overflow: visible;\n' +
        '  clip: auto;\n' +
        '  clip-path: none;\n' +
        '  border-width: 0;\n' +
        '}\n' +
        `[data-${ACT_ATTR}][data-slot="aui_turn-activity"][data-state="idle"]::before {\n` +
        "  content: '';\n" +
        '  display: inline-block;\n' +
        '  flex: 0 0 auto;\n' +
        '  width: 12px;\n' +
        '  height: 12px;\n' +
        '  border-radius: 2px;\n' +
        '  opacity: 0.8;\n' +
        '  background: repeating-conic-gradient(currentColor 0% 25%, transparent 0% 50%) 0 0 / 0.125rem 0.125rem;\n' +
        '}\n'
    }
  }

  // Core's whole activity row under the bubble — pulse, hint and the ticking
  // seconds. It is the DUPLICATE narrator of the turn: the composer line above
  // already says what is running, and core hides this row for most of a turn
  // anyway (it yields to a narrating tool call and to any gap shorter than
  // TURN_QUIET_S), so what is left is a square that appears and disappears.
  // Approval cards and the changed-files card are different slots and stay.
  //
  // `display: none`, not a visually-hidden clip: the row is a polite live
  // region whose timer re-renders once a second, so leaving it for assistive
  // tech would re-announce the turn every second. Nothing is lost — the
  // composer line is the same live region, with a label and the same seconds.
  if (p.hideActivityRow) {
    css += '[data-slot="aui_turn-activity"] { display: none !important; }\n'
  }

  if (p.bubbleGlow) {
    const soft = Math.max(2, Math.round(p.glowStrength / 3))

    css +=
      '@keyframes turn-glow-breathe {\n' +
      `  from { box-shadow: 0 0 4px 0 color-mix(in srgb, var(--ui-accent) ${soft}%, transparent); }\n` +
      `  to { box-shadow: 0 0 10px 2px color-mix(in srgb, var(--ui-accent) ${p.glowStrength}%, transparent); }\n` +
      '}\n' +
      `[data-${GLOW_ATTR}] .composer-human-message {\n` +
      // `alternate` is what makes the loop seamless: the two ends ARE the two
      // extremes, so the reversal continues the curve instead of jumping back to
      // a third keyframe's value. One direction is half a cycle.
      `  animation: turn-glow-breathe ${p.glowMs}ms ease-in-out infinite alternate;\n` +
      '}\n'
  }

  return css
}

/** The SDK re-exports nanostores' own `atom`, whose `set` skips an identical
 *  value — so `message.delta` (~30/s) costs one string compare, not a render. */
const setActivity = next => $activity.set(next)

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
  const settings = useValue($prefs)
  const working = useValue($turn)
  const activity = useValue($activity)

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

  // The square is deliberately STEADY: it used to breathe (opacity 0.28→1), and a
  // square fading to 28% every 1.5s reads as the indicator blinking on and off.
  // "Alive" is carried by the label and the ticking seconds instead.

  // `tick` exists to re-render once a second; the value itself is recomputed
  // from the clock so a paused/throttled interval cannot drift the label.
  void tick
  const elapsed = turnSeconds(since)

  // Inline slot beside the "+" menu: idle renders nothing (the slot is a bare
  // inline strip, not a host card that would be left empty). The same goes for a
  // user who turned the row off — the registration stays (a hot reload keeps it),
  // only the render is gone.
  if (!settings.composerRow || !working) {
    return null
  }

  const text = activity || label()

  return jsx('div', {
    'aria-live': 'polite',
    'data-turn-indicator': '',
    role: 'status',
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      gap: '6px',
      // A full-width line inside the composer card: no pill chrome, it reads as
      // part of the input box.
      padding: '1px 2px 0',
      color: 'var(--ui-text-secondary)',
      fontSize: '11px',
      lineHeight: '1.5',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      userSelect: 'none',
      pointerEvents: 'none'
    },
    children: [
      jsx('span', { key: 'box', style: boxStyle }),
      jsx('span', { key: 'label', children: text }),
      // `aria-hidden`: the seconds tick once a second inside a polite live
      // region, so a screen reader would announce the whole row every second.
      jsx('span', { 'aria-hidden': true, key: 'timer', style: { opacity: 0.7 }, children: `${elapsed}s` })
    ]
  })
}

/**
 * `::turn{}` — the in-transcript twin of the composer line.
 *
 * Rendered ONLY while the message is still streaming (the host passes
 * `streaming`), so the line is gone the moment the turn settles. Nothing is
 * shown when settled: the directive text is consumed by the claim, not
 * reprinted, so an idle transcript simply loses that paragraph.
 *
 * `text="…"` overrides the label; it is untrusted model output, so it is
 * trimmed and capped.
 */
function DirectiveLine({ attrs }) {
  const activity = useValue($activity)
  const settings = useValue($prefs)
  const [since] = useState(() => Date.now())
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Steady square, same as the composer line: no pulse, nothing to blink.
  const override = typeof attrs?.text === 'string' ? attrs.text.trim().slice(0, 60) : ''
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000))

  if (!settings.inlineDirective) {
    return null
  }

  return jsx('span', {
    'data-turn-indicator-inline': '',
    role: 'status',
    style: {
      display: 'inline-flex',
      width: 'fit-content',
      alignItems: 'center',
      gap: '6px',
      margin: '2px 0',
      padding: '2px 9px',
      borderRadius: '999px',
      border: '1px solid var(--ui-stroke-tertiary)',
      background: 'var(--ui-bg-secondary)',
      color: 'var(--ui-text-secondary)',
      fontSize: '11px',
      lineHeight: '1.5',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      userSelect: 'none'
    },
    children: [
      jsx('span', { key: 'box', style: boxStyle }),
      jsx('span', { key: 'label', children: override || activity || label() }),
      jsx('span', { 'aria-hidden': true, key: 'timer', style: { opacity: 0.7 }, children: `${seconds}s` })
    ]
  })
}

// ── Settings ▸ Plugins ▸ Turn indicator ──────────────────────────────────
// A LOCAL draft, written on Save: per-keystroke writes would push half-typed
// numbers into live rules (and a cleared field would read as NaN → clamped).
const HINT_STYLE = { fontSize: 11, color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }
const FIELD_LABEL_STYLE = { fontSize: 12, fontWeight: 500 }
const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: 4 }
const CHECK_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8 }
const CHECKBOX_STYLE = { width: 14, height: 14, flex: '0 0 auto' }

function SettingsPage() {
  const settings = useValue($prefs)
  const [draft, setDraft] = useState(settings)
  const set = key => event => setDraft(previous => ({ ...previous, [key]: event.target.value }))
  const toggle = key => event => setDraft(previous => ({ ...previous, [key]: event.target.checked }))
  const checkbox = (key, text) =>
    jsxs('label', {
      style: CHECK_ROW_STYLE,
      children: [
        jsx('input', {
          type: 'checkbox',
          checked: Boolean(draft[key]),
          onChange: toggle(key),
          style: CHECKBOX_STYLE
        }),
        jsx('span', { style: FIELD_LABEL_STYLE, children: text })
      ]
    })
  const number = (key, text, min, max) =>
    jsxs('label', {
      style: FIELD_STYLE,
      children: [
        jsx('span', { style: FIELD_LABEL_STYLE, children: text }),
        jsx(Input, { type: 'number', min, max, value: draft[key], onChange: set(key) }),
        jsx('span', {
          style: HINT_STYLE,
          children: zh(`允许范围 ${min}–${max}，超出会被夹到边界`, `Range ${min}–${max}; out-of-range values are clamped`)
        })
      ]
    })

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 },
    children: [
      jsx('div', {
        style: HINT_STYLE,
        children: zh(
          '按配置（profile）保存，保存后立即生效；恢复默认可随时退回。',
          'Saved per profile and applied immediately; Reset restores the defaults.'
        )
      }),
      checkbox('composerRow', zh('显示输入框上方的状态行', 'Show the status row above the composer')),
      checkbox('toolRows', zh('隐藏对话里的工具行', 'Hide the transcript tool rows')),
      checkbox(
        'hideActivityRow',
        zh('隐藏气泡下方的状态行', 'Hide the activity row under the bubble')
      ),
      checkbox('bubbleGlow', zh('本轮气泡的边缘呼吸光', 'Breathing edge on the current bubble')),
      number(
        'glowMs',
        zh('呼吸单程时长（ms）', 'Glow half-cycle (ms)'),
        GLOW_MS_MIN,
        GLOW_MS_MAX
      ),
      number(
        'glowStrength',
        zh('呼吸强度（%）', 'Glow strength (%)'),
        STRENGTH_MIN,
        STRENGTH_MAX
      ),
      number(
        'settleMs',
        zh('回合结束后收起延迟（ms）', 'Hold the row after the turn ends (ms)'),
        SETTLE_MIN_MS,
        SETTLE_MAX_MS
      ),
      checkbox('inlineDirective', zh('`::turn{}` 内联胶囊', 'The `::turn{}` inline capsule')),
      jsxs('div', {
        style: { display: 'flex', gap: 8, paddingTop: 4 },
        children: [
          jsx(Button, {
            size: 'sm',
            onClick: () => {
              setDraft(savePrefs(draft))
              host.notify({ kind: 'success', message: zh('已保存', 'Saved') })
            },
            children: zh('保存', 'Save')
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: () => setDraft(savePrefs(PREF_DEFAULTS)),
            children: zh('恢复默认', 'Reset')
          })
        ]
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Turn indicator',
  register(ctx) {
    // Preferences are read as soon as the storage door exists; before that the
    // module carried the defaults.
    store = ctx.storage
    $prefs.set(readPrefs())

    // Hides every tool row in the transcript. The "N files changed" card that
    // closes out a turn (`[data-slot=aui_changed-files]`) is deliberately left
    // alone.
    let styleEl = null
    let unsubscribePrefs = null

    if (typeof document !== 'undefined') {
      // Ids are unique per window, and the CONTENT is rewritten on every
      // register(): a reload re-evaluates the module with a new rule set, and a
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
      // No exception for the live turn: the composer line already narrates
      // what is running, so the rows are noise in settled history and mid-turn
      // alike. Approval cards are NOT touched — the user has to answer those.
      // The bubble glow rides in the same stylesheet — see buildCss above.
      style.textContent = buildCss(prefs())
      styleEl = style

      // The <style> is not a registered contribution, so disabling the plugin
      // would leave it in the document until the window reloads. Tie it to the
      // plugin's own lifetime instead: dispose on disable/reload, and the next
      // register() creates it again (a reload disposes this incarnation before
      // the next one runs, so nothing here can strip its replacement's rules).
      if (typeof ctx.onDispose === 'function') {
        ctx.onDispose(() => {
          if (unsubscribePrefs) {
            unsubscribePrefs()
          }

          style.remove()
        })
      }

    }


    // Banner strip above the textarea, inside the composer card. The slot's
    // wrapper is `empty:hidden`, so an idle return null leaves no gap.
    ctx.register({
      id: 'turn-indicator-strip',
      // Area constants are not exported by the runtime SDK (see the note in
      // README): always the literal id.
      area: 'composer.top',
      render: () => jsx(Indicator, {})
    })

    // `::turn{}` — inline in the assistant bubble, visible only while that
    // message streams. The name must be lowercase [a-z0-9-] and unique across
    // plugins (first registration wins).
    ctx.register({
      id: 'turn-indicator-inline',
      area: 'transcript.directives',
      data: {
        name: 'turn',
        render: props => (props.streaming ? jsx(DirectiveLine, { attrs: props.attrs }) : null)
      }
    })

    // Settings ▸ Plugins ▸ Turn indicator — the knobs below are the same values
    // the latch and buildCss read, so an edit lands on the running instance.
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({
        id: 'prefs',
        // A product name in both bundles, so the rail label stays literal.
        title: 'Turn indicator',
        icon: 'pulse',
        order: 70,
        render: () => jsx(SettingsPage, {})
      })
    }

    // ── Live label + turn latch ──────────────────────────────────────────────
    // Gateway events for the FOCUSED chat only: the stream is per-gateway, so a
    // tool row from another tab would relabel this one. `replayed` frames are
    // old turns re-sent on reconnect — never live activity.
    const isMine = event => {
      const eventSession = event?.session_id
      const focused = host.state.focusedSessionId.get()
      return !focused || !eventSession || focused === eventSession
    }

    /** A tool call in flight is live even when the gateway is not `busy` — it is
     *  exactly the gap that used to unmount the row.
     *
     *  Keyed by SESSION, and counted OUTSIDE the `isMine` filter: a tool that
     *  started in one chat and finished after the user focused another pane used
     *  to be counted on start and dropped on complete (the complete carried the
     *  old session id), so the row and the glow stayed latched open forever. Only
     *  the label is focus-scoped. */
    const pendingBySession = Object.create(null)

    const pendingKey = event => String(event?.session_id || 'unknown')

    const bumpPending = (event, delta) => {
      const key = pendingKey(event)
      const next = (pendingBySession[key] || 0) + delta

      pendingBySession[key] = next > 0 ? next : 0
    }

    /** Drop counts — one session's, or every session's. */
    const resetPending = session => {
      for (const key of Object.keys(pendingBySession)) {
        if (!session || key === session) {
          delete pendingBySession[key]
        }
      }
    }

    let lastLiveAt = 0
    let closeArmed = false

    // ── display layer: tag the bubbles of the live turn ─────────────────────
    const clearGlow = () => {
      for (const el of document.querySelectorAll(`[data-${GLOW_ATTR}]`)) {
        // The attribute NAME, not the selector: `[data-turn-glow]` is accepted
        // by removeAttribute (Chrome does not throw on a bracketed name) and
        // silently removes nothing, which left every closed turn's bubble
        // breathing forever.
        el.removeAttribute(`data-${GLOW_ATTR}`)
      }
    }

    /** Idempotent, and it writes only the DIFFERENCE: re-adding the attribute to
     *  a node that already carries it restarts its CSS animation, which is what
     *  made the breathing hitch. Skips a transcript that is mounted but not laid
     *  out (preloaded and tile panes), and takes its last turn pair in document
     *  order — a turn pair is created with the user message and holds every
     *  assistant segment, so one node covers the whole turn. */
    const paintGlow = () => {
      // `$turn` as well as the pref: this also runs on every prefs write (the
      // settings page saves) and on register, where the newest turn is history.
      // Tagging it there painted a breathing bubble on a finished turn, and the
      // settle chain — the only thing that calls clearGlow — was not running.
      if (!prefs().bubbleGlow || !$turn.get()) {
        clearGlow()

        return
      }

      const targets = new Set()

      for (const thread of document.querySelectorAll('[data-slot="thread"]')) {
        if (thread.getClientRects().length === 0) {
          continue
        }

        const pairs = thread.querySelectorAll('[data-slot="aui_turn-pair"]')
        const newest = pairs[pairs.length - 1]

        if (newest) {
          targets.add(newest)
        }
      }

      for (const el of document.querySelectorAll(`[data-${GLOW_ATTR}]`)) {
        if (!targets.has(el)) {
          el.removeAttribute(`data-${GLOW_ATTR}`)
        }
      }

      for (const el of targets) {
        if (!el.hasAttribute(`data-${GLOW_ATTR}`)) {
          el.setAttribute(`data-${GLOW_ATTR}`, '')
        }
      }
    }

    // ── display layer: keep core's pulse alive while the tool rows are hidden ──
    const clearActivity = () => {
      for (const el of document.querySelectorAll(`[data-${ACT_ATTR}]`)) {
        el.removeAttribute(`data-${ACT_ATTR}`)
      }
    }

    /** Same shape as paintGlow: tag the NEWEST activity row of every laid-out
     *  transcript, write only the difference, and let the stylesheet decide when
     *  the pulse shows. Gated on `toolRows` because the row it repairs is only
     *  missing while this plugin is hiding the tool rows that would have
     *  narrated the same wait; on `hideActivityRow` because a hidden row needs no
     *  repair (and tagging one would keep the repaint pass querying for it every
     *  time the transcript mutates); and on `$turn` so a finished turn never
     *  leaves a square behind. */
    const paintActivity = () => {
      if (!prefs().toolRows || prefs().hideActivityRow || !$turn.get()) {
        clearActivity()

        return
      }

      const targets = new Set()

      for (const thread of document.querySelectorAll('[data-slot="thread"]')) {
        if (thread.getClientRects().length === 0) {
          continue
        }

        const rows = thread.querySelectorAll('[data-slot="aui_turn-activity"]')
        const newest = rows[rows.length - 1]

        if (newest) {
          targets.add(newest)
        }
      }

      for (const el of document.querySelectorAll(`[data-${ACT_ATTR}]`)) {
        if (!targets.has(el)) {
          el.removeAttribute(`data-${ACT_ATTR}`)
        }
      }

      for (const el of targets) {
        if (!el.hasAttribute(`data-${ACT_ATTR}`)) {
          el.setAttribute(`data-${ACT_ATTR}`, '')
        }
      }
    }

    /** Debounced repaint, driven by the transcript's own mutations (see the
     *  MutationObserver below) instead of a polling tick: a new assistant
     *  segment or tool row mounting mid-turn is the only thing that makes the
     *  tag pass produce a different answer. */
    let repaintPending = false
    const scheduleRepaint = () => {
      if (repaintPending) {
        return
      }

      repaintPending = true
      ctx.setTimeout(() => {
        repaintPending = false

        if ($turn.get()) {
          paintGlow()
          paintActivity()
        }
      }, REPAINT_MS)
    }

    // Saved settings land immediately: the rules are one string, so a change is
    // one write, plus a re-tag when the glow was just switched on (its attribute
    // is only painted by a repaint. Subscribed HERE rather than up in the
    // stylesheet block: nanostores fires a new listener immediately, so an earlier
    // subscription would reach paintGlow before its `const` is initialized.
    unsubscribePrefs = $prefs.subscribe(() => {
      if (styleEl) {
        styleEl.textContent = buildCss(prefs())
      }

      paintGlow()
      paintActivity()
    })

    /** Whether the FOCUSED chat has anything in flight.
     *
     *  Deliberately not `busy` alone: that flag follows TILE FOCUS, drops
     *  between two tool calls and across a message boundary inside one turn, and
     *  a stream hiccup drops it too — each of those used to close the row over a
     *  turn that was still running. `awaitingResponse` covers the window between
     *  the send and the first assistant payload; the focused session's own
     *  in-flight tool calls cover the gaps in between.
     *
     *  Deliberately not EVERY session either: `composer.top` is one pane's strip,
     *  so a background bot / Kanban turn — or another tile — must not narrate
     *  itself in the chat the user is typing in. */
    const focusedLive = () => {
      if (host.state.busy.get() || host.state.awaitingResponse.get()) {
        return true
      }

      const focused = host.state.focusedSessionId.get()

      return Boolean(focused && ((host.state.busyBySession.get() || {})[focused] || pendingBySession[focused] > 0))
    }

    /** The FOCUSED chat's own turn, for the "new turn starts clean" reset. */
    const focusedBusy = () => {
      const focused = host.state.focusedSessionId.get()

      return Boolean(host.state.busy.get() || (focused && (host.state.busyBySession.get() || {})[focused]))
    }

    /** One timer per close window, not a 400 ms tick: nothing here needs
     *  per-tick work (the repaint hangs off the transcript's mutations), so the
     *  latch costs one wake-up per `settleMs` for as long as a turn is open. */
    const armClose = (ms = prefs().settleMs) => {
      if (closeArmed) {
        return
      }

      closeArmed = true
      ctx.setTimeout(close, Math.max(0, ms))
    }

    const close = () => {
      closeArmed = false

      if (!$turn.get()) {
        return
      }

      // A gateway that still reports a turn IS a live signal, and it has to
      // refresh the clock: otherwise the window is measured from the last EVENT,
      // so a turn with a long silent stretch (a tool running, a slow provider)
      // closes the instant `busy` blinks false for a hiccup.
      if (focusedLive()) {
        lastLiveAt = Date.now()
        armClose()

        return
      }

      const remaining = prefs().settleMs - (Date.now() - lastLiveAt)

      if (remaining > 0) {
        armClose(remaining)

        return
      }

      $turn.set(false)
      clearGlow()
      clearActivity()
      // Nothing is live by definition here, so a count left over from a dropped
      // `tool.complete` (or a gateway hiccup) is garbage — clear it, or the next
      // turn starts latched open.
      resetPending()
    }

    /** Open (or keep open) the turn; `close()` ends it. */
    const live = () => {
      lastLiveAt = Date.now()

      if (!$turn.get()) {
        $turn.set(true)
        paintGlow()
        paintActivity()
      }

      armClose()
    }

    // The transcript mounting a new turn pair / activity row is the only thing
    // that changes what the tag pass should paint mid-turn, so it drives the
    // repaint directly instead of being polled for.
    const observer =
      typeof document !== 'undefined' && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            if ($turn.get()) {
              scheduleRepaint()
            }
          })
        : null

    observer?.observe(document.body, { childList: true, subtree: true })

    /** Rising-edge bookkeeping for the focused chat.
     *
     *  Reading it on EVERY notification was a bug: `$busyBySession` is a computed
     *  that hands out a fresh object on every session-store write (token usage,
     *  heartbeats, tool activity), so an unconditional reset zeroed the focused
     *  chat's in-flight tool count and dropped its label back to 思考中 while a
     *  tool was still running. The count follows the CALL, so only a genuine
     *  not-busy → busy edge starts a clean slate. */
    let wasFocusedBusy = focusedBusy()
    let lastFocused = host.state.focusedSessionId.get()

    const syncBusy = () => {
      const focused = host.state.focusedSessionId.get()

      if (focused !== lastFocused) {
        // Focus moved: the LABEL is stale, the counts are not.
        lastFocused = focused
        setActivity('')
      }

      const busyNow = focusedBusy()

      if (busyNow && !wasFocusedBusy) {
        // A new turn starts from a clean slate: no label carried over from the
        // last turn's last tool call, and no count stranded on THIS chat.
        resetPending(focused)
        setActivity('')
      }

      wasFocusedBusy = busyNow

      if (focusedLive()) {
        live()
      }
    }

    const onLive = (type, handler) =>
      ctx.onEvent(type, event => {
        if (!isMine(event) || event.replayed) {
          return
        }

        live()
        handler?.(event)
      })

    // Tool bookkeeping is deliberately NOT focus-scoped (see pendingBySession):
    // the count follows the call, only the label follows the focused chat.
    ctx.onEvent('tool.start', event => {
      if (event.replayed) {
        return
      }

      bumpPending(event, 1)

      if (isMine(event)) {
        live()
        setActivity(describeTool(event.payload))
      }
    })

    onLive('tool.generating', () => setActivity(zh('准备工具参数', 'Preparing a tool call')))

    ctx.onEvent('tool.complete', event => {
      if (event.replayed) {
        return
      }

      bumpPending(event, -1)

      if (isMine(event)) {
        live()
        setActivity('')
      }
    })

    onLive('tool.progress')
    onLive('message.start')
    onLive('message.interim')
    onLive('message.delta', () => setActivity(zh('生成回复', 'Writing the reply')))
    onLive('thinking.delta', () => setActivity(''))
    onLive('reasoning.delta')

    onLive('status.update', event => {
      if (event.payload?.kind === 'compacting') {
        setActivity(zh('整理上下文', 'Summarizing the thread'))
      }
    })

    // The turn is over when the gateway says so — but only `close()` decides
    // when the row goes away, so a message.complete mid-turn (reply → tool →
    // reply) clears the label without closing the turn. Focus- and replay-gated
    // like every other signal: another chat's completion, or an old frame
    // re-sent on reconnect, must not wipe THIS chat's label.
    ctx.onEvent('message.complete', event => {
      if (event.replayed || !isMine(event)) {
        return
      }

      setActivity('')
    })

    const unsubscribe = [
      host.state.busy,
      host.state.busyBySession,
      host.state.focusedSessionId,
      host.state.awaitingResponse
    ].map(state => state.subscribe(syncBusy))

    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        for (const off of unsubscribe) {
          off()
        }

        observer?.disconnect()
        closeArmed = false
        resetPending()
        $turn.set(false)
        clearGlow()
        clearActivity()
      })
    }

    // The plugin can be enabled mid-turn, and a session can already be busy.
    if (focusedLive()) {
      live()
    }

  }
}
