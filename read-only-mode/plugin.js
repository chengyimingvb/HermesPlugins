/**
 * Read-only mode — an ask-mode toggle beside the composer's "+" menu.
 *
 * What it does: one ghost icon button (`composer.leading`, the row cell right
 * after the `+`). ON = the next sends carry a read-only directive the model
 * sees as the opening line of the user turn; OFF = exact pass-through.
 *
 * Why text and not a tool gate: Hermes has no session-level read-only policy
 * (`session.mutate` exposes edit_policy, whose values are ask /
 * workspace_session / session — nothing that forbids writes, and desktop file
 * writes never pass an approval prompt at all). A plugin cannot change the
 * system prompt mid-turn either (prompt caching). So the honest enforcement
 * point available to a plugin is the outgoing turn text, applied through the
 * composer's own middleware chain (`composer.middleware`, run around onSubmit
 * in use-middleware-submit.ts). It is an instruction, not a sandbox: state
 * that plainly instead of implying a hard gate.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, styles are inline / theme
 * vars. Only @hermes/plugin-sdk, react and react/jsx-runtime resolve. Area ids
 * are LITERALS — the packaged SDK does not export the area constants.
 */

import { jsx } from 'react/jsx-runtime'
import { atom, Button, Codicon, GHOST_ICON_BTN, Tip, host, useValue } from '@hermes/plugin-sdk'

const ID = 'read-only-mode'
const STORAGE_KEY = 'on'

const isChinese = () => {
  const fromDom = typeof document === 'undefined' ? '' : document.documentElement.lang || ''
  const fromNavigator = typeof navigator === 'undefined' ? '' : navigator.language || ''

  return (fromDom || fromNavigator).toLowerCase().startsWith('zh')
}

const zh = (zhText, enText) => (isChinese() ? zhText : enText)

/** Marker at the head of the injected block. Also the idempotency key: a draft
 *  that already starts with it is never prefixed twice (queued sends, retries,
 *  or a user who pasted the block themselves). */
const HEAD = '⟨read-only-mode⟩'

const body = () =>
  zh(
    '只读模式：本轮只做阅读与回答。只用读操作与只读命令（读文件、搜索、ls、git log/diff/status）。' +
      '不创建、修改、删除、移动文件，不写配置，不装依赖，不执行有副作用的命令（build / test / format / install / git commit、push 等）。' +
      '需要改动时，只给方案或 diff，等我确认后再动手。',
    'Read-only mode: answer from reading only. Use read operations and read-only commands only ' +
      '(read_file, search, ls, git log/diff/status). Do not create, modify, delete or move files, ' +
      'write config, install packages, or run side-effecting commands (build / test / format / ' +
      'install / git commit, push). When a change is needed, show the plan or diff and wait for my ' +
      'confirmation.'
  )

/** Whether the toggle is on. Module-level on purpose: one switch for every
 *  composer instance (sessions, tiles, the fresh draft), mirrored to
 *  `ctx.storage` so it survives a reload. */
const $on = atom(false)

/** The live ctx, captured by register(). Module scope (not a render closure) so
 *  the click handler always reaches the ctx of the CURRENT module instance. */
let pluginCtx = null

const setMode = (next, ctx = pluginCtx) => {
  const value = Boolean(next)

  if ($on.get() === value) {
    return
  }

  $on.set(value)

  try {
    ctx?.storage?.set(STORAGE_KEY, value)
  } catch {
    // A storage refusal must not break the toggle itself.
  }

  host.notify({
    kind: value ? 'success' : 'info',
    message: value
      ? zh('只读模式已开启：发送的消息会带上"只读、不改文件"的约束', 'Read-only mode on: sends carry a no-writes directive')
      : zh('只读模式已关闭：恢复正常读写', 'Read-only mode off: normal read/write')
  })
}

/** The `composer.middleware` handler: prepend the directive, pass through
 *  otherwise. Returning the draft untouched keeps the chain byte-identical
 *  when the toggle is off (an empty-text send, e.g. attachments only, is never
 *  prefixed). */
const middleware = draft => {
  if (!$on.get()) {
    return draft
  }

  const text = typeof draft?.text === 'string' ? draft.text : ''

  if (!text.trim() || text.trimStart().startsWith(HEAD)) {
    return draft
  }

  return { ...draft, text: `${HEAD} ${body()}\n\n${text}` }
}

function Toggle() {
  const on = useValue($on)
  const label = on
    ? zh('只读模式：已开启（不改文件）', 'Read-only mode: on')
    : zh('只读模式：关闭', 'Read-only mode: off')

  return jsx(Tip, {
    label,
    children: jsx(Button, {
      'aria-label': label,
      'aria-pressed': on,
      // Probe hook: a plugin-owned attribute, never core markup.
      'data-read-only-mode': on ? 'on' : 'off',
      // The composer's own ghost icon-button recipe, so the control matches the
      // `+` beside it (size comes from --composer-control-size).
      className: GHOST_ICON_BTN,
      onClick: () => setMode(!$on.get()),
      size: 'icon',
      // Inline, theme-var only: a plugin's Tailwind classes are not in the
      // app's compiled stylesheet, so the ON state cannot be a utility class.
      style: on
        ? {
            background: 'color-mix(in srgb, var(--ui-accent) 16%, transparent)',
            color: 'var(--ui-accent)'
          }
        : undefined,
      type: 'button',
      variant: 'ghost',
      children: jsx(Codicon, { name: on ? 'lock' : 'unlock', size: '0.875rem' })
    })
  })
}

export default {
  id: ID,
  name: 'Read-only mode',
  register(ctx) {
    // Kept on a stable module-level name: the toggle's render creates its click
    // handler, and a reload swaps the module instance.
    pluginCtx = ctx

    let stored = false

    try {
      stored = Boolean(ctx.storage?.get(STORAGE_KEY, false))
    } catch {
      stored = false
    }

    $on.set(stored)

    // Inline, after the "+" menu (grid-area: menu, items-start) — the row cell
    // sized for an icon button, so it costs the input grid nothing.
    ctx.register({
      id: 'read-only-mode-toggle',
      area: 'composer.leading',
      render: () => jsx(Toggle, {})
    })

    // The enforcement point: rewrites the outgoing draft before onSubmit.
    ctx.register({
      id: 'read-only-mode-middleware',
      area: 'composer.middleware',
      data: { handler: middleware }
    })

    ctx.register({
      id: 'read-only-mode-palette',
      area: 'palette',
      data: {
        id: 'read-only-mode.toggle',
        label: 'Read-only mode: toggle',
        keywords: ['read-only', 'readonly', '只读', '问答', 'ask'],
        run: () => setMode(!$on.get(), ctx)
      }
    })
  }
}
