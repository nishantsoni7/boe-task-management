// scripts/google/website-leads-to-boe.gs, run in Node with Google's services faked. Every name and number is made up.
// Run: npm run test:file -- scripts/google/website-leads-to-boe.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./website-leads-to-boe.gs', import.meta.url), 'utf8')
const HEAD = ['', 'form-type', 'your-name', 'your-email', 'your-tel', 'your-location', 'your-textarea', '']

function load({ rows, props = {}, answer = 200 }) {
  const store = { ...props }
  const sent = []
  const triggers = []
  const grid = [HEAD, ...rows]
  const sheet = {
    getLastRow: () => grid.length,
    getLastColumn: () => HEAD.length,
    getRange: (r, c, n, w) => ({ getValues: () => grid.slice(r - 1, r - 1 + n).map(row => row.slice(c - 1, c - 1 + w)) }),
  }
  const ctx = {
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (_alg, text) => [...createHash('md5').update(text).digest()].map(b => (b > 127 ? b - 256 : b)),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] ?? null, setProperty: (k, v) => { store[k] = v } }) },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: name => (name === 'all_leads' ? sheet : null) }) },
    ScriptApp: {
      getProjectTriggers: () => [...triggers], deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: fn => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => triggers.push({ fn, m }) }) }) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        sent.push({ url, auth: opts.headers.Authorization, rows: JSON.parse(opts.payload).rows })
        return { getResponseCode: () => answer, getContentText: () => 'error' }
      },
    },
    Logger: { log: () => {} },
  }
  vm.createContext(ctx)
  vm.runInContext(SOURCE, ctx)
  return { ctx, store, sent, triggers, grid }
}

const row = (n, extra = {}) => ['', extra.type ?? '', `Name ${n}`, `p${n}@mail.test`, `90000000${String(n).padStart(2, '0')}`, 'Pune', `Message ${n}`, 'Mohit']

test('setup starts from the rows already there and runs every five minutes', () => {
  const { ctx, store, triggers } = load({ rows: [row(1), row(2)], props: { CAPTURE_KEY: 'k' } })
  ctx.setup()
  assert.equal(store.LAST_ROW, '3')
  assert.deepEqual(triggers, [{ fn: 'sendNewLeads', m: 5 }])
})

test('setup refuses to start without the key', () => {
  const { ctx } = load({ rows: [] })
  assert.throws(() => ctx.setup(), /CAPTURE_KEY/)
})

test('only the rows after the last run are sent, with the key, and the place moves on', () => {
  const { ctx, store, sent } = load({ rows: [row(1), row(2), row(3, { type: 'Google Ads' }), ['', '', 'No number', '', '', '', '', '']], props: { CAPTURE_KEY: 'secret', LAST_ROW: '2' } })
  ctx.sendNewLeads()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].auth, 'Bearer secret')
  assert.deepEqual(sent[0].rows.map(r => r.name), ['Name 2', 'Name 3'])
  assert.equal(sent[0].rows[1].form_type, 'Google Ads')
  assert.match(sent[0].rows[0].key, /^[0-9a-f]{32}$/)
  assert.equal(store.LAST_ROW, '5')
})

test('a row sent again carries the same key', () => {
  const a = load({ rows: [row(1)], props: { CAPTURE_KEY: 'k', LAST_ROW: '1' } })
  a.ctx.sendNewLeads()
  const b = load({ rows: [row(1)], props: { CAPTURE_KEY: 'k', LAST_ROW: '1' } })
  b.ctx.sendNewLeads()
  assert.equal(a.sent[0].rows[0].key, b.sent[0].rows[0].key)
})

test('if BOE One cannot take them, the place stays and they go again next time', () => {
  const { ctx, store, sent } = load({ rows: [row(1), row(2)], props: { CAPTURE_KEY: 'k', LAST_ROW: '1' }, answer: 503 })
  ctx.sendNewLeads()
  assert.equal(sent.length, 1)
  assert.equal(store.LAST_ROW, '1')
})

test('nothing new, nothing sent; 250 new rows go in three calls', () => {
  const idle = load({ rows: [row(1)], props: { CAPTURE_KEY: 'k', LAST_ROW: '2' } })
  idle.ctx.sendNewLeads()
  assert.equal(idle.sent.length, 0)
  const many = load({ rows: Array.from({ length: 250 }, (_, i) => row(i % 100)), props: { CAPTURE_KEY: 'k', LAST_ROW: '1' } })
  many.ctx.sendNewLeads()
  assert.deepEqual(many.sent.map(s => s.rows.length), [100, 100, 50])
  assert.equal(many.store.LAST_ROW, '251')
})
