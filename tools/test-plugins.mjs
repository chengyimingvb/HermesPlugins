#!/usr/bin/env node
/**
 * Test gate for every plugin in this repo. No dependencies, no browser:
 *
 *  1. STATIC  — each `<id>/desktop/plugin.js` parses as an ES module, imports
 *     only what the plugin loader can resolve, is LF-only, and carries no
 *     leftover debug probe; `plugin.yaml` matches the folder name.
 *  2. LOGIC   — the SHIPPED source is extracted and driven directly (no mirror):
 *       * turn-indicator's turn latch, against a fake clock: it must survive a
 *         `busy` drop while a tool is in flight and close only after SETTLE_MS.
 *       * turn-indicator's `describeTool` label mapping.
 *       * turn-glow's injected CSS contract: exactly one animated target (the
 *         bubble), a `from`/`to` + `alternate` loop, no invented radius, no
 *         `!important` fighting core.
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
  const chainMs = Number(/const CHAIN_MS = (\d+)/.exec(source)?.[1])
  const glowAttr = /const GLOW_ATTR = '([^']+)'/.exec(source)?.[1]
  const block = extract(source, [
    'let pendingTools = 0',
    '    const onLive = (type, handler) =>'
  ])

  if (!settleMs || !chainMs || !glowAttr || !block) {
    fail('could not extract settleMs/CHAIN_MS/GLOW_ATTR/pendingTools…live() from the source')

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
let __prefs = { bubbleGlow: true, settleMs: ${settleMs} }
const $prefs = { get: () => __prefs, subscribe: () => () => {} }
const prefs = () => __prefs
const CHAIN_MS = ${chainMs}
const GLOW_ATTR = '${glowAttr}'
const Date = { now: () => __now }
const host = { state: {
  busy: { get: () => __busy },
  awaitingResponse: { get: () => __awaiting },
  busyBySession: { get: () => __bySession },
  focusedSessionId: { get: () => __focused }
} }
const $turn = { get: () => __turn, set: value => { __turn = value } }
const ctx = { setTimeout: (fn, ms) => { __timers.push({ at: __now + ms, fn }); return () => {} } }
// The latch block also carries the glow's DOM layer, whose paint/tag pass runs on
// the same tick. Empty answers keep it inert; the counter proves the tick is shared.
let __glowQueries = 0
const document = {
  querySelectorAll: () => { __glowQueries += 1; return [] },
  querySelector: () => null
}

${block}

return {
  live,
  settle,
  glowQueries: () => __glowQueries,
  setBusy: value => { __busy = value },
  setAwaiting: value => { __awaiting = value },
  setBySession: value => { __bySession = value },
  setFocused: value => { __focused = value },
  setPending: value => { pendingTools = value },
  setTurn: value => { __turn = value },
  setPrefs: value => { __prefs = { ...__prefs, ...value } },
  turn: () => __turn,
  settleMs: ${settleMs},
  chainMs: CHAIN_MS,
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
  check('opening the turn also re-tags the glow (one shared tick)', api.glowQueries() > 0)
  api.advance(200)
  api.setBusy(false)
  api.setPending(1)
  api.advance(settleMs * 4)
  check('survives a busy=false gap while a tool is in flight', api.turn() === true)

  // B) the tool lands (its event is live) → still up at SETTLE_MS-100, gone by SETTLE_MS+chain.
  api.setPending(0)
  api.live()
  api.advance(settleMs - 100)
  check(`still open ${settleMs - 100}ms after the last signal`, api.turn() === true)
  api.advance(chainMs * 2)
  check(`closed within ${chainMs * 2}ms of the settle window`, api.turn() === false)

  // C) the send→first-token window holds the row on its own.
  api.setAwaiting(true)
  api.live()
  api.setAwaiting(false)
  api.advance(settleMs - 100)
  check('a send waiting on its first token holds the row', api.turn() === true)
  api.advance(chainMs * 2)
  check('…and lets go once nothing is live', api.turn() === false)

  // D) `busy` follows TILE FOCUS: another session mid-turn must hold this row up.
  api.setBySession({ s1: false, s2: true })
  api.live()
  api.advance(settleMs * 3)
  check('another session mid-turn keeps the row open', api.turn() === true)
  api.setBySession({})
  api.advance(settleMs + chainMs * 2)
  check('and closes once every session is idle', api.turn() === false)

  // E) a busy turn is never closed by idle time alone; then the real end.
  api.setBusy(true)
  api.live()
  api.advance(settleMs * 3)
  check('a busy turn is never closed by idle time alone', api.turn() === true)
  api.setBusy(false)
  api.advance(settleMs - 100)
  check('open just inside the settle window after the turn ends', api.turn() === true)
  api.advance(chainMs * 2)
  check('closed just after it', api.turn() === false)
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

  const buildCss = new Function(`const GLOW_ATTR = 'turn-glow'\n${block}\nreturn buildCss`)()
  const defaults = { toolRows: true, bubbleGlow: true, glowMs: 1200, glowStrength: 55 }
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

  // Seamless loop: the two ends are the two extremes, reversed by `alternate`.
  check('keyframes are from/to', /from\s*\{/.test(glow) && /to\s*\{/.test(glow))
  check('infinite + alternate', /infinite\s+alternate/.test(glow))
  check('theme accent only', !/#[0-9a-f]{3,}/i.test(glow) && glow.includes('var(--ui-accent)'))

  // The settings page's knobs must actually reach the stylesheet.
  check('toolRows=false drops the hide rule', !buildCss({ ...defaults, toolRows: false }).includes('tool-block'))
  check('bubbleGlow=false drops the glow', !buildCss({ ...defaults, bubbleGlow: false }).includes('@keyframes'))
  check('glowMs reaches the animation', buildCss({ ...defaults, glowMs: 2000 }).includes('2000ms'))
  check('glowStrength reaches the keyframes', buildCss({ ...defaults, glowStrength: 80 }).includes('80%'))
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
