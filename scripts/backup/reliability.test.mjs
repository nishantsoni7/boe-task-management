import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeError, git, mirrorGit, PG_DUMP_TIMEOUT_MS, pgDumpFailure, readWithShrink, restrictedTablesLayer, waitForDocker } from './lib.mjs'

// Found on the hand run of 2026-11-05: the Terminal panel of the desktop app forces safe.bareRepository=explicit, a nightly
// database export died on "terminated" two nights running, and pg_dump needed a Docker Desktop that nobody had started.

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-backup-test-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// Exactly how the Terminal panel sets it: git reports the origin as "command line".
const EXPLICIT = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit' }
const withExplicit = (fn) => {
  const saved = Object.fromEntries(Object.keys(EXPLICIT).map((k) => [k, process.env[k]]))
  Object.assign(process.env, EXPLICIT)
  try { return fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)/).slice(1).map(Number)
const knowsExplicit = gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 38)

function makeSource(name) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one']]) execFileSync('git', a, { cwd: dir })
  return dir
}

test('the mirror helpers work where git refuses to find a bare repository from its folder', () => {
  const src = makeSource('src-helpers')
  const mirror = path.join(tmp, 'helpers-mirror.git')
  execFileSync('git', ['init', '-q', '--bare', mirror])
  withExplicit(() => {
    if (knowsExplicit) assert.throws(() => git(mirror, 'config', 'gc.auto', '0'), /not in a git directory/)
    mirrorGit(mirror, 'config', 'gc.auto', '0')
    mirrorGit(mirror, 'fetch', '--quiet', '--no-tags', path.join(src, '.git'), '+refs/heads/*:refs/local/heads/*')
    assert.equal(mirrorGit(mirror, 'for-each-ref', '--format=%(refname)'), 'refs/local/heads/main')
  })
})

test('backup-code --quick builds the mirror under safe.bareRepository=explicit', () => {
  const src = makeSource('src-quick')
  const backupRoot = path.join(tmp, 'backups', 'boe-task-management')
  const r = spawnSync(process.execPath, [path.join(here, 'backup-code.mjs'), '--quick', '--repo', src], {
    env: { ...process.env, ...EXPLICIT, BOE_DEV_ROOT: tmp, BOE_BACKUP_ROOT: backupRoot, BOE_MAIN_REPO: src }, encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const status = JSON.parse(fs.readFileSync(path.join(backupRoot, 'status', 'code-quick.json'), 'utf8'))
  assert.equal(status.steps.mirrorLocal, 'ok')
  assert.ok(status.mirrorRefs >= 1)
})

test('a failure keeps its real cause in the message', () => {
  const e = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
  assert.equal(describeError(e), 'terminated (UND_ERR_SOCKET: other side closed)')
  assert.equal(describeError(new Error('HTTP 500')), 'HTTP 500')
})

const terminated = () => new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
const noWait = () => Promise.resolve()

test('a page cut off twice is read again at a smaller size and the reasons are reported', async () => {
  const seen = []; const retries = []
  const out = await readWithShrink([1000, 1000, 250], async (size) => { seen.push(size); if (seen.length < 3) throw terminated(); return 'rows' }, { onRetry: (r) => retries.push(r), wait: noWait })
  assert.deepEqual(seen, [1000, 1000, 250])
  assert.deepEqual(out, { size: 250, value: 'rows' })
  assert.equal(retries.length, 2)
  assert.match(retries[0].reason, /UND_ERR_SOCKET/)
})

test('the wait between tries grows, long enough to outlast a network that is down for a few seconds', async () => {
  const waits = []
  await assert.rejects(readWithShrink([1000, 250, 100], async () => { throw terminated() }, { wait: async (ms) => { waits.push(ms) } }))
  assert.deepEqual(waits, [5000, 10000]) // nothing is waited for after the last try; the real six tries wait 5+10+15+20+25 s
})

test('a refusal is not retried and keeps its text, so the permission case is still recognised', async () => {
  let calls = 0
  await assert.rejects(readWithShrink([1000, 250], async () => { calls++; throw new Error('HTTP 403 {"code":"42501"}') }, { isTransient: (e) => !/^HTTP 4/.test(e.message), wait: noWait }), /HTTP 403.*42501/)
  assert.equal(calls, 1)
})

test('when every size fails the error lists why', async () => {
  let calls = 0
  await assert.rejects(readWithShrink([1000, 250, 100], async () => { calls++; throw terminated() }, { wait: noWait }), /failed 3 times: terminated \(UND_ERR_SOCKET: other side closed\)$/)
  assert.equal(calls, 3)
})

function fakeDocker({ upAfterPolls }) {
  const s = { polls: 0, started: 0, clock: 0 }
  return {
    s,
    opts: {
      isUp: () => s.started > 0 && s.polls >= upAfterPolls,
      start: () => { s.started++ },
      wait: async (ms) => { s.polls++; s.clock += ms },
      now: () => s.clock,
      timeoutMs: 60000,
      pollMs: 5000,
    },
  }
}

test('docker that is already running is left alone', async () => {
  const d = fakeDocker({ upAfterPolls: 0 })
  d.opts.isUp = () => true
  assert.equal(await waitForDocker(d.opts), true)
  assert.equal(d.s.started, 0)
})

test('docker that is not running is started once and waited for', async () => {
  const d = fakeDocker({ upAfterPolls: 3 })
  assert.equal(await waitForDocker(d.opts), true)
  assert.equal(d.s.started, 1)
  assert.equal(d.s.polls, 3)
})

test('docker that never comes up is given up on after the time limit', async () => {
  const d = fakeDocker({ upAfterPolls: Infinity })
  assert.equal(await waitForDocker(d.opts), false)
  assert.equal(d.s.clock, 60000)
})

test('docker that cannot be started is not waited for', async () => {
  const d = fakeDocker({ upAfterPolls: Infinity })
  d.opts.start = () => false
  assert.equal(await waitForDocker(d.opts), false)
  assert.equal(d.s.polls, 0)
})

test('a hung pg_dump run is stopped by its time limit and says Docker is probably hung', () => {
  // The real shape of a timed-out spawnSync: a child that never finishes, cut off the way backup-database cuts docker run.
  const r = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 500, killSignal: 'SIGKILL' })
  assert.equal(r.error?.code, 'ETIMEDOUT')
  assert.match(pgDumpFailure(r, 'postgres://secret', ['t1']), /did not finish within 5 minutes.*restart it/)
  assert.equal(PG_DUMP_TIMEOUT_MS, 5 * 60 * 1000)
  assert.match(fs.readFileSync(path.join(here, 'backup-database.mjs'), 'utf8'), /spawnSync\('docker', args, .*timeout: PG_DUMP_TIMEOUT_MS/)
})

test('a failed pg_dump keeps its own error and never prints the database URL', () => {
  const r = { status: 1, stderr: Buffer.from('connecting to postgres://secret\nFATAL: password authentication failed\n') }
  assert.equal(pgDumpFailure(r, 'postgres://secret', ['t1']), 'connecting to <url> | FATAL: password authentication failed')
  assert.equal(pgDumpFailure({ status: 0, stderr: Buffer.alloc(0) }, 'u', ['t1', 't2']), 'missing t1, t2')
})

test('verify-backups fails the finance-tables layer when pg_dump did not cover them', () => {
  assert.equal(restrictedTablesLayer(null).ok, false)
  assert.deepEqual(restrictedTablesLayer({ unreadable: [], viaPgDump: ['a', 'b', 'c'] }), { ok: true, note: 'pg_dump: a b c' })
  const bad = restrictedTablesLayer({ unreadable: ['a', 'b'], viaPgDump: [] })
  assert.equal(bad.ok, false)
  assert.match(bad.note, /a b.*Docker Desktop/)
})

// The Task Scheduler result is the exit code of the .cmd's last line. It has to be the backup's own result, not the reminder pop-up's.
test('the daily .cmd exits with the backup result and leaves start and finish lines in the log', { skip: process.platform !== 'win32' }, () => {
  const run = (backupRc, verifyRc) => {
    const root = fs.mkdtempSync(path.join(tmp, 'cmd-'))
    const tools = path.join(root, 'tools'); fs.mkdirSync(tools)
    fs.copyFileSync(path.join(here, 'boe-backup-daily.cmd'), path.join(tools, 'boe-backup-daily.cmd'))
    fs.writeFileSync(path.join(tools, 'backup-all.mjs'), 'process.exit(Number(process.env.STUB_BACKUP_RC))')
    fs.writeFileSync(path.join(tools, 'verify-backups.mjs'), 'process.exit(Number(process.env.STUB_VERIFY_RC))')
    for (const f of ['pending-backups.mjs', 'owner-reminders.mjs']) fs.writeFileSync(path.join(tools, f), 'process.exit(0)')
    const r = spawnSync('cmd.exe', ['/c', path.join(tools, 'boe-backup-daily.cmd')], { env: { ...process.env, STUB_BACKUP_RC: String(backupRc), STUB_VERIFY_RC: String(verifyRc) } })
    return { rc: r.status, log: fs.readFileSync(path.join(root, 'daily-backup.log'), 'utf8') }
  }
  const ok = run(0, 0)
  assert.equal(ok.rc, 0)
  assert.match(ok.log, /BOE backup started/)
  assert.match(ok.log, /BOE backup finished: backup-all exit 0, verify exit 0/)
  const failed = run(1, 0)
  assert.equal(failed.rc, 1)
  assert.match(failed.log, /backup-all exit 1, verify exit 0/)
  assert.equal(run(0, 1).rc, 1)
})
