#!/usr/bin/env node
/**
 * Test gate for every plugin in this repo. No dependencies, no browser:
 *
 *  1. STATIC  — each `<id>/desktop/plugin.js` parses as an ES module, imports
 *     only what the plugin loader can resolve, is LF-only, and carries no
 *     leftover debug probe; `plugin.yaml` matches the folder name.
 *  2. LOGIC   — the SHIPPED source is extracted and driven directly (no mirror):
 *       * turn-indicator's turn latch, against a fake clock: it must survive a
 *         `busy` drop while a tool is in flight, close only after SETTLE_MS, and
 *         ignore other sessions' turns (one composer narrates one chat).
 *       * turn-indicator's rising-edge bookkeeping: session-store churn must not
 *         zero a running tool's count or wipe its label.
 *       * turn-indicator's `describeTool` label mapping.
 *       * turn-glow's injected CSS contract: exactly one animated target (the
 *         bubble), a `from`/`to` + `alternate` loop, no invented radius, no
 *         `!important` fighting core, and the `sr-only` un-clip core needs.
 *
 *   node tools/test-plugins.mjs            # all plugins
 *   node tools/test-plugins.mjs turn-glow  # one plugin's static checks only
 *
 * The live-app half cannot run headless (a packaged build exposes no CDP): a
 * plugin writes `console.error('[<tag>] …')` from inside itself and you grep
 * `$HERMES_HOME/logs/desktop.log`. See the plugin READMEs for that recipe.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Note on `new Function` below: every string it builds comes from THIS REPO's own
 * `desktop/plugin.js`, read from disk a line earlier — the plugin source IS the
 * subject of the test, and there is no network, argv or user input on the path
 * into these bodies. `new Function` is what lets the tests drive the shipped
 * source instead of a hand-copied mirror of it.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED_IMPORTS = new Set(['react', 'react/jsx-runtime', '@hermes/plugin-sdk'])

let failures = 0

const pass = message => console.log(`  PASS ${message}`)
const fail = message => {
  failures += 1
  console.log(`  FAIL ${message}`)
}
const check = (name, condition, detail = '') => (condition ? pass(name) : fail(`${name}${detail ? ` — ${detail}` : ''}`))

const plugins = fs
  .readdirSync(REPO, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(REPO, entry.name, 'desktop', 'plugin.js')))
  .map(entry => entry.name)
  .sort()

const only = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const targets = only.length > 0 ? only : plugins

// ── 1. static ────────────────────────────────────────────────────────────────
function staticChecks(id) {
  const dir = path.join(REPO, id)
  const file = path.join(dir, 'desktop', 'plugin.js')
  const source = fs.readFileSync(file, 'utf8')

  console.log(`\n[static] ${id}`)

  // ESM parse, on a .mjs copy so `import` statements are legal to --check.
  const probe = path.join(os.tmpdir(), `${id}-parse-check.mjs`)
  fs.writeFileSync(probe, source)

  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' })
    pass('parses as an ES module')
  } catch (error) {
    fail(`parse error — ${String(error.stderr || error).split('\n').slice(0, 3).join(' ')}`)
  } finally {
    fs.rmSync(probe, { force: true })
    fs.rmSync(path.join(path.dirname(file), `${id}-parse-check.mjs`), { force: true })
  }

  // The loader hands the module a bare specifier set; anything else fails at load.
  const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1])
  const bad = imports.filter(specifier => !ALLOWED_IMPORTS.has(specifier))
  check('imports resolve in the plugin loader', bad.length === 0, bad.join(', '))

  // LF-only: patch tools have flipped this file to CRLF before, which rewrites it.
  check(
    'LF line endings',
    !source.includes('\r'),
    `${(source.match(/\r\n/g) || []).length} CRLF line(s)`
  )

  // A forgotten probe is a shipped log line in the user's desktop.log.
  const probeLine = source
    .split('\n')
    .findIndex(line => /TEMP (PROBE|TEST PROBE|SAMPLER)|\[[a-z-]+-(probe|sampler)\]/.test(line))
  check('no leftover debug probe', probeLine === -1, probeLine === -1 ? '' : `line ${probeLine + 1}`)

  const manifest = fs.readFileSync(path.join(dir, 'plugin.yaml'), 'utf8')
  const name = /^name:\s*(\S+)/m.exec(manifest)?.[1]
  check('plugin.yaml name matches the folder', name === id, `name=${name}`)

  for (const field of ['version', 'description']) {
    check(`plugin.yaml declares ${field}`, new RegExp(`^${field}:`, 'm').test(manifest))
  }

  // Recommended, not required: the loader never reads it, `hermes plugins
  // validate` never asks for it.
  if (!/^requires_hermes:/m.test(manifest)) {
    console.log('  WARN plugin.yaml declares no requires_hermes (recommended)')
  }
}

// ── 2a. the turn latch, driven from the shipped source ───────────────────────
function extract(source, anchors) {
  for (const anchor of anchors) {
    if (!source.includes(anchor)) {
      return null
    }
  }

  const start = source.indexOf(anchors[0])
  const endAnchor = anchors[1]
  const end = source.indexOf(endAnchor, start)

  return source.slice(start, end === -1 ? undefined : end)
}

function latchChecks() {
  console.log('\n[logic] turn-indicator · turn latch (fake clock, shipped source)')

  const file = path.join(REPO, 'turn-indicator', 'desktop', 'plugin.js')
  const source = fs.readFileSync(file, 'utf8')

  const settleMs = Number(/settleMs: (\d+)/.exec(source)?.[1])
  const repaintMs = Number(/const REPAINT_MS = (\d+)/.exec(source)?.[1])
  const glowAttr = /const GLOW_ATTR = '([^']+)'/.exec(source)?.[1]
  const actAttr = /const ACT_ATTR = '([^']+)'/.exec(source)?.[1]
  const block = extract(source, [
    'const pendingBySession = Object.create(null)',
    '    const onLive = (type, handler) =>'
  ])

  if (!settleMs || !repaintMs || !glowAttr || !actAttr || !block) {
    fail('could not extract settleMs/REPAINT_MS/GLOW_ATTR/ACT_ATTR/pendingBySession…live() from the source')

    return
  }

  const api = new Function(
    `
let __busy = false
let __awaiting = false
let __focused = 's1'
let __bySession = {}
let __turn = false
let __now = 0
let __timers = []
let __activity = ''
let __prefs = { bubbleGlow: true, toolRows: true, hideActivityRow: false, settleMs: ${settleMs} }
const $prefs = { get: () => __prefs, subscribe: () => () => {} }
const prefs = () => __prefs
const REPAINT_MS = ${repaintMs}
const GLOW_ATTR = '${glowAttr}'
const ACT_ATTR = '${actAttr}'
const Date = { now: () => __now }
const setActivity = value => { __activity = value }
// host.state substitutes: read-only atoms, since the latch block under test only
// reads them (the subscription wiring lives outside the extracted slice).
const stateAtom = get => ({ get, subscribe: () => () => {} })
const host = { state: {
  busy: stateAtom(() => __busy),
  awaitingResponse: stateAtom(() => __awaiting),
  busyBySession: stateAtom(() => __bySession),
  focusedSessionId: stateAtom(() => __focused)
} }
const $turn = { get: () => __turn, set: value => { __turn = value } }
const ctx = { setTimeout: (fn, ms) => { __timers.push({ at: __now + ms, fn }); return () => {} } }
// The latch block also carries the glow's DOM layer, whose paint/tag pass runs on
// the same tick. One fake turn pair stands in for the transcript: it reports the
// attribute honestly, so a removeAttribute call with the wrong name (the selector
// [data-turn-glow] instead of the attribute name) leaves the tag on — exactly
// the shipped bug that kept finished turns breathing.
let __glowQueries = 0
const fake = attr => {
  let on = false
  return {
    node: {
      hasAttribute: name => on && name === attr,
      setAttribute: name => { if (name === attr) { on = true } },
      removeAttribute: name => { if (name === attr) { on = false } }
    },
    isOn: () => on
  }
}
const __glow = fake('data-' + GLOW_ATTR)
const __act = fake('data-' + ACT_ATTR)
const __thread = {
  getClientRects: () => [1],
  querySelectorAll: selector => (selector.includes('aui_turn-activity') ? [__act.node] : [__glow.node])
}
const document = {
  querySelectorAll: selector => {
    __glowQueries += 1

    if (selector.includes('ti-live')) {
      return __act.isOn() ? [__act.node] : []
    }

    if (selector.includes('turn-glow')) {
      return __glow.isOn() ? [__glow.node] : []
    }

    return selector.includes('data-slot="thread"') ? [__thread] : []
  },
  querySelector: () => null
}

${block}

return {
  live,
  close,
  paintGlow,
  clearGlow,
  paintActivity,
  clearActivity,
  glowQueries: () => __glowQueries,
  glowMarked: () => (__glow.isOn() ? 1 : 0),
  activityMarked: () => __act.isOn(),
  bumpPending,
  resetPending,
  pendingCount: () => Object.values(pendingBySession).reduce((sum, n) => sum + n, 0),
  syncBusy,
  setActivity,
  activity: () => __activity,
  setBusy: value => { __busy = value },
  setAwaiting: value => { __awaiting = value },
  setBySession: value => { __bySession = value },
  setFocused: value => { __focused = value },
  setPending: value => { resetPending(); pendingBySession.s1 = value },
  setTurn: value => { __turn = value },
  setPrefs: value => { __prefs = { ...__prefs, ...value } },
  turn: () => __turn,
  settleMs: ${settleMs},
  repaintMs: REPAINT_MS,
  advance: ms => {
    const target = __now + ms

    for (;;) {
      __timers = __timers.filter(timer => timer.at > __now).sort((a, b) => a.at - b.at)
      const next = __timers[0]

      if (!next || next.at > target) {
        break
      }

      __timers = __timers.slice(1)
      __now = next.at
      next.fn()
    }

    __now = target
  }
}`
  )()

  // A) a long tool runs and the gateway drops `busy` — the old code unmounted here.
  api.setBusy(true)
  api.live()
  check('opening the turn also re-tags the glow (one shared repaint)', api.glowQueries() > 0)
  api.advance(200)
  api.setBusy(false)
  api.setPending(1)
  api.advance(settleMs * 4)
  check('survives a busy=false gap while a tool is in flight', api.turn() === true)

  // B) the tool lands (its event is live) → still up at SETTLE_MS-100, gone after.
  api.setPending(0)
  api.live()
  api.advance(settleMs - 100)
  check(`still open ${settleMs - 100}ms after the last signal`, api.turn() === true)
  api.advance(settleMs * 2)
  check('closed once the settle window ran out', api.turn() === false)
  check('closing the turn drops the glow tag', api.glowMarked() === 0)

  // C) the send→first-token window holds the row on its own.
  api.setAwaiting(true)
  api.live()
  api.setAwaiting(false)
  api.advance(settleMs - 100)
  check('a send waiting on its first token holds the row', api.turn() === true)
  api.advance(settleMs * 2)
  check('…and lets go once nothing is live', api.turn() === false)

  // D) `composer.top` is ONE chat's strip: another session (a bot, a Kanban
  //    worker, another tile) mid-turn must not narrate itself here, while the
  //    focused chat's own per-session busy flag must still hold the row up.
  api.setBySession({ s1: false, s2: true })
  api.live()
  api.advance(settleMs * 2)
  check('another session mid-turn does not hold this pane open', api.turn() === false)
  api.setBySession({ s1: true, s2: true })
  api.live()
  api.advance(settleMs * 3)
  check('the focused chat’s own mid-turn does hold it open', api.turn() === true)
  api.setBySession({})
  api.advance(settleMs * 3)
  check('and closes once it is idle', api.turn() === false)

  // E) a busy turn is never closed by idle time alone; then the real end.
  api.setBusy(true)
  api.live()
  api.advance(settleMs * 3)
  check('a busy turn is never closed by idle time alone', api.turn() === true)
  api.setBusy(false)
  api.advance(settleMs - 100)
  check('open just inside the settle window after the turn ends', api.turn() === true)
  api.advance(settleMs * 2)
  check('closed just after it', api.turn() === false)

  // F) the tag is bound to the turn, not just to the pref: a settings save and a
  //    register() both land on paintGlow, and at those moments the newest turn is
  //    history. Tagging it there had the last bubble breathing for good.
  api.setTurn(false)
  api.clearGlow()
  api.paintGlow()
  check('an idle turn is not tagged by a prefs write', api.glowMarked() === 0)
  api.setTurn(true)
  api.paintGlow()
  check('a live turn is tagged', api.glowMarked() === 1)
  api.clearGlow()
  check('clearGlow removes the attribute itself', api.glowMarked() === 0)

  // G) the in-flight tool count follows the CALL, not the focused chat: a
  //    `tool.complete` arriving for the chat the user has left must still
  //    decrement, or the row stays latched open forever (the old shared counter).
  api.resetPending()
  api.bumpPending({ session_id: 's1' }, 1)
  api.bumpPending({ session_id: 's2' }, 1)
  check('two chats hold two counts', api.pendingCount() === 2)
  api.bumpPending({ session_id: 's1' }, -1)
  check('a complete for an unfocused chat still closes its own call', api.pendingCount() === 1)
  api.bumpPending({ session_id: 's2' }, -5)
  check('a stray complete never goes negative', api.pendingCount() === 0)
  api.bumpPending({}, 1)
  api.bumpPending({ session_id: 's3' }, 1)
  api.resetPending('s3')
  check('resetPending(session) drops only that chat', api.pendingCount() === 1)
  api.resetPending()
  check('resetPending() drops every chat', api.pendingCount() === 0)

  // H) core's pulse row is re-armed only during a turn and only while this
  //    plugin is the one hiding the tool rows that would have narrated the wait.
  api.setTurn(false)
  api.paintActivity()
  check('an idle turn carries no pulse tag', api.activityMarked() === false)
  api.setTurn(true)
  api.paintActivity()
  check('a live turn with hidden tool rows re-arms core pulse', api.activityMarked() === true)
  api.setPrefs({ toolRows: false })
  api.paintActivity()
  check('tool rows visible → core narrates itself, no tag', api.activityMarked() === false)
  api.setPrefs({ toolRows: true })
  api.setTurn(true)
  api.setPrefs({ hideActivityRow: true })
  api.paintActivity()
  check('a hidden activity row is never tagged', api.activityMarked() === false)
  api.setPrefs({ hideActivityRow: false })
  api.setTurn(false)
  api.paintActivity()
  check('the pulse tag goes away with the turn', api.activityMarked() === false)

  // I) session-store churn must not wipe the turn's own bookkeeping. The
  //    subscription fires on EVERY $sessionStates write (usage ticks, heartbeats,
  //    tool activity) and $busyBySession is a fresh object each time, so an
  //    unconditional reset zeroed a running tool's count ~1/s and dropped the
  //    label back to 思考中 mid-turn.
  api.resetPending()
  api.setBusy(false)
  api.syncBusy()
  api.setBusy(true)
  api.syncBusy()
  api.bumpPending({ session_id: 's1' }, 1)
  api.setActivity('执行命令')
  api.syncBusy()
  api.syncBusy()
  api.syncBusy()
  check('store churn keeps the running tool count', api.pendingCount() === 1, `count=${api.pendingCount()}`)
  check('store churn keeps the activity label', api.activity() === '执行命令', `label="${api.activity()}"`)
  api.setBusy(false)
  api.syncBusy()
  api.setBusy(true)
  api.syncBusy()
  check(
    'a genuine new turn still starts from a clean slate',
    api.pendingCount() === 0 && api.activity() === '',
    `count=${api.pendingCount()} label="${api.activity()}"`
  )

  // J) nothing polls: the close window is one timer, the repaint is event-driven.
  check('the latch does not poll for a tick', !source.includes('CHAIN_MS'))

  // The counting has to sit OUTSIDE the focus filter, which is what `onLive`
  // applies — registering these two through it is the bug being fixed here.
  check(
    'tool events are not routed through the focus filter',
    !source.includes("onLive('tool.start'") && !source.includes("onLive('tool.complete'")
  )
}

// ── 2b. the tool → label mapping ─────────────────────────────────────────────
function labelChecks() {
  console.log('\n[logic] turn-indicator · describeTool')

  const source = fs.readFileSync(path.join(REPO, 'turn-indicator', 'desktop', 'plugin.js'), 'utf8')
  // Two ranges: the locale helpers sit above the atoms, the tool verbs below them.
  const helpers = extract(source, ['const isChinese = () =>', 'const $activity'])
  const verbs = extract(source, ['const baseName = path =>', 'const boxStyle = {'])

  if (!helpers || !verbs) {
    fail('could not extract isChinese…describeTool from the source')

    return
  }

  const api = new Function(
    `const document = { documentElement: { lang: 'zh-CN' } }
const navigator = { language: 'zh-CN' }
${helpers}
${verbs}
return { describeTool, baseName, label }`
  )()

  const cases = [
    ['patch', { path: 'D:\\repo\\src\\plugin.js' }, '编辑 plugin.js'],
    ['write_file', { path: 'a/b/c.md' }, '编辑 c.md'],
    ['patch', {}, '编辑文件'],
    ['read_file', { file_path: '/x/y/z.ts' }, '读取 z.ts'],
    ['terminal', {}, '执行命令'],
    ['search_files', {}, '搜索代码'],
    ['web_search', {}, '查阅资料'],
    ['todo_list', {}, '整理待办'],
    ['delegate_task', {}, '分派子任务'],
    ['browser_exec', {}, '操作浏览器'],
    ['some_mcp_tool', {}, '调用 some_mcp_tool']
  ]

  for (const [name, args, expected] of cases) {
    const actual = api.describeTool({ name, args })
    check(`${name} → ${expected}`, actual === expected, `got "${actual}"`)
  }

  check('empty payload names no tool', api.describeTool({}) === '')
  check('baseName keeps the last segment', api.baseName('a\\b\\c.js') === 'c.js')
  check('idle label', api.label() === '思考中')
}

// ── 2c. the injected CSS contract ────────────────────────────────────────────
function glowCssChecks() {
  console.log('\n[logic] turn-indicator · injected CSS (tool rows + bubble glow)')

  const source = fs.readFileSync(path.join(REPO, 'turn-indicator', 'desktop', 'plugin.js'), 'utf8')
  const block = extract(source, ['const buildCss = p => {', 'const setActivity'])

  if (!block) {
    fail('could not extract buildCss from the source')

    return
  }

  const buildCss = new Function(`const GLOW_ATTR = 'turn-glow'\nconst ACT_ATTR = 'ti-live'\n${block}\nreturn buildCss`)()
  const defaults = { toolRows: true, hideActivityRow: false, bubbleGlow: true, glowMs: 1200, glowStrength: 55 }
  const all = buildCss(defaults)
  // The tool-row rule keeps its `!important` (it has to beat Tailwind); the glow
  // rules must not, or they would outrank the theme for every later revision.
  const glow = all.slice(all.indexOf('@keyframes'))

  check('tool rows are still hidden from the same stylesheet', all.includes('[data-slot="tool-block"]'))
  check('no !important inside the glow rules', !glow.includes('!important'))
  check('no invented border-radius', !glow.includes('border-radius'))
  check('exactly one glow animation', (glow.match(/animation:/g) || []).length === 1)

  // The rule that carries the animation: drop the keyframes block (its stops are
  // nested braces) and take the first selector that follows.
  const withoutKeyframes = glow.replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/, '')
  const selector = /([^{}]+?)\s*\{/.exec(withoutKeyframes)?.[1]?.trim()
  check(
    'the animated target is the bubble only',
    selector === "[data-turn-glow] .composer-human-message",
    `selector "${selector}"`
  )
  check('assistant content is not touched', !glow.includes('aui_assistant-message-content'))
  // removeAttribute takes the attribute NAME; a bracketed selector is accepted
  // silently and removes nothing, which left closed turns breathing.
  check('no selector passed to removeAttribute', !source.includes('removeAttribute(`[data-'))

  // Seamless loop: the two ends are the two extremes, reversed by `alternate`.
  check('keyframes are from/to', /from\s*\{/.test(glow) && /to\s*\{/.test(glow))
  check('infinite + alternate', /infinite\s+alternate/.test(glow))
  check('theme accent only', !/#[0-9a-f]{3,}/i.test(glow) && glow.includes('var(--ui-accent)'))

  // The settings page's knobs must actually reach the stylesheet.
  check('toolRows=false drops the hide rule', !buildCss({ ...defaults, toolRows: false }).includes('tool-block'))

  // Core's own pulse row: restored for the windows core suppresses it, only
  // while the tool rows are hidden, and never by fighting an !important.
  const idle = all.slice(all.indexOf('[data-ti-live]'))
  check('the core pulse row is re-armed for idle windows', idle.includes('data-state="idle"') && idle.includes('::before'))
  check('the re-armed row does not use !important', !idle.includes('!important'))
  // Tailwind v4's `.sr-only` is `clip-path: inset(50%)` and ships no `clip`, so
  // resetting `clip` alone left the restored row laid out but painted empty.
  check('the re-armed row un-clips sr-only (clip-path: none)', idle.includes('clip-path: none'))
  check('the dither square is drawn with the theme colour', idle.includes('repeating-conic-gradient(currentColor') && idle.includes('border-radius: 2px'))
  check(
    'toolRows=false leaves core activity row alone',
    !buildCss({ ...defaults, toolRows: false }).includes('aui_turn-activity')
  )
  check('bubbleGlow=false drops the glow', !buildCss({ ...defaults, bubbleGlow: false }).includes('@keyframes'))
  check('glowMs reaches the animation', buildCss({ ...defaults, glowMs: 2000 }).includes('2000ms'))
  check('glowStrength reaches the keyframes', buildCss({ ...defaults, glowStrength: 80 }).includes('80%'))

  // The row under the bubble: one rule, and the idle repair for that same row
  // goes away with it (repairing a node nothing can see is dead weight).
  const hidden = buildCss({ ...defaults, hideActivityRow: true })
  check(
    'hideActivityRow hides the whole activity row',
    hidden.includes('[data-slot="aui_turn-activity"] { display: none !important; }')
  )
  check('hideActivityRow drops the idle repair', !hidden.includes('[data-ti-live]'))
  check('hideActivityRow keeps the tool-row rule', hidden.includes('[data-slot="tool-block"]'))
  check(
    'hideActivityRow=false leaves the row on screen',
    !all.includes('aui_turn-activity"] { display: none')
  )
}

// ── 2d. the settings record's coercion ───────────────────────────────────────
function prefsChecks() {
  console.log('\n[logic] turn-indicator · settings coercion')

  const source = fs.readFileSync(path.join(REPO, 'turn-indicator', 'desktop', 'plugin.js'), 'utf8')
  const block = extract(source, ["const PREF_KEY = 'prefs'", 'const $prefs = atom(PREF_DEFAULTS)'])

  if (!block) {
    fail('could not extract the prefs helpers from the source')

    return
  }

  const api = new Function(
    `${block}
const $prefs = { set: () => {} }
return { readPrefsFrom, savePrefs, PREF_DEFAULTS }`
  )()
  const defaults = api.PREF_DEFAULTS
  const junk = api.readPrefsFrom({
    composerRow: 0,
    toolRows: 'yes',
    bubbleGlow: false,
    glowMs: 'abc',
    glowStrength: 999,
    settleMs: -5,
    inlineDirective: 1
  })

  check('an empty record reads as the defaults', JSON.stringify(api.readPrefsFrom({})) === JSON.stringify(defaults))
  check('a non-boolean toggle falls back to the default', junk.toolRows === defaults.toolRows)
  check('a real boolean is kept', junk.bubbleGlow === false)
  check('an unparsable number falls back to the default', junk.glowMs === defaults.glowMs)
  check('a too-large number clamps to the top', junk.glowStrength === 100)
  check('a negative number clamps to the bottom', junk.settleMs === 500)
  check('a non-boolean flag is not truthy-coerced', junk.inlineDirective === defaults.inlineDirective)
  check('composerRow: an off switch survives', api.readPrefsFrom({ composerRow: false }).composerRow === false)
  check(
    'hideActivityRow: an off switch survives',
    api.readPrefsFrom({ hideActivityRow: false }).hideActivityRow === false
  )
  check('hideActivityRow defaults to on', defaults.hideActivityRow === true)
  // The two places the new pref has to reach, or the toggle would save and do
  // nothing: the badge renderer and the settings page's checkbox.
  check('the composer row reads composerRow', source.includes('!settings.composerRow || !working'))
  check('the settings page offers composerRow', source.includes("checkbox('composerRow'"))
  check('the settings page offers hideActivityRow', source.includes("'hideActivityRow',"))
  check('savePrefs clamps on the way in too', api.savePrefs({ glowMs: 1 }).glowMs === 400)
  check('junk input cannot throw', typeof api.savePrefs(null).glowMs === 'number')
}

// ── run ──────────────────────────────────────────────────────────────────────
for (const id of targets) {
  if (!plugins.includes(id)) {
    fail(`${id}: no <id>/desktop/plugin.js in this repo`)

    continue
  }

  staticChecks(id)
}

if (targets.includes('turn-indicator')) {
  latchChecks()
  labelChecks()
  glowCssChecks()
  prefsChecks()
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
