import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MAX_AGE_MS, acquireLock, releaseLock } from './lock.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-lock-test-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const lockFile = (n) => path.join(tmp, n, 'status', 'backup-all.lock')
const seed = (file, h) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(h)) }

test('a free lock is taken and holds our process id and start time', () => {
  const f = lockFile('free')
  assert.deepEqual(acquireLock(f, { pid: 111 }), { ok: true })
  const h = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(h.pid, 111)
  assert.ok(Date.parse(h.startedAt) > 0)
})

test('a live lock refuses and names the holder; the file is left alone', () => {
  const f = lockFile('live')
  const h = { pid: 222, startedAt: new Date().toISOString() }
  seed(f, h)
  const r = acquireLock(f, { pid: 333, alive: (p) => p === 222 })
  assert.equal(r.ok, false)
  assert.equal(r.holder.pid, 222)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), h)
})

test('a stale lock (process gone) is ignored and replaced', () => {
  const f = lockFile('dead')
  seed(f, { pid: 444, startedAt: new Date().toISOString() })
  assert.deepEqual(acquireLock(f, { pid: 555, alive: () => false }), { ok: true })
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, 555)
})

test('a lock older than the limit is stale even if its pid is alive (pid reuse), and so is a garbled one', () => {
  const old = lockFile('old')
  seed(old, { pid: 666, startedAt: new Date(Date.now() - MAX_AGE_MS - 1000).toISOString() })
  assert.equal(acquireLock(old, { pid: 1, alive: () => true }).ok, true)
  const bad = lockFile('bad')
  fs.mkdirSync(path.dirname(bad), { recursive: true }); fs.writeFileSync(bad, '{half')
  assert.equal(acquireLock(bad, { pid: 1, alive: () => true }).ok, true)
})

test('release removes only our own lock', () => {
  const f = lockFile('release')
  seed(f, { pid: 777, startedAt: new Date().toISOString() })
  releaseLock(f, 888)
  assert.ok(fs.existsSync(f))
  releaseLock(f, 777)
  assert.ok(!fs.existsSync(f))
})

// Real processes: a tiny script that takes the lock the way backup-all does, then ends in the way under test.
const runner = path.join(tmp, 'runner.mjs')
fs.writeFileSync(runner, `import { holdLockUntilExit } from ${JSON.stringify(pathToFileURL(path.join(here, 'lock.mjs')).href)}
holdLockUntilExit(process.argv[2])
if (process.argv[3] === 'throw') throw new Error('boom')
if (process.argv[3] === 'exit1') process.exit(1)
`)
for (const how of ['ok', 'throw', 'exit1']) {
  test(`the lock is gone after a run that ends by: ${how}`, () => {
    const f = lockFile('run-' + how)
    const r = spawnSync(process.execPath, [runner, f, how], { encoding: 'utf8' })
    assert.equal(r.status === 0, how === 'ok', r.stderr)
    if (how !== 'ok') assert.match(r.stderr, how === 'throw' ? /boom/ : /^$/) // the run really started, so the lock really existed
    assert.ok(!fs.existsSync(f))
  })
}

test('backup-all refuses while another run is alive: exit 2, status files untouched, lock kept', () => {
  const root = path.join(tmp, 'backup-root')
  const status = path.join(root, 'status')
  fs.mkdirSync(status, { recursive: true })
  const files = { 'database.json': '{"ok":true}', 'covered.json': '{"through":"x"}', 'all.json': '{"code":true}' }
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(status, n), c)
  const lock = path.join(status, 'backup-all.lock')
  const h = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) // this test process is alive
  fs.writeFileSync(lock, h)
  const r = spawnSync(process.execPath, [path.join(here, 'backup-all.mjs')], { encoding: 'utf8', env: { ...process.env, BOE_BACKUP_ROOT: root } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, new RegExp(`already running \\(process ${process.pid}`))
  for (const [n, c] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(status, n), 'utf8'), c)
  assert.equal(fs.readFileSync(lock, 'utf8'), h)
  assert.deepEqual(fs.readdirSync(status).sort(), [...Object.keys(files), 'backup-all.lock'].sort())
})
