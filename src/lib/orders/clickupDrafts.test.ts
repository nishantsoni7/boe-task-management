/**
 * Draft Orders (ClickUp), 20270713000000: the pure rules, then source pins for
 * what a running test cannot see here (the routes need a Next request), then the
 * migration's text. The migration itself is executed in a PGlite rehearsal
 * (supabase/tests/clickup_draft_orders_pglite.mjs).
 *
 * The fixtures are invented; the real orders are customer data and never enter
 * the repository.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clientNameOf, draftFilePath, draftWorkbook, formatBytes, inr, isClickupId, isFileId, istToIso, orderedFields, parseSaveOrder, statusLabel,
  type DraftOrder,
} from './clickupDrafts'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

// ClickUp names a file '<uuid>.<extension>'; this is that shape, invented.
const FILE_ID = '3f2c1a9e-5b7d-4c8e-9a10-0123456789ab.xlsx'

const backupOrder = () => ({
  clickup_id: '86abc123',
  custom_id: 'BOE-1',
  name: '535 Acme Sample',
  order_no: '535',
  status: 'Running Orders',
  created_at: '2026-10-01 17:32:00',
  updated_at: '2026-10-02 09:00:00',
  closed_at: '',
  start_date: '',
  due_date: '2026-11-06',
  created_by: 'Uploader One',
  assignees: ['Salesperson One'],
  tags: ['commission'],
  priority: '',
  description: 'Deliver in two lots.',
  fields: { 'Confirm Date': '2026-09-30', 'Total Product Value': '361900', 'Phone': '+91 90000 00000', Empty: '', 'FABRIC STATUS': 'FABRIC PENDING' },
  checklists: [{ name: 'Pack', items: [{ name: 'Tag', resolved: true }, { name: 'Box', resolved: false }] }],
  subtasks: [],
  status_history: [{ status: 'running orders', since: '2026-10-01 17:32:00' }],
  comments: [{ id: '9', at: '2026-10-01 17:39:57', by: 'Uploader One', reply_to: null, text: 'PI attached' }],
  files: [{ id: FILE_ID, name: '535 Acme ji.XLSX', uploaded_at: '2026-10-01 17:39:56', uploaded_by: 'Uploader One', bytes: 2346671, sha256: 'a'.repeat(64), file: 'files/535 Acme [86abc123]/2026-10-01_535 Acme ji.XLSX' }],
})

describe('times, names and paths', () => {
  test('ClickUp times are IST and become real instants', () => {
    assert.equal(istToIso('2026-10-01 17:39:56'), '2026-10-01T12:09:56.000Z')
    assert.equal(istToIso('2026-10-01'), '2026-09-30T18:30:00.000Z', 'a plain date is the start of that IST day')
    assert.equal(istToIso(''), null)
    assert.equal(istToIso('not a date'), null)
    assert.equal(istToIso(undefined), null)
  })

  test('the client is the name without its order number', () => {
    assert.equal(clientNameOf('535 Acme'), 'Acme')
    assert.equal(clientNameOf('532-Asha Rao Outdoor'), 'Asha Rao Outdoor')
    assert.equal(clientNameOf('475. Acme..DPS, Garden Extension'), 'Acme..DPS, Garden Extension')
    assert.equal(clientNameOf('511 - Ravi Sir Pune'), 'Ravi Sir Pune')
    assert.equal(clientNameOf('Walk-in client'), 'Walk-in client')
    assert.equal(clientNameOf('535'), '535', 'a name that is only a number stays')
  })

  test('a file lives at <task>/<file id>, whatever its name holds', () => {
    assert.equal(draftFilePath('86abc', FILE_ID), '86abc/' + FILE_ID)
    assert.equal(draftFilePath('86abc', 'plain'), '86abc/plain')
  })

  test('ids are plain: nothing that can climb out of a folder', () => {
    for (const ok of ['86abc123', 'a_b-c', '14zcebrv0z6']) assert.equal(isClickupId(ok), true)
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(65), 12, null, undefined]) assert.equal(isClickupId(bad), false)
  })

  test('a file id is a plain id with at most one short extension, never a path', () => {
    for (const ok of [FILE_ID, 'abc', 'a_b-c.pdf']) assert.equal(isFileId(ok), true)
    for (const bad of ['', '../x.xlsx', 'a/b', '.hidden', 'a..b', 'a.b.c', 'x.waytoolongext', 'a b.pdf', 12, null]) assert.equal(isFileId(bad), false)
  })
})

describe('what a save accepts', () => {
  test('a good order becomes a row, with IST times as instants and the client taken from the name', () => {
    const parsed = parseSaveOrder(backupOrder())
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const { row } = parsed
    assert.equal(row.clickup_id, '86abc123')
    assert.equal(row.order_no, '535')
    assert.equal(row.client_name, 'Acme Sample')
    assert.equal(row.status, 'running orders', 'status is stored lower case')
    assert.equal(row.created_in_clickup, '2026-10-01T12:02:00.000Z')
    assert.equal(row.closed_in_clickup, null)
    assert.equal(row.due_date, '2026-11-06')
    assert.equal(row.start_date, null)
    assert.deepEqual(row.fields, { 'Confirm Date': '2026-09-30', 'Total Product Value': '361900', Phone: '+91 90000 00000', 'FABRIC STATUS': 'FABRIC PENDING' }, 'an empty field is dropped')
    assert.deepEqual(row.files, [{ id: FILE_ID, name: '535 Acme ji.XLSX', uploaded_at: '2026-10-01T12:09:56.000Z', uploaded_by: 'Uploader One', size: 2346671, sha256: 'a'.repeat(64) }])
    assert.equal(row.comments[0].at, '2026-10-01T12:09:57.000Z')
    assert.equal(row.checklists[0].items[1].resolved, false)
  })

  test('the file path the browser sent is never kept: only ids and sizes are', () => {
    const parsed = parseSaveOrder(backupOrder())
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    assert.equal(JSON.stringify(parsed.row).includes('files/535 Acme'), false)
  })

  test('refusals say what is wrong', () => {
    const bad = (patch: Record<string, unknown>) => parseSaveOrder({ ...backupOrder(), ...patch })
    assert.equal(parseSaveOrder(null).ok, false)
    assert.equal(parseSaveOrder([]).ok, false)
    assert.equal(bad({ clickup_id: '../x' }).ok, false)
    assert.equal(bad({ name: '   ' }).ok, false)
    assert.equal(bad({ files: [{ id: 'a/b', name: 'x', bytes: 1 }] }).ok, false)
    assert.equal(bad({ files: [{ id: FILE_ID, name: 'x' }] }).ok, false, 'a file with no size')
    assert.equal(bad({ files: [{ id: FILE_ID, name: 'x', bytes: -1 }] }).ok, false)
  })

  test('sizes are capped, so one request cannot hold a book', () => {
    const parsed = parseSaveOrder({
      ...backupOrder(),
      description: 'd'.repeat(200000),
      comments: Array.from({ length: 6000 }, (_, i) => ({ id: String(i), at: '', by: 'x', text: 't'.repeat(30000) })),
      fields: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`F${i}`, 'v'.repeat(9000)])),
    })
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    assert.equal(parsed.row.description.length, 100000)
    assert.equal(parsed.row.comments.length, 5000)
    assert.equal(parsed.row.comments[0].text.length, 20000)
    assert.equal(Object.keys(parsed.row.fields).length, 200)
    assert.equal(Object.values(parsed.row.fields)[0].length, 5000)
  })

  test('a malformed sha256 is stored as none rather than trusted', () => {
    const parsed = parseSaveOrder({ ...backupOrder(), files: [{ id: FILE_ID, name: 'x.pdf', bytes: 5, sha256: 'zz' }] })
    assert.ok(parsed.ok)
    if (parsed.ok) assert.equal(parsed.row.files[0].sha256, '')
  })
})

describe('what the screens show', () => {
  test('the first fields are the ones people look for', () => {
    const names = orderedFields({ Zebra: '1', 'Total Product Value': '2', Alpha: '3', Phone: '4', 'Confirm Date': '5' }).map(([k]) => k)
    assert.deepEqual(names, ['Confirm Date', 'Total Product Value', 'Phone', 'Alpha', 'Zebra'])
  })

  test('labels, sizes and rupees', () => {
    assert.equal(statusLabel('hold'), 'On hold')
    assert.equal(statusLabel('ready for dispatch'), 'Ready for dispatch')
    assert.equal(statusLabel('something new'), 'Something new')
    assert.equal(statusLabel(''), '—')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2346671), '2.2 MB')
    assert.equal(inr('361900'), '₹3,61,900')
    assert.equal(inr(undefined), '—')
    assert.equal(inr('about 5 lakh'), 'about 5 lakh', 'text typed in ClickUp is shown as typed')
  })

  test('the Excel has the three sheets of the backup, one row per order, file and comment', () => {
    const parsed = parseSaveOrder(backupOrder())
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const order: DraftOrder = { ...parsed.row, id: 'u1', file_count: 1, comment_count: 1, imported_at: '2026-11-13T00:00:00Z' }
    const sheets = draftWorkbook([order])
    assert.deepEqual(sheets.map(s => s.name), ['Orders', 'Files', 'Comments'])
    assert.equal(sheets[0].rows.length, 2)
    assert.ok(sheets[0].rows[0].includes('Total Product Value'), 'every ClickUp field has a column')
    assert.equal(sheets[1].rows.length, 2)
    assert.equal(sheets[1].rows[1][2], '535 Acme ji.XLSX')
    assert.match(String(sheets[1].rows[1][3]), /2026/, 'the upload date is in the file row')
    assert.equal(sheets[2].rows.length, 2)
  })
})

describe('only an Administrator reaches the data', () => {
  const ROUTES = [
    'src/app/api/orders/clickup-drafts/route.ts',
    'src/app/api/orders/clickup-drafts/[id]/route.ts',
    'src/app/api/orders/clickup-drafts/[id]/files/[fileId]/route.ts',
    'src/app/api/orders/clickup-drafts/import/route.ts',
  ]

  test('every route asks for the Administrator before it reads or writes anything', () => {
    for (const path of ROUTES) {
      const src = read(path)
      const gate = src.indexOf('requireDraftsAdmin()')
      assert.ok(gate > 0, `${path} calls the guard`)
      for (const touch of ['.from(', '.storage', 'req.json(']) {
        const at = src.indexOf(touch)
        if (at >= 0) assert.ok(gate < at, `${path}: the guard comes before ${touch}`)
      }
    }
  })

  test('the guard is the Administrator role, checked on the signed-in session, then the service role', () => {
    const guard = read('src/app/api/orders/clickup-drafts/guard.ts')
    assert.ok(guard.includes("me?.role !== 'admin'"))
    assert.ok(guard.includes('auth.getUser()'))
    assert.ok(guard.indexOf("me?.role !== 'admin'") < guard.indexOf('adminClient()'))
  })

  test('a route file exports only what Next allows, and the import never takes a file in its body', () => {
    for (const path of ROUTES) {
      const exports = [...read(path).matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(m => m[1])
      for (const name of exports) assert.ok(['GET', 'POST', 'runtime', 'maxDuration'].includes(name), `${path} exports ${name}`)
    }
    assert.equal(read(ROUTES[3]).includes('formData('), false, 'files go straight to storage: a body over 4.5 MB never reaches a route')
  })

  test('the import writes the row last and builds paths itself', () => {
    const src = read(ROUTES[3])
    assert.ok(src.indexOf("step === 'sign'") < src.indexOf("step === 'save'"))
    assert.ok(src.indexOf('FILES_NOT_STORED') < src.indexOf(".upsert("), 'the files are checked before the row is written')
    assert.ok(src.includes('draftFilePath('))
    assert.ok(src.includes("onConflict: 'clickup_id'"), 'running it again replaces, never doubles')
    assert.ok(src.includes('upsert: true'))
  })

  test('a file opens through a short signed link under its own name', () => {
    const src = read(ROUTES[2])
    assert.ok(src.includes('createSignedUrl('))
    assert.ok(src.includes('{ download: file.name }'))
  })

  test('the sidebar entry is drawn for an Administrator only, and the pages ask the server', () => {
    const layout = read('src/components/layout/OrdersLayout.tsx')
    assert.ok(/role === 'admin'\s*\n\s*\? \[\{ label: 'Draft Orders \(ClickUp\)'/.test(layout))
    for (const page of ['page.tsx', '[id]/page.tsx', 'import/page.tsx']) {
      assert.ok(read(`src/app/orders/clickup/${page}`).includes('callDrafts'), `${page} reads through the routes`)
    }
    assert.equal(read('src/app/orders/clickup/page.tsx').includes("from 'next/link'"), false, 'pages load on click: AppLink only')
  })
})

describe('migration 20270713000000', () => {
  const sql = read('supabase/migrations/20270713000000_clickup_draft_orders.sql')

  test('the table is closed: row level security on, no policy, nothing granted', () => {
    assert.ok(sql.includes('alter table public.clickup_draft_orders enable row level security'))
    assert.ok(sql.includes('revoke all on public.clickup_draft_orders from anon, authenticated'))
    assert.equal(/create\s+policy/i.test(sql.replace(/--[^\n]*/g, '')), false)
  })

  test('the bucket is private, has no policy, and holds the biggest backed-up file (48 MB)', () => {
    assert.ok(/values \('clickup-draft-files', 'clickup-draft-files', false, 52428800, null\)/.test(sql))
    assert.equal(/on storage\.objects/i.test(sql.replace(/--[^\n]*/g, '')), false)
  })

  test('one row per ClickUp task, with counts the database keeps', () => {
    assert.ok(sql.includes('constraint clickup_draft_orders_clickup_id_key unique (clickup_id)'))
    assert.ok(sql.includes('file_count          integer generated always as (jsonb_array_length(files)) stored'))
    assert.equal(/drop |truncate |delete from public/i.test(sql.replace(/--[^\n]*/g, '')), false, 'it destroys nothing')
  })

  test('the bucket name in SQL and in code is the same one', () => {
    assert.ok(read('src/lib/orders/clickupDrafts.ts').includes("CLICKUP_DRAFT_BUCKET = 'clickup-draft-files'"))
  })
})
