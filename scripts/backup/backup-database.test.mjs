import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The database export ended "terminated" on a different big table almost every night. This runs the real script against a
// small fake of the Supabase REST API that cuts a response off half way, the way the real one does, and checks every table
// still arrives complete, that the retries are recorded, and that a refused table is still reported rather than retried.

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-backup-db-test-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const TOTAL = 2300
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, note: 'row ' + (i + 1) }))
const tables = { widgets: rowsOf(TOTAL), gadgets: rowsOf(TOTAL) }
const cutOnce = new Set() // widgets: the first read of rows 1000-1999 is cut off, the second works
const requests = []

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (status, body, headers = {}) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers })
    res.end(text)
  }
  if (url.pathname === '/rest/v1/') {
    const pk = { id: { description: 'Note: This is a Primary Key.<pk/>' } }
    return json(200, { definitions: { widgets: { properties: pk }, gadgets: { properties: pk }, secrets: { properties: pk } } })
  }
  if (url.pathname === '/auth/v1/admin/users') return json(200, { users: [] })
  const name = url.pathname.replace('/rest/v1/', '')
  if (name === 'secrets') return json(403, { code: '42501', message: 'permission denied for table secrets' })
  const [from, to] = req.headers.range.split('-').map(Number)
  const size = to - from + 1
  requests.push({ name, from, size })
  const rows = tables[name].slice(from, to + 1)
  const text = JSON.stringify(rows)
  const range = { 'Content-Range': rows.length ? `${from}-${from + rows.length - 1}/${TOTAL}` : `*/${TOTAL}` }
  const cutWidgets = name === 'widgets' && from === 1000 && !cutOnce.has(name)
  const cut = cutWidgets || (name === 'gadgets' && size >= 1000 && from > 0)
  res.writeHead(206, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...range })
  if (!cut) return res.end(text)
  if (cutWidgets) cutOnce.add(name)
  res.write(text.slice(0, 40)) // headers and a piece of the body, then the connection dies: fetch reports "terminated"
  setTimeout(() => res.destroy(), 20)
})

test('a page cut off half way is read again and every table still arrives complete', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  after(() => server.close())
  const envFile = path.join(tmp, 'env')
  fs.writeFileSync(envFile, `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${server.address().port}\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_test\n`)
  const backupRoot = path.join(tmp, 'backups', 'boe-task-management')
  const child = spawn(process.execPath, [path.join(here, 'backup-database.mjs'), '--no-storage', '--plain'], {
    env: { ...process.env, BOE_ENV_FILE: envFile, BOE_DEV_ROOT: tmp, BOE_BACKUP_ROOT: backupRoot, BOE_MAIN_REPO: tmp, BACKUP_RETRY_WAIT_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 0, out)

  const dbDir = path.join(backupRoot, 'database')
  const snapshot = path.join(dbDir, fs.readdirSync(dbDir)[0])
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'MANIFEST.json'), 'utf8'))
  assert.deepEqual(manifest.errors, [])
  assert.equal(manifest.tables.widgets.rows, TOTAL)
  assert.equal(manifest.tables.gadgets.rows, TOTAL)
  assert.deepEqual(manifest.unreadable, ['secrets'])
  assert.equal(manifest.retried.widgets, 1)
  assert.equal(manifest.retried.gadgets, 2) // 1000 rows cut off twice, then 250 rows worked and stayed the size for the rest of the table
  assert.match(out, /RETRY widgets from row 1000: try 1\/6 at 1000 rows failed \(terminated \(UND_ERR_SOCKET/)
  assert.doesNotMatch(out, /TABLES NOT EXPORTED/)
  assert.equal(requests.filter((q) => q.name === 'gadgets' && q.size === 250).length, 6) // rows 1000-2299 at 250 a page: no second try at 1000 rows
})
