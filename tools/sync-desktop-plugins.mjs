#!/usr/bin/env node
/**
 * Sync each plugin's `desktop/` tree from this repo into the desktop app's
 * standalone plugin root (`<HERMES_HOME>/desktop-plugins/<id>/`), so ONE command
 * makes a repo edit live in the running app — the app watches the copy and
 * re-runs `register()` on save, no reload, no restart.
 *
 * A symlink cannot replace this: the loader reads `<root>/<id>/plugin.js` while
 * the repo keeps the file at `<id>/desktop/plugin.js`.
 *
 *   node tools/sync-desktop-plugins.mjs                # every INSTALLED plugin, once
 *   node tools/sync-desktop-plugins.mjs git-ops        # named plugins only
 *   node tools/sync-desktop-plugins.mjs --watch        # re-sync on save
 *   node tools/sync-desktop-plugins.mjs --home PATH    # non-default HERMES_HOME
 *
 * Named plugins are copied in whether or not the app root already has them; the
 * no-name batch only refreshes plugins it finds there, so a stray run never
 * installs a plugin the user never asked for.
 *
 * Never touches a folder the app owns (`hermes plugins install` writes a
 * `.hermes-package.json` marker and re-copies that half on its own reconcile).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '.hermes-package.json'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEBOUNCE_MS = 120

function parseArgs(argv) {
  let home = null
  let watch = false
  const names = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--watch') {
      watch = true
    } else if (arg === '--home') {
      home = argv[index + 1] ?? null
      index += 1

      if (!home) {
        throw new Error('--home needs a path')
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`)
    } else {
      names.push(arg)
    }
  }

  const resolved =
    home ??
    process.env.HERMES_HOME ??
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(os.homedir(), '.hermes'))

  return { home: path.resolve(resolved), names, watch }
}

/** Plugin folder names this repo publishes: `<id>/desktop/plugin.js` present. */
function discover() {
  return fs
    .readdirSync(REPO, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isFile(path.join(REPO, entry.name, 'desktop', 'plugin.js')))
    .map(entry => entry.name)
    .sort()
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, prefix = '') {
  const out = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), relative))
    } else if (entry.isFile()) {
      out.push(relative)
    }
  }

  return out
}

/** Copy `desktop/` over the app root copy. Returns the files it rewrote, or a
 *  `skipped` reason for a folder the app owns. */
function syncOne(root, id) {
  const from = path.join(REPO, id, 'desktop')
  const to = path.join(root, id)

  if (fs.existsSync(path.join(to, MARKER))) {
    return {
      skipped: `app-managed (${MARKER}) — the app re-copies it from \`hermes plugins install\``,
      written: []
    }
  }

  const written = []

  for (const file of walk(from)) {
    const source = path.join(from, file)
    const target = path.join(to, file)
    const bytes = fs.readFileSync(source)

    if (isFile(target) && fs.readFileSync(target).equals(bytes)) {
      continue
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
    written.push(file)
  }

  return { written }
}

const { home, names, watch } = parseArgs(process.argv.slice(2))
const ROOT = path.join(home, 'desktop-plugins')
const install = names.length > 0
const stamp = () => new Date().toTimeString().slice(0, 8)
const ids = (install ? names : discover()).filter(id => {
  if (isFile(path.join(REPO, id, 'desktop', 'plugin.js'))) {
    return true
  }

  console.error(`${id}: no desktop/plugin.js in this repo`)
  process.exitCode = 1

  return false
})

if (ids.length === 0) {
  console.error('nothing to sync')
  process.exit(1)
}

console.log(`${stamp()} root=${ROOT}`)

function run(id, install) {
  if (!install && !fs.existsSync(path.join(ROOT, id))) {
    console.log(`${stamp()} ${id}: not installed — pass its name to copy it in`)

    return
  }

  try {
    const { skipped, written } = syncOne(ROOT, id)

    console.log(
      `${stamp()} ${id}: ${
        skipped
          ? `skipped — ${skipped}`
          : written.length > 0
            ? `synced ${written.join(', ')}`
            : 'already current'
      }`
    )
  } catch (error) {
    process.exitCode = 1
    console.error(`${stamp()} ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Watch `dir` recursively, falling back to per-file watches where the platform
 *  has no recursive watch (Linux), so a save anywhere in `desktop/` syncs. */
function watchDir(dir, onChange) {
  try {
    fs.watch(dir, { recursive: true }, onChange)

    return
  } catch {
    for (const file of walk(dir)) {
      fs.watch(path.join(dir, file), onChange)
    }
  }
}

for (const id of ids) {
  run(id, install)
}

if (!watch) {
  process.exit()
}

// One timer per plugin: a shared one would swallow the other plugin's pending
// sync when two folders change inside the same debounce window.
const watched = ids.filter(id => install || fs.existsSync(path.join(ROOT, id)))
const timers = new Map()

for (const id of watched) {
  watchDir(path.join(REPO, id, 'desktop'), (event, file) => {
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        console.log(`${stamp()} ${id}: ${event} ${file ?? ''}`)
        run(id, install)
      }, DEBOUNCE_MS)
    )
  })
}

console.log(`${stamp()} watching ${watched.length} plugin(s) — Ctrl-C to stop`)
