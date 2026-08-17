/**
 * The contract of the PI Drafts screens.
 *
 * WHAT THESE SCREENS EXIST TO FIX. A PI was uploaded in production and saved
 * correctly — row, product lines, pictures and diagnostics all written by the
 * server — and then could not be found again, because nothing listed it and no
 * route opened it. The rows were never in doubt; the way back to them was.
 *
 * Two kinds of assertion, both offline:
 *
 *   1. BEHAVIOURAL — what the view helpers answer. A saved figure must come back
 *      out meaning what it meant going in ("Included" is not "Not applicable"),
 *      a picture must land on the product it belongs to, and a status must read
 *      as words rather than as a database enum.
 *   2. SOURCE-SHAPE — what the two pages actually do, read off the files. These
 *      exist because the important properties here are again about ABSENCE:
 *      nothing is rendered from the query string, no ownership rule is
 *      re-implemented in the browser, the private bucket is never made public,
 *      and neither screen writes anything.
 *
 * Reads repository files only. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/app/orders/drafts/draftsAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import type { EffectivePermission } from '@/lib/permissions/types'
import { buildCommercialRows, buildHeaderRows, buildImageViewerItems, formatInr } from '@/lib/pi/previewView'
import {
  PI_DRAFTS_EMPTY_TEXT,
  PI_DRAFT_LIST_STATUSES,
  PI_DRAFT_STATUS_LABEL,
  describeDraftListEntry,
  draftDetailHref,
  draftSavedHref,
  draftStatusLabel,
  draftStatusTone,
  formatSavedAt,
  persistedCommercial,
  persistedCost,
  persistedDiagnostics,
  persistedHeader,
  persistedImageUrlMaps,
  persistedProducts,
  toNumber,
  type PersistedItem,
  type PersistedItemImage,
  type PersistedSubmission,
} from '@/lib/orders/draftsView'

const ROOT = process.cwd()

/** Source with its comments removed. See the note in importAccess.test.ts. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const read = (p: string) => stripComments(readFileSync(join(ROOT, p), 'utf8'))

const LIST_PAGE = 'src/app/orders/drafts/page.tsx'
const DETAIL_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const DRAFTS_VIEW = 'src/lib/orders/draftsView.ts'
const IMPORT_PAGE = 'src/app/orders/import/page.tsx'
const ORDERS_NAV = 'src/components/layout/OrdersLayout.tsx'
const ORDERS_LAYOUT = ORDERS_NAV
const PI_PARTS = 'src/components/orders/piPreview.tsx'
const ROOT_LAYOUT = 'src/app/layout.tsx'
const GLOBALS_CSS = 'src/app/globals.css'
const SUBMISSIONS_MIGRATION = 'supabase/migrations/20260908000000_order_pi_submissions.sql'
const IMAGES_MIGRATION = 'supabase/migrations/20260909000000_order_submission_item_images.sql'

const perms = (allowedActions: string[]): EffectivePermission[] =>
  allowedActions.map(actionKey => ({ actionKey, allowed: true, source: 'role' }))

// A minimal saved submission. Fields the case under test does not care about
// are null, which is also the honest state of a draft whose PI said nothing.
const submission = (over: Partial<PersistedSubmission> = {}): PersistedSubmission => ({
  id: '11111111-1111-4111-8111-111111111111',
  status: 'draft',
  client_name: 'Meridian Hotels',
  creation_date: '2026-08-10',
  source_created_by: 'Ravi',
  bill_to_name: 'Meridian Hotels',
  ship_to_name: 'Meridian Hotels — Jaipur',
  order_confirmation_date: '2026-08-12',
  dispatch_commitment: '6 weeks from date of confirmation',
  source_workbook_name: 'PI-Meridian-Aug.xlsx',
  gross_product_amount: 250000,
  discount_amount: 0,
  subtotal_after_discount: 250000,
  fabric_cost: null,
  fabric_cost_meaning: 'numeric',
  fabric_cost_text: null,
  packing_cost: 0,
  packing_cost_meaning: 'not_applicable',
  packing_cost_text: null,
  transportation_amount: null,
  transportation_text: 'as applicable',
  total_before_gst: 250000,
  gst_amount: 45000,
  grand_total: 295000,
  parse_warnings: [],
  parse_blocking_issues: [],
  review_note: null,
  created_at: '2026-08-14T06:30:00.000Z',
  updated_at: '2026-08-16T10:42:00.000Z',
  ...over,
})

const item = (over: Partial<PersistedItem> = {}): PersistedItem => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  source_row: 34,
  item_sequence: 'B001',
  product_name: 'Wingback chair',
  quantity: 4,
  dimensions: '24 x 26 x 42',
  material: 'Teak',
  customization: null,
  cost_per_piece: 12500,
  total_amount: 50000,
  sort_order: 0,
  ...over,
})

// ── Who may open the screens ──────────────────────────────────────────────────

describe('reading drafts is module entry, not create authority', () => {
  test('a viewer with only module entry may open Orders', () => {
    const caps = deriveOrdersCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessOrdersModule, true)
    assert.equal(caps.canCreateOrder, false, 'and still may not raise an order')
  })

  test('the list does not gate itself on create', () => {
    const source = read(LIST_PAGE)
    // The New Order BUTTON is gated; the list is not. A reviewer who may see
    // submissions but not raise one must still be able to read the list.
    assert.ok(source.includes('setCanCreate(caps.canCreateOrder)'))
    assert.ok(!source.includes('if (!me || !caps.canCreateOrder)'),
      'reading a draft is not the authority to create one')
    assert.ok(!source.includes("router.replace('/coming-soon')"),
      'module entry is the parent layout’s job, and it already does it')
  })

  test('the New Order entry point is still gated on create', () => {
    const source = read(LIST_PAGE)
    assert.ok(source.includes('canCreate ? ('))
    assert.ok(source.includes("router.push('/orders/import')"))
  })

  test('authority is never taken from a role literal on either screen', () => {
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      const source = read(page)
      assert.ok(!/role\s*===\s*['"]admin['"]/.test(source), `${page} must not branch on a role literal`)
      assert.ok(!/role\s*===\s*['"]manager['"]/.test(source))
    }
  })

  test('PI Drafts sits in the Orders sidebar with a document icon', () => {
    const nav = read(ORDERS_NAV)
    assert.ok(nav.includes("{ label: 'PI Drafts',"))
    assert.ok(nav.includes("path: '/orders/drafts'"))
    assert.ok(nav.includes('<FileText'))
  })
})

// ── Visibility is the database's answer, not the browser's ────────────────────

describe('row visibility is left to RLS', () => {
  test('the list filters on STATUS and on nothing else', () => {
    const source = read(LIST_PAGE)
    assert.ok(source.includes(".in('status', PI_DRAFT_LIST_STATUSES)"))
    for (const filter of ['created_by', 'submitted_by', 'assigned_to', 'session.user.id']) {
      assert.ok(!source.includes(`.eq('${filter}'`),
        `${filter} must not be filtered in the browser — order_submissions_select already decides it`)
    }
  })

  test('the detail page selects by id alone', () => {
    const source = read(DETAIL_PAGE)
    assert.ok(source.includes(".eq('id', submissionId)"))
    assert.ok(source.includes('.maybeSingle()'),
      'no row must be an ordinary outcome, not a thrown error')
    for (const filter of ['created_by', 'submitted_by', 'assigned_to']) {
      assert.ok(!source.includes(`.eq('${filter}'`), `${filter} must not be re-checked in the browser`)
    }
  })

  test('an unauthorized draft and a missing one give the SAME answer', () => {
    const source = read(DETAIL_PAGE)
    assert.ok(source.includes("if (!submission) { setLoad({ kind: 'unavailable' }); return }"),
      'no row — for either reason — is "unavailable"')
    assert.ok(source.includes("kind: 'unavailable'"))
    assert.ok(!/not\s+allowed|no\s+permission|forbidden/i.test(source),
      'the page must not confirm that a draft it cannot show exists')
  })

  test('the underlying policy still admits exactly four kinds of reader', () => {
    // The page relies on this, so a change to it should break a test here too.
    const sql = readFileSync(join(ROOT, SUBMISSIONS_MIGRATION), 'utf8')
    assert.ok(sql.includes('create policy "order_submissions_select"'))
    assert.ok(sql.includes('created_by = auth.uid()'))
    assert.ok(sql.includes('submitted_by = auth.uid()'))
    assert.ok(sql.includes('assigned_to = auth.uid()'))
    assert.ok(sql.includes("actor_has_module_permission('orders', 'approve_order')"))
  })

  test('the child tables follow the parent’s visibility', () => {
    const items = readFileSync(join(ROOT, SUBMISSIONS_MIGRATION), 'utf8')
    const images = readFileSync(join(ROOT, IMAGES_MIGRATION), 'utf8')
    assert.ok(items.includes('create policy "order_submission_items_select" on public.order_submission_items'))
    assert.ok(items.includes('using (public.can_view_order_submission(submission_id))'))
    assert.ok(images.includes('using (public.can_view_order_submission(submission_id))'))
  })
})

// ── Nothing is trusted from the browser ───────────────────────────────────────

describe('the detail page renders only what it fetched', () => {
  const source = read(DETAIL_PAGE)

  test('the query string decides a message and nothing else', () => {
    const reads = [...source.matchAll(/searchParams\.get\('([^']+)'\)/g)].map(m => m[1])
    assert.deepEqual(reads, ['saved'], 'the only query parameter read is the success flag')
    assert.ok(source.includes("const justSaved = searchParams.get('saved') === '1'"))
    assert.ok(source.includes('{justSaved && ('), 'and it gates a banner, not any data')
  })

  test('no preview or workbook state can reach this screen', () => {
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      assert.ok(!source.includes(api), `${api} must not be read on the saved-draft screen`)
    }
    for (const parser of ['parseBoePiWorkbook', 'createPiImageUrls', 'FileReader', 'arrayBuffer']) {
      assert.ok(!source.includes(parser),
        `${parser} must not appear — this screen shows the server’s reading, not a new one`)
    }
  })

  test('every rendered figure comes from the fetched row', () => {
    assert.ok(source.includes('persistedCommercial(submission)'))
    assert.ok(source.includes('persistedHeader(submission)'))
    assert.ok(source.includes('persistedProducts('))
    assert.ok(source.includes("from('order_submissions')"))
    assert.ok(source.includes("from('order_submission_items')"))
    assert.ok(source.includes("from('order_submission_item_images')"))
  })

  test('the four reads are the only tables either screen touches', () => {
    const targets = new Set<string>()
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      for (const m of read(page).matchAll(/\.from\('([^']+)'\)/g)) targets.add(m[1])
    }
    assert.deepEqual([...targets].sort(), [
      'order_submission_item_images', 'order_submission_items', 'order_submissions', 'users',
    ])
    // The one storage bucket, named through the shared constant so a second
    // bucket cannot be reached by a typo.
    assert.ok(source.includes('.from(ORDER_FILES_BUCKET)'))
    assert.ok(read(DRAFTS_VIEW).includes("ORDER_FILES_BUCKET = 'order-files'"))
  })

  test('neither screen writes anything, anywhere', () => {
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      const s = read(page)
      for (const call of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(', '.upload(']) {
        assert.ok(!s.includes(call), `${call} must not appear in ${page} — these screens are read-only`)
      }
    }
  })

  test('there is no editing path invented for a saved draft', () => {
    assert.ok(!source.includes('Change PI'),
      'replacement belongs to the upload screen, which has the workbook in hand')
    assert.ok(!source.includes('<textarea'))
    assert.ok(!source.includes('<input'))
  })

  test('no PI content reaches a log or telemetry sink', () => {
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      const s = read(page)
      for (const sink of ['console.', 'Sentry', 'datadog', 'analytics']) {
        assert.ok(!s.includes(sink), `${sink} must not appear in ${page} — a PI carries client and price data`)
      }
    }
  })

  test('a failed read says nothing about the database', () => {
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      const s = read(page)
      assert.ok(!s.includes('error.message'), `${page} must not surface a database message`)
    }
  })
})

// ── Private storage ───────────────────────────────────────────────────────────

describe('product pictures stay in the private bucket', () => {
  const source = read(DETAIL_PAGE)

  test('URLs are signed per object, through the caller’s own session', () => {
    assert.ok(source.includes('.createSignedUrls(paths, PI_DRAFT_IMAGE_URL_TTL_SECONDS)'))
    assert.ok(source.includes('.from(ORDER_FILES_BUCKET)'))
  })

  test('nothing builds a permanent or public URL', () => {
    assert.ok(!source.includes('getPublicUrl'), 'the bucket is private and stays private')
    assert.ok(!source.includes('/storage/v1/object/public/'))
  })

  test('an object the caller may not read simply has no picture', () => {
    assert.ok(source.includes('if (row?.path && row.signedUrl && !row.error)'),
      'a per-object refusal must not fail the whole page')
    assert.ok(read(DRAFTS_VIEW).includes('unresolved += 1'),
      'and it is counted rather than hidden')
  })

  test('the bucket is still declared private by the migration', () => {
    const sql = readFileSync(join(ROOT, SUBMISSIONS_MIGRATION), 'utf8')
    assert.ok(sql.includes("where id = 'order-files' and public = false"))
  })
})

// ── The list ──────────────────────────────────────────────────────────────────

describe('the drafts list', () => {
  test('approved submissions are not drafts', () => {
    assert.ok(!PI_DRAFT_LIST_STATUSES.includes('approved'),
      'an approved submission has become an Order and belongs in Confirmed Orders')
    assert.deepEqual([...PI_DRAFT_LIST_STATUSES], ['draft', 'submitted', 'needs_changes', 'rejected'])
  })

  test('every listed status has a friendly label', () => {
    for (const status of PI_DRAFT_LIST_STATUSES) {
      const label = PI_DRAFT_STATUS_LABEL[status]
      assert.ok(label && !label.includes('_'), `${status} must not be shown as a database value`)
      assert.equal(draftStatusLabel(status), label)
    }
    assert.equal(draftStatusLabel('draft'), 'Draft')
    assert.equal(draftStatusLabel('needs_changes'), 'Needs changes')
    assert.equal(draftStatusLabel('submitted'), 'Submitted for review')
    assert.equal(draftStatusLabel('rejected'), 'Rejected')
  })

  test('an unrecognised status is shown as itself, not mislabelled', () => {
    assert.equal(draftStatusLabel('something_new'), 'something_new')
    assert.equal(draftStatusTone('something_new'), 'neutral')
    assert.equal(draftStatusLabel(null), '—')
  })

  test('a row carries the client, the file, the count, the total and the time', () => {
    const entry = describeDraftListEntry(submission(), 12, formatInr)
    assert.equal(entry.client, 'Meridian Hotels')
    assert.equal(entry.reference, 'PI-Meridian-Aug.xlsx')
    assert.equal(entry.itemCount, 12)
    assert.equal(entry.itemCountLabel, '12 products')
    assert.equal(entry.grandTotal, '₹2,95,000')
    assert.equal(entry.statusLabel, 'Draft')
    assert.equal(entry.href, '/orders/drafts/11111111-1111-4111-8111-111111111111')
    assert.ok(entry.savedAt.includes('2026'), 'and when it was last written')
  })

  test('one product reads as one product', () => {
    assert.equal(describeDraftListEntry(submission(), 1, formatInr).itemCountLabel, '1 product')
    assert.equal(describeDraftListEntry(submission(), 0, formatInr).itemCountLabel, '0 products')
  })

  test('the reference is the uploaded FILE, never the number printed on it', () => {
    // The workbook's own B20 is normally the number of whatever older PI this
    // one was copied from. On a list it can only be read as this order's
    // number, and an imported PI has none until approval allocates one.
    const view = read(DRAFTS_VIEW)
    assert.ok(!view.includes('source_order_number:'),
      'source_order_number must not be selected or surfaced by these screens')
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      const s = read(page)
      assert.ok(!s.includes('source_order_number'), `${page} must not render the workbook’s own number`)
      assert.ok(!/display_number/.test(s), `${page} must not show an Order’s number either`)
    }
    // The only mention of an order number on these screens is the standing
    // statement that this record does not have one.
    assert.ok(read(DETAIL_PAGE).replace(/\s+/g, ' ').includes('no official order number'),
      'the draft states plainly that numbering happens only after approval')
  })

  test('a draft with no client name still identifies itself', () => {
    const entry = describeDraftListEntry(
      submission({ client_name: null, bill_to_name: null, source_workbook_name: null }), 0, formatInr,
    )
    assert.equal(entry.client, 'Unnamed client')
    assert.equal(entry.reference, '—')
    assert.equal(entry.grandTotal, '₹2,95,000')
  })

  test('a workbook with no grand total shows a dash, never a zero', () => {
    const entry = describeDraftListEntry(submission({ grand_total: null }), 3, formatInr)
    assert.equal(entry.grandTotal, '—', '₹0 would be a figure nobody wrote')
  })

  test('the empty state is the agreed sentence', () => {
    assert.equal(PI_DRAFTS_EMPTY_TEXT, 'No PI drafts saved yet.')
    assert.ok(read(LIST_PAGE).includes('{PI_DRAFTS_EMPTY_TEXT}'),
      'and it is rendered from the constant, not typed twice')
  })

  test('the empty state is shown only for a successful, empty read', () => {
    const source = read(LIST_PAGE)
    assert.ok(source.includes('failed ? failureState : (entries && entries.length === 0 ? emptyState'),
      'a failed load must never be reported as "no drafts saved yet"')
  })

  test('the item count cannot be silently truncated by PostgREST', () => {
    const source = read(LIST_PAGE)
    assert.ok(source.includes('fetchAllRows'),
      'a capped response would print a wrong product count with total confidence')
    assert.ok(source.includes('if (!items.ok || items.truncated)'))
    assert.ok(source.includes(".order('id', { ascending: true })"),
      'paging needs a deterministic order on a unique column')
  })

  test('the list is newest first', () => {
    assert.ok(read(LIST_PAGE).includes(".order('updated_at', { ascending: false })"))
  })

  test('a phone gets rows it can actually use', () => {
    const source = read(LIST_PAGE)
    assert.ok(source.includes('isMobile ? cards : table'))
    assert.ok(source.includes('MOBILE_BREAKPOINT = 768'))
  })
})

// ── Money and meaning survive the round trip ──────────────────────────────────

describe('a saved commercial figure means what it meant', () => {
  test('a real charge comes back as its figure', () => {
    const value = persistedCost(1450, 'numeric', null, 'I117')
    assert.equal(value.amount, 1450)
    assert.equal(value.zeroMeaning, null)
  })

  test('"not applicable" and "included" stay different facts', () => {
    const notApplicable = persistedCost(0, 'not_applicable', null, 'I117')
    const included = persistedCost(0, 'included', 'Inclusive', 'I118')

    assert.equal(notApplicable.zeroMeaning, 'notApplicable')
    assert.equal(included.zeroMeaning, 'included')
    assert.notEqual(notApplicable.zeroMeaning, included.zeroMeaning,
      'both add zero, and they are opposite answers to "was the client charged?"')
    assert.equal(included.text, 'Inclusive', 'the workbook’s own wording is kept')
  })

  test('an unresolved note keeps its words and claims no amount', () => {
    const value = persistedCost(null, 'text', 'to be confirmed', 'I117')
    assert.equal(value.amount, null)
    assert.equal(value.text, 'to be confirmed')
  })

  test('the rendered rows are the stored figures, unchanged', () => {
    const rows = buildCommercialRows(persistedCommercial(submission()))
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]))

    assert.equal(byKey.gross.value, '₹2,50,000')
    assert.equal(byKey.subtotal.value, '₹2,50,000')
    assert.equal(byKey.packing.value, 'Not applicable', 'a dash in the PI is not ₹0')
    assert.equal(byKey.transportation.value, 'as applicable', 'words are kept as words')
    assert.equal(byKey.gst.value, '₹45,000')
    assert.equal(byKey.grandTotal.value, '₹2,95,000')
    assert.equal(byKey.grandTotal.emphasis, 'total')
  })

  test('the required advance is derived from the stored grand total', () => {
    const rows = buildCommercialRows(persistedCommercial(submission()))
    const advance = rows.find(r => r.key === 'advance')
    assert.ok(advance)
    assert.equal(advance.value, '₹1,18,000', '40% of ₹2,95,000')
    assert.equal(advance.emphasis, 'advance')
    assert.ok(advance.note?.includes('No payment'), 'and it is never presented as a payment')
  })

  test('a missing grand total yields no advance rather than a guess', () => {
    const rows = buildCommercialRows(persistedCommercial(submission({ grand_total: null })))
    assert.equal(rows.find(r => r.key === 'advance')?.value, '—')
    assert.equal(rows.find(r => r.key === 'grandTotal')?.value, '—')
  })

  test('a numeric column that arrives as a string is still a number', () => {
    assert.equal(toNumber('295000.00'), 295000)
    assert.equal(toNumber(0), 0)
    assert.equal(toNumber(''), null)
    assert.equal(toNumber(null), null)
    assert.equal(toNumber('not a number'), null)
  })

  test('the same rows builder serves both screens', () => {
    // Identical inputs, identical output — which is the property that keeps a
    // draft looking the same before and after it was saved.
    const rows = buildCommercialRows(persistedCommercial(submission()))
    assert.deepEqual(rows.map(r => r.key), [
      'gross', 'discount', 'subtotal', 'fabric', 'packing',
      'transportation', 'beforeGst', 'gst', 'grandTotal', 'advance',
    ])
  })
})

// ── The header ────────────────────────────────────────────────────────────────

describe('the stored header', () => {
  test('shows the same fields the import preview shows', () => {
    const rows = buildHeaderRows(persistedHeader(submission()))
    assert.deepEqual(rows.map(r => r.key),
      ['client', 'created', 'createdBy', 'billTo', 'shipTo', 'confirmed', 'dispatch'])
  })

  test('dates are re-spelled, never re-zoned', () => {
    const rows = buildHeaderRows(persistedHeader(submission()))
    assert.equal(rows.find(r => r.key === 'created')?.value, '10 Aug 2026')
    assert.equal(rows.find(r => r.key === 'confirmed')?.value, '12 Aug 2026')
  })

  test('a dispatch commitment in words stays in words', () => {
    const rows = buildHeaderRows(persistedHeader(submission()))
    assert.equal(rows.find(r => r.key === 'dispatch')?.value, '6 weeks from date of confirmation')
  })

  test('the workbook’s own order number cannot reach the header', () => {
    assert.equal(persistedHeader(submission()).sourceOrderNumber, null)
  })

  test('an empty header renders dashes, not blanks', () => {
    const rows = buildHeaderRows(persistedHeader(submission({
      client_name: null, bill_to_name: null, ship_to_name: null,
      creation_date: null, source_created_by: null,
      order_confirmation_date: null, dispatch_commitment: null,
    })))
    for (const row of rows) assert.equal(row.value, '—')
  })

  test('the saved time is stamped in Indian business time', () => {
    assert.ok(read(DRAFTS_VIEW).includes("timeZone: 'Asia/Kolkata'"))
    assert.equal(formatSavedAt(null), '—')
    assert.equal(formatSavedAt('not a date'), '—')
    assert.ok(/\d{2} \w{3} 2026, \d{2}:\d{2} (AM|PM)/.test(formatSavedAt('2026-08-16T10:42:00.000Z')))
  })
})

// ── Products and their pictures ───────────────────────────────────────────────

describe('the stored product lines', () => {
  test('keep the workbook’s own order', () => {
    const products = persistedProducts([
      item({ id: 'c', source_row: 36, sort_order: 2 }),
      item({ id: 'a', source_row: 34, sort_order: 0 }),
      item({ id: 'b', source_row: 35, sort_order: 1 }),
    ])
    assert.deepEqual(products.map(p => p.id), ['a', 'b', 'c'])
  })

  test('material and customization stay separate fields', () => {
    const [product] = persistedProducts([item({ material: 'Teak', customization: 'Brass caps' })])
    assert.equal(product.material, 'Teak')
    assert.equal(product.customization, 'Brass caps')
  })

  test('an empty cell is null, so the table can show its dash', () => {
    const [product] = persistedProducts([item({ dimensions: '   ', customization: '' })])
    assert.equal(product.dimensions, null)
    assert.equal(product.customization, null)
  })
})

describe('pictures land on the product they belong to', () => {
  const products = persistedProducts([
    item({ id: 'item-a', source_row: 34, sort_order: 0 }),
    item({ id: 'item-b', source_row: 35, sort_order: 1, item_sequence: 'B002', product_name: 'Console' }),
  ])

  const image = (over: Partial<PersistedItemImage>): PersistedItemImage => ({
    item_id: 'item-a', role: 'representative', position: 0, storage_path: 'p/rep-a.png', ...over,
  })

  test('the representative picture and the customization pictures are separated by ROLE', () => {
    const urls = persistedImageUrlMaps(products, [
      image({ storage_path: 'p/rep-a.png' }),
      image({ role: 'customization', position: 0, storage_path: 'p/cus-a0.png' }),
      image({ role: 'customization', position: 1, storage_path: 'p/cus-a1.png' }),
    ], new Map([
      ['p/rep-a.png', 'url-rep'],
      ['p/cus-a0.png', 'url-c0'],
      ['p/cus-a1.png', 'url-c1'],
    ]))

    assert.equal(urls.representativeByRow.get(34), 'url-rep')
    assert.deepEqual(urls.customizationByRow.get(34), ['url-c0', 'url-c1'])
  })

  test('customization pictures keep their stored position order', () => {
    const urls = persistedImageUrlMaps(products, [
      image({ role: 'customization', position: 2, storage_path: 'p/c2.png' }),
      image({ role: 'customization', position: 0, storage_path: 'p/c0.png' }),
      image({ role: 'customization', position: 1, storage_path: 'p/c1.png' }),
    ], new Map([['p/c0.png', 'u0'], ['p/c1.png', 'u1'], ['p/c2.png', 'u2']]))

    assert.deepEqual(urls.customizationByRow.get(34), ['u0', 'u1', 'u2'],
      '"customization image 2 of 3" must mean the same thing here as in the file')
  })

  test('a picture never lands on another product’s row', () => {
    const urls = persistedImageUrlMaps(products, [
      image({ item_id: 'item-b', storage_path: 'p/rep-b.png' }),
    ], new Map([['p/rep-b.png', 'url-b']]))

    assert.equal(urls.representativeByRow.get(35), 'url-b')
    assert.equal(urls.representativeByRow.get(34), undefined)
  })

  test('a picture for an item that is not on this draft is ignored', () => {
    const urls = persistedImageUrlMaps(products, [
      image({ item_id: 'item-from-somewhere-else', storage_path: 'p/x.png' }),
    ], new Map([['p/x.png', 'url-x']]))

    assert.equal(urls.representativeByRow.size, 0)
    assert.equal(urls.customizationByRow.size, 0)
  })

  test('an unsigned picture is counted, not faked', () => {
    const urls = persistedImageUrlMaps(products, [image({ storage_path: 'p/rep-a.png' })], new Map())
    assert.equal(urls.representativeByRow.size, 0, 'the table shows its honest "No image" box')
    assert.equal(urls.unresolved, 1)
  })

  test('the viewer sequence is built by the same helper the preview uses', () => {
    const urls = persistedImageUrlMaps(products, [
      image({ storage_path: 'p/rep-a.png' }),
      image({ role: 'customization', position: 0, storage_path: 'p/cus-a.png' }),
    ], new Map([['p/rep-a.png', 'url-rep'], ['p/cus-a.png', 'url-cus']]))

    const items = buildImageViewerItems(products, urls)
    assert.deepEqual(items.map(i => i.key), ['representative-34', 'customization-34-0'])
    assert.equal(items[0].roleLabel, 'Representative image')
    assert.equal(items[1].roleLabel, 'Customization image')
    assert.ok(items[0].label.startsWith('View full image for'))
  })
})

// ── Saved diagnostics ─────────────────────────────────────────────────────────

describe('what the server thought of the document is kept', () => {
  test('stored warnings are read back with their location', () => {
    const entries = persistedDiagnostics([
      { code: 'LINE_TOTAL_MISMATCH', message: 'The line total disagrees with quantity × rate.', row: 34, cell: 'I34' },
    ])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].row, 34)
    assert.equal(entries[0].cell, 'I34')
  })

  test('an entry without a code or a message is dropped, not rendered as undefined', () => {
    assert.deepEqual(persistedDiagnostics([{ code: 'X' }, { message: 'no code' }, null, 'nonsense']), [])
  })

  test('anything that is not an array is no diagnostics at all', () => {
    assert.deepEqual(persistedDiagnostics(null), [])
    assert.deepEqual(persistedDiagnostics({ code: 'X', message: 'Y' }), [])
  })

  test('the detail page shows both panels and never merges them', () => {
    const source = read(DETAIL_PAGE)
    assert.ok(source.includes('{draft.blocking.length > 0 && ('))
    assert.ok(source.includes('{draft.warnings.length > 0 && ('))
    assert.ok(source.includes('tone="red"') && source.includes('tone="amber"'))
    assert.ok(source.indexOf('draft.blocking.length > 0') < source.indexOf('draft.warnings.length > 0'),
      'blocking issues stay above the warnings')
  })

  test('a returned draft shows what the reviewer asked for', () => {
    assert.ok(read(DETAIL_PAGE).includes('{submission.review_note && ('))
  })
})

// ── The draft overview section ────────────────────────────────────────────────

describe('the draft overview reads as three bands, not a field dump', () => {
  const source = read(DETAIL_PAGE)

  test('one card, headed "Draft overview", with the status on its header line', () => {
    assert.ok(source.includes('Draft overview'))
    // The layout's own page title in the error state is still "PI Draft" — that
    // one IS the page. What is gone is the card repeating it a second time.
    assert.ok(!/<PiCardHeader\s+title="PI Draft"/.test(source),
      'the page title, its subtitle and the badge already say what this is')
    assert.ok(/<PiCardHeader[\s\S]{0,900}?draftStatusLabel\(submission\.status\)/.test(source),
      'the badge belongs to the card header')
    assert.ok(!source.includes('<PiCardHeader title="Order information" />'),
      'order information is a band inside this card, not a second card')
  })

  test('the metadata strip carries the four facts about the FILE', () => {
    for (const label of ['Last saved', 'Products', 'Created by', 'Original PI file']) {
      assert.ok(source.includes(`label="${label}"`), `${label} must be in the strip`)
    }
    assert.ok(source.includes('<MetaItem'), 'rendered as icon-and-label blocks')
  })

  test('an absent filename shows no block at all', () => {
    // A labelled hole is worse than the absence it reports. The Rivoli draft has
    // no stored filename, which is exactly the case this covers.
    assert.ok(source.includes("const workbookName = submission.source_workbook_name?.trim() || null"))
    assert.ok(source.includes('{workbookName && ('),
      'the block is conditional on there being a name')
    assert.ok(source.includes('`repeat(${workbookName ? 4 : 3}, minmax(0, 1fr))`'),
      'and the strip closes up to three columns rather than leaving a gap')
  })

  test('order information is three columns, not six', () => {
    assert.ok(source.includes("gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))'"),
      'six auto-filled columns is what scattered the fields in the first place')
  })

  test('the two rows group the fields that belong together', () => {
    const order = ['client', 'billTo', 'shipTo', 'created', 'confirmed', 'dispatch']
        .map(key => source.indexOf(`headerValue('${key}')`))
    assert.ok(order.every(i => i > -1), 'all six fields are rendered')
    assert.deepEqual([...order].sort((a, b) => a - b), order,
      'who it is for first, then when it happens')
  })

  test('client and destination read heavier than the dates', () => {
    for (const key of ['client', 'billTo', 'shipTo']) {
      assert.ok(new RegExp(`headerValue\\('${key}'\\)} strong`).test(source),
        `${key} is part of the primary row`)
    }
    for (const key of ['created', 'confirmed', 'dispatch']) {
      assert.ok(!new RegExp(`headerValue\\('${key}'\\)} strong`).test(source),
        `${key} stays in the quieter secondary row`)
    }
  })

  test('a missing value says so instead of showing a bare dash', () => {
    assert.ok(source.includes("value.trim() === '—'"))
    assert.ok(source.includes('Not provided'))
    assert.ok(source.includes('fontStyle: \'italic\''), 'in subtle muted text')
  })

  test('every value still comes from the shared header builder', () => {
    // The arrangement is this page's; the wording, the date formatting and the
    // rule that the workbook's own order number never appears are still the
    // shared helper's, so the two PI screens cannot disagree.
    assert.ok(source.includes('const headerRows = buildHeaderRows(persistedHeader(submission))'))
    assert.ok(source.includes("headerRows.find(row => row.key === key)?.value ?? '—'"))
  })

  test('nothing that the old card showed has been lost', () => {
    for (const fact of [
      'label="Last saved"', 'label="Products"', 'label="Created by"',
      "headerValue('client')", "headerValue('billTo')", "headerValue('shipTo')",
      "headerValue('created')", "headerValue('confirmed')", "headerValue('dispatch')",
      '{submission.review_note && (',
    ]) {
      assert.ok(source.includes(fact), `${fact} must survive the redesign`)
    }
  })

  test('"Created by" is stated once, in the strip', () => {
    assert.equal(source.split('Created by').length - 1, 1,
      'it is a fact about the document, so it does not also sit among the order fields')
    assert.ok(!source.includes("headerValue('createdBy')"))
  })

  test('the section uses red as an accent only', () => {
    // One 15px icon. No coloured panel, no tinted band behind the fields.
    assert.ok(source.includes('<FileText size={15} strokeWidth={1.9} color={colors.red} />'))
    assert.ok(!/background: colors\.redTint[\s\S]{0,200}Draft overview/.test(source))
  })
})

// ── Thumbnails ────────────────────────────────────────────────────────────────

describe('thumbnails are large enough to tell two chairs apart', () => {
  const parts = read(PI_PARTS)

  test('the sizes are defined once and shared by both PI screens', () => {
    assert.ok(parts.includes('export const PI_THUMBNAIL_SIZE = {'))
    assert.ok(parts.includes('representative: 84'))
    assert.ok(parts.includes('representativeCompact: 72'))
    assert.ok(parts.includes('customization: 56'))
    assert.ok(parts.includes('customizationCompact: 48'))
    for (const page of [DETAIL_PAGE, IMPORT_PAGE]) {
      assert.ok(read(page).includes('PI_THUMBNAIL_SIZE'), `${page} uses the shared table`)
    }
  })

  test('the representative thumbnail is within the agreed desktop range', () => {
    const size = Number(/representative: (\d+)/.exec(parts)?.[1])
    assert.ok(size >= 80 && size <= 88, `expected 80–88px, got ${size}`)
  })

  test('the customization thumbnail is within its own range', () => {
    const size = Number(/\n  customization: (\d+)/.exec(parts)?.[1])
    assert.ok(size >= 52 && size <= 60, `expected 52–60px, got ${size}`)
  })

  test('a phone gets smaller ones, so a product line stays one readable card', () => {
    const compact = Number(/representativeCompact: (\d+)/.exec(parts)?.[1])
    const desktop = Number(/representative: (\d+)/.exec(parts)?.[1])
    assert.ok(compact < desktop)
    assert.ok(compact >= 64, 'but still big enough to identify the product')
  })

  test('growing them changed nothing about how a picture is fitted', () => {
    assert.ok(parts.includes("objectFit: 'contain'"))
    assert.ok(!parts.includes("objectFit: 'cover'"))
    assert.ok(parts.includes("borderRadius: '6px'"), 'the rounded box is retained')
    assert.ok(parts.includes('width: size, height: size'), 'and it is still square')
  })

  test('the customization accent and the click both survive', () => {
    assert.ok(parts.includes('accent="customization"'))
    assert.ok(parts.includes('CUSTOMIZATION_BORDER'))
    assert.ok(parts.includes('onClick={onOpen}'))
    assert.ok(parts.includes("cursor: 'zoom-in'"))
  })

  test('the full-size viewer is untouched', () => {
    assert.ok(parts.includes('PI_VIEWER_IMAGE_MAX_HEIGHT'))
    assert.ok(parts.includes('PI_VIEWER_IMAGE_MAX_WIDTH'))
    assert.ok(parts.includes("height: '100dvh'"))
  })
})

// ── The font build fix ────────────────────────────────────────────────────────

describe('no font is fetched from Google for the display face', () => {
  const layout = read(ROOT_LAYOUT)
  const css = read(GLOBALS_CSS)

  test('Syne is no longer loaded through next/font/google', () => {
    // This is the exact module the production build failed to resolve:
    //   [next]/internal/font/google/syne_aea35505.module.css
    assert.ok(!/import \{[^}]*\bSyne\b[^}]*\} from 'next\/font\/google'/.test(layout),
      'the Syne loader must be gone from the import')
    assert.ok(!layout.includes('Syne({'), 'and no loader call may remain')
    assert.ok(!layout.includes('syne.variable'), 'nor the variable it produced')
  })

  test('the families that did build are untouched', () => {
    assert.ok(layout.includes("import { DM_Sans, DM_Mono, Inter } from 'next/font/google'"),
      'only the family that failed was removed')
    for (const v of ['dmSans.variable', 'dmMono.variable', 'inter.variable']) {
      assert.ok(layout.includes(v), `${v} must still be applied`)
    }
  })

  test('display text falls back to a face the app actually loads', () => {
    assert.ok(css.includes("--font-display: 'Syne', var(--font-body), sans-serif;"),
      'a locally-installed Syne is still preferred; otherwise the app’s own body face')
    const hardCoded = css.match(/font-family: 'Syne'/g) ?? []
    assert.equal(hardCoded.length, 0,
      'no rule may ask for a family name that nothing registers')
  })

  test('no font binary was added to the repository', () => {
    // Fetching a brand face from an unverified source is not a decision a build
    // fix gets to make. If Syne is wanted back, a licensed file plus
    // next/font/local is the supported route.
    assert.ok(!layout.includes('next/font/local'),
      'no local loader was introduced without a licensed file to point it at')
  })
})

// ── Returning to the tab ──────────────────────────────────────────────────────

describe('coming back to the tab does not reload anything', () => {
  const layout = read(ORDERS_LAYOUT)
  const source = read(DETAIL_PAGE)

  test('the Orders layout no longer refreshes on visibilitychange', () => {
    // THE DEFECT THIS PINS. The layout used to call handleRefresh() every time
    // the document became visible. On a record page that meant glancing at
    // another tab and coming back blanked the screen, lost the scroll position
    // and closed an open image viewer.
    assert.ok(!layout.includes('visibilitychange'),
      'returning to a tab is not a request for anything')
    assert.ok(!layout.includes("addEventListener('focus'"))
    assert.ok(!layout.includes('pageshow'))
  })

  test('no PI screen listens for focus or visibility either', () => {
    for (const page of [DETAIL_PAGE, LIST_PAGE, IMPORT_PAGE]) {
      const s = read(page)
      for (const trigger of ['visibilitychange', "addEventListener('focus'", 'pageshow', 'router.refresh()']) {
        assert.ok(!s.includes(trigger), `${page} must not re-fetch on ${trigger}`)
      }
    }
  })

  test('window listeners on the detail page are for layout only', () => {
    // The one listener that remains is the width probe that chooses the mobile
    // layout. It sets a breakpoint flag and fetches nothing.
    const listeners = [...source.matchAll(/addEventListener\('([^']+)'/g)].map(m => m[1])
    assert.deepEqual(listeners, ['resize'])
    assert.ok(source.includes('setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)'))
  })

  test('React Query does not refetch on focus anywhere', () => {
    assert.ok(read('src/components/layout/Providers.tsx').includes('refetchOnWindowFocus: false'),
      'so the badge counts agree with the layout')
  })

  test('the initial load still happens on mount', () => {
    assert.ok(source.includes('await loadDraft()'),
      'arriving at the page still reads the record')
    assert.ok(source.includes('}, [submissionId])'),
      'and re-reads only when the route id changes')
  })

  test('the manual refresh control still re-reads, in place', () => {
    assert.ok(source.includes('onRefresh={() => loadDraft({ quiet: true })}'),
      'the header control is still wired to a real re-read')
    assert.ok(source.includes('if (!quiet) setLoad({ kind: \'loading\' })'),
      'and a refresh keeps the record on screen instead of blanking it')
  })

  test('only the first load shows the full-screen loading state', () => {
    assert.ok(source.includes("if (load.kind === 'loading') return <LoadingScreen />"))
    // A quiet re-read never enters that state, so nothing can flash, no scroll
    // position is lost, and an open viewer is not unmounted underneath somebody.
    assert.ok(source.includes('quiet = false'))
  })

  test('the viewer is closed only by its own controls', () => {
    const closers = [...source.matchAll(/setViewerIndex\(null\)/g)]
    assert.equal(closers.length, 1, 'exactly one place closes the viewer: closeViewer')
    assert.ok(source.includes('const closeViewer = useCallback'))
  })
})

// ── The route ─────────────────────────────────────────────────────────────────

describe('the draft route', () => {
  test('is built in one place', () => {
    assert.equal(draftDetailHref('abc'), '/orders/drafts/abc')
    assert.equal(draftSavedHref('abc'), '/orders/drafts/abc?saved=1')
  })

  test('is where Save Draft goes', () => {
    assert.ok(read(IMPORT_PAGE).includes('router.push(draftSavedHref(success.submissionId))'))
  })

  test('the detail page lives at the matching file path', () => {
    // A route that exists only in a helper string is a 404 waiting to happen.
    assert.ok(readFileSync(join(ROOT, DETAIL_PAGE), 'utf8').includes('export default function PiDraftDetailPage'))
    assert.ok(readFileSync(join(ROOT, LIST_PAGE), 'utf8').includes('export default function PiDraftsPage'))
  })

  test('the detail page reads its id from the route, not from a query string', () => {
    const source = read(DETAIL_PAGE)
    assert.ok(source.includes('const submissionId = params.submissionId as string'))
  })
})
