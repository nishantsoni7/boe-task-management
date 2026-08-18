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
import { UPLOAD_PI_BUTTON_LABEL } from '@/lib/orders/submissionWorkflow'
import type { EffectivePermission } from '@/lib/permissions/types'
import { buildCommercialRows, buildHeaderRows, buildImageViewerItems, formatInr } from '@/lib/pi/previewView'
import {
  PI_DRAFTS_EMPTY_NOTE,
  PI_DRAFTS_EMPTY_TEXT,
  PI_DRAFTS_SUBTITLE,
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
/**
 * The rest of the detail SCREEN.
 *
 * The page kept everything with authority behind it — the reads, the capability
 * derivation, the RPCs, the image signing — and handed the drawing to two
 * page-owned modules beside it. A guard about what the screen RENDERS therefore
 * reads `detailScreen()`; a guard about what it FETCHES, WRITES or DECIDES still
 * reads DETAIL_PAGE alone, which is the stronger statement of the two.
 */
const DETAIL_SECTIONS = 'src/app/orders/drafts/[submissionId]/piDetailSections.tsx'
const DETAIL_VIEW = 'src/app/orders/drafts/[submissionId]/piDetailView.ts'
const detailScreen = (): string =>
  [DETAIL_PAGE, DETAIL_SECTIONS, DETAIL_VIEW].map(read).join('\n')
const REVIEW_MODALS = 'src/components/orders/piReviewModals.tsx'
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

/** The employee whose submission the fixtures below belong to. */
const OWNER = '99999999-9999-4999-8999-999999999999'

// A minimal saved submission. Fields the case under test does not care about
// are null, which is also the honest state of a draft whose PI said nothing.
const submission = (over: Partial<PersistedSubmission> = {}): PersistedSubmission => ({
  id: '11111111-1111-4111-8111-111111111111',
  status: 'draft',
  client_name: 'Meridian Hotels',
  created_by: OWNER,
  submitted_by: OWNER,
  submitted_at: null,
  rejected_by: null,
  rejected_at: null,
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
  // No advance requirement was declared. That is the honest state of a record
  // saved before Phase B, and of every draft until it is submitted.
  advance_condition: null,
  advance_exception_percent: null,
  advance_exception_reason: null,
  advance_exception_status: null,
  advance_exception_requested_by: null,
  advance_exception_requested_at: null,
  advance_exception_decided_by: null,
  advance_exception_decided_at: null,
  advance_exception_rejection_reason: null,
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
    assert.ok(source.includes('{justSaved && <PiSavedStrip />}'),
      'and it gates one confirmation strip, not any data')
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

  test('the reads are the only tables either screen touches', () => {
    const targets = new Set<string>()
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      for (const m of read(page).matchAll(/\.from\('([^']+)'\)/g)) targets.add(m[1])
    }
    // order_submission_activity joined the list when the history section did,
    // and `users` is read to turn actor ids into names. Nothing else.
    assert.deepEqual([...targets].sort(), [
      'order_submission_activity',
      'order_submission_item_images', 'order_submission_items', 'order_submissions', 'users',
    ])
    // The one storage bucket, named through the shared constant so a second
    // bucket cannot be reached by a typo.
    assert.ok(source.includes('.from(ORDER_FILES_BUCKET)'))
    assert.ok(read(DRAFTS_VIEW).includes("ORDER_FILES_BUCKET = 'order-files'"))
  })

  test('neither screen writes a table, a row or a file — ever', () => {
    for (const page of [LIST_PAGE, DETAIL_PAGE]) {
      const s = read(page)
      for (const call of ['.insert(', '.update(', '.upsert(', '.delete(', '.upload(']) {
        assert.ok(!s.includes(call),
          `${call} must not appear in ${page} — every write goes through a database function`)
      }
    }
  })

  test('the list stays entirely read-only', () => {
    assert.ok(!read(LIST_PAGE).includes('.rpc('),
      'a list is a list; every decision is taken on the record itself')
  })

  test('the only writes on the record page are the status RPCs', () => {
    // THE POINT OF THIS ASSERTION. Each of these moves a submission between
    // states and writes nothing else — no price, no product line, no image
    // mapping. Those come only from the server's own re-parse through
    // replace_order_submission_parse, which no browser can execute. A name
    // appearing here that is not on this list would mean the screen had grown a
    // write of its own.
    //
    // submit_order_submission_with_advance is the same submission carrying the
    // employee's optional reply AND their advance declaration; it is one line
    // over the same internal function the Phase A doors call, so none of them
    // can diverge in what they check.
    //
    // The two advance decisions are on this list and the PI's own approval is
    // NOT: settling one commercial term is a real RPC, and approving the PI is
    // a step that does not exist in this phase.
    const rpcs = [...new Set([...source.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1]))].sort()
    assert.deepEqual(rpcs, [
      'approve_pi_advance_exception',
      'reject_order_submission',
      'reject_pi_advance_exception',
      'request_order_submission_changes',
      'submit_order_submission_with_advance',
    ])
    for (const forbidden of ['approve_order_submission', 'allocate', 'payment', 'finance']) {
      assert.ok(!rpcs.some(name => name.includes(forbidden)),
        `${forbidden} belongs to no phase this page can reach`)
    }
    assert.ok(!source.includes('replace_order_submission_parse'),
      'the parsed-data writer is service-role only and unreachable from here')
    assert.ok(!/approve_order_submission/.test(source),
      'there is no approval RPC in this phase, so nothing may call one')
  })

  test('the PI itself is still never edited on this screen', () => {
    // Change PI is a LINK to the upload screen carrying this submission's id.
    // It is not a second parser, a second upload or a second persistence path.
    assert.ok(source.includes('changePiHref(submissionId)'),
      'replacement routes to the screen that has the workbook, the parser and the lease')
    assert.ok(!source.includes('parseBoePiWorkbook'))
    assert.ok(!source.includes("type=\"file\""), 'no file picker lives on the record page')
    // The one free-text field in the flow is the reviewer's note, and it lives
    // in the dialog component — never beside a price or a product line.
    assert.ok(!source.includes('<textarea'),
      'a note is typed in the decision dialog, not on the record')
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
    assert.equal(draftStatusLabel('needs_changes'), 'Needs Changes')
    assert.equal(draftStatusLabel('submitted'), 'Submitted for Review')
    assert.equal(draftStatusLabel('rejected'), 'Rejected')
    assert.equal(draftStatusLabel('approved'), 'Approved')
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
    assert.ok(/numbering begins after management approval/.test(read(DETAIL_VIEW)),
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

  test('the page no longer claims that nothing here has been submitted', () => {
    // It became a false statement the day submission shipped: this list now
    // holds submitted, returned and rejected records, and for a reviewer it
    // holds the queue as well.
    const source = read(LIST_PAGE)
    assert.ok(!/Nothing here has been submitted/i.test(source))
    assert.ok(!/Nothing is submitted\s+for approval at this stage/i.test(source))
    assert.ok(!/Nothing is submitted for approval at this stage/i.test(PI_DRAFTS_EMPTY_NOTE))
    assert.ok(!/nothing here has been submitted/i.test(PI_DRAFTS_SUBTITLE))
    assert.ok(source.includes('{PI_DRAFTS_SUBTITLE}') || source.includes('subtitle={PI_DRAFTS_SUBTITLE}'),
      'the subtitle is a constant, so the sentence and its test read the same string')
  })

  test('the empty state is shown only for a successful, empty read', () => {
    const source = read(LIST_PAGE)
    assert.ok(source.includes('{failed ? failureState : (entries && entries.length === 0 ? ('),
      'a failed load must never be reported as "no drafts saved yet"')
    const failureAt = source.indexOf('failed ? failureState')
    const emptyAt = source.indexOf('entries.length === 0', failureAt)
    assert.ok(failureAt > -1 && emptyAt > failureAt,
      'the failure branch is decided before the emptiness branch')
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
    assert.ok(source.includes('(isMobile ? listCards : listTable)('),
      'both sections choose the same way, so the queue is as usable as the list')
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
    const sections = read(DETAIL_SECTIONS)
    assert.ok(sections.includes('tone="red"') && sections.includes('tone="amber"'))
    assert.ok(source.indexOf('draft.blocking.length > 0') < source.indexOf('draft.warnings.length > 0'),
      'blocking issues stay above the warnings')
    // And both are now above and below the products respectively: what blocks a
    // submission is beside the control it blocks, and what is merely worth
    // checking is out of the way of it.
    // `read` strips comments, so the products section is located by the shared
    // table head it renders rather than by the comment above it.
    assert.ok(source.indexOf('<PiBlockingPanel') < source.indexOf('<PiProductTableHead'))
    assert.ok(source.indexOf('<PiWarningPanel') > source.indexOf('<PiProductTableHead'))
  })

  test('a returned draft shows what the reviewer asked for', () => {
    assert.ok(read(DETAIL_PAGE).includes('reviewNote={submission.review_note}'),
      'the stored note reaches the workflow panel')
    assert.ok(read(DETAIL_SECTIONS).includes('{reviewNote && ('),
      'and is rendered only when there is one')
  })
})

// ── The page identity and the order overview ──────────────────────────────────
//
// WHAT REPLACED WHAT. The card this section used to describe was headed "Draft
// overview" and carried three bands: a status badge, a strip of facts about the
// FILE, and the order's own fields. It was an improvement on the field dump
// before it and it was still the wrong shape for this page: the top of a wide
// monitor was mostly empty, and the two facts a person actually opens a PI for —
// what it is worth, and on what advance condition — were nowhere near it.
//
// The identity is now a STRIP on the page ground (state, size, when, which
// file), and the card beneath it has three meaningful SECTIONS rather than
// bands: who and where, when, and the commercial snapshot. Everything the old
// card showed is still shown; what changed is where, and how much weight each
// fact carries.

describe('the page identity is a strip, not a card that repeats the title', () => {
  const screen = detailScreen()
  const page = read(DETAIL_PAGE)

  test('the layout header carries the client, and stops there', () => {
    assert.ok(page.includes('title={clientLabel}'))
    assert.ok(!page.includes('subtitle='),
      '"Saved PI submission · Draft" restated the badge one line below it')
    assert.ok(!/<PiCardHeader\s+title="PI Draft"/.test(page))
    assert.ok(!screen.includes('Draft overview'),
      'a fourth restatement of what this record is')
  })

  test('the status badge sits with the identity, above the overview', () => {
    assert.ok(page.includes('<PiIdentityStrip'))
    assert.ok(page.includes('statusLabel={draftStatusLabel(submission.status)}'))
    assert.ok(page.includes('const tone = statusTone(draftStatusTone(submission.status))'),
      'the badge takes the drafts list’s own status vocabulary')
    assert.ok(page.includes('tone={tone}'))
    assert.ok(page.indexOf('<PiIdentityStrip') < page.indexOf('<PiOrderOverview'))
  })

  test('the strip carries the facts the old metadata band carried', () => {
    const view = read(DETAIL_VIEW)
    for (const fact of ['product line', 'Saved ', 'Submitted ', 'PI by ']) {
      assert.ok(view.includes(fact), `${fact} must survive the redesign`)
    }
    assert.ok(page.includes('documentAuthor,'),
      'including whoever the PI document itself named')
  })

  test('an absent filename shows no block at all', () => {
    // A labelled hole is worse than the absence it reports. The Rivoli draft has
    // no stored filename, which is exactly the case this covers.
    assert.ok(page.includes("const workbookName = submission.source_workbook_name?.trim() || null"))
    assert.ok(read(DETAIL_SECTIONS).includes('{workbookName && ('),
      'the block is conditional on there being a name')
  })

  test('the file is a quiet treatment, never a heading or a control', () => {
    const sections = read(DETAIL_SECTIONS)
    const file = sections.slice(sections.indexOf('pi-detail-identity-file'))
    assert.ok(!file.slice(0, 400).includes('<button'))
  })
})

describe('the order overview is three sections, not a grid of unrelated facts', () => {
  const page = read(DETAIL_PAGE)
  const sections = read(DETAIL_SECTIONS)
  const view = read(DETAIL_VIEW)

  test('the three sections are client-and-delivery, timeline, commercial snapshot', () => {
    for (const label of ['Client &amp; delivery', 'Timeline', 'Commercial snapshot']) {
      assert.ok(sections.includes(label), `${label} must be one of the three`)
    }
    assert.equal((sections.match(/<section className="pi-detail-overview-section/g) ?? []).length, 3)
  })

  test('the client is not repeated inside the card that sits under its own title', () => {
    assert.ok(page.includes("omitDash(headerValue('billTo'))"))
    assert.ok(page.includes("omitDash(headerValue('shipTo'))"))
    assert.ok(!page.includes("headerValue('client')"),
      'Bill to and Ship to carry the destinations the reader actually compares')
    assert.ok(!page.includes("headerValue('createdBy')"),
      'and the document author is a fact about the file, stated once on the strip')
  })

  test('the order dates are still the shared builder’s, in the same words', () => {
    for (const key of ['created', 'confirmed', 'dispatch']) {
      assert.ok(page.includes(`headerValue('${key}')`), `${key} must survive the redesign`)
    }
    assert.ok(page.includes('const headerRows = buildHeaderRows(persistedHeader(submission))'))
    assert.ok(page.includes("headerRows.find(row => row.key === key)?.value ?? '—'"))
  })

  test('a value the PI never gave costs no space at all', () => {
    // It used to render a muted italic "Not provided" under its label, which was
    // right while the labels were fixed — and wrong once three of them were
    // optional and usually absent together. The em dash the shared builder
    // returns still becomes an honest null; the null is now simply not drawn.
    assert.ok(view.includes("trimmed === '—'"))
    assert.ok(!view.includes('Not provided'))
    assert.ok(!sections.includes('Not provided'))
    assert.ok(sections.includes('{hasDates && ('), 'an empty section is not rendered')
    assert.ok(sections.includes('{billTo !== null &&'))
    assert.ok(sections.includes('{shipTo !== null &&'))
  })

  test('and the card re-columns around what is left', () => {
    assert.ok(sections.includes('const groups = 1 + (hasDelivery ? 1 : 0) + (hasDates ? 1 : 0)'))
    assert.ok(sections.includes('`pi-detail-overview pi-detail-overview-${groups}`'),
      'so a wide monitor never reserves a column-shaped hole')
  })

  test('the last-saved time is stated once, on the strip and not again', () => {
    assert.ok(/Last saved/.test(view) === false && /Last saved/.test(sections) === false,
      'the timeline band carries the ORDER’s dates, not the file’s')
    assert.ok(view.includes('`Saved ${input.savedAt}`'))
  })

  test('the commercial snapshot is built from the shared advance helper', () => {
    assert.ok(page.includes('const snapshot = buildCommercialSnapshot({'))
    assert.ok(page.includes('grandTotal: grandTotalLabel'))
    assert.ok(page.includes('advance,'))
    // Not one figure is derived here: the standard requirement and the proposed
    // amount both come out of describeAdvance, which uses the one formula.
    for (const arithmetic of ['* 0.4', 'Math.round', '/ 100']) {
      assert.ok(!view.includes(arithmetic),
        `${arithmetic} must not appear — this module chooses words, not amounts`)
    }
  })

  test('the section spends red as an accent, never as a panel', () => {
    assert.ok(!/background: colors\.redTint/.test(
      sections.slice(sections.indexOf('PiOrderOverview'), sections.indexOf('PiWorkflowPanel'))),
      'no tinted band behind the overview fields')
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

// ── Phase A: the controls, the queue and the history ──────────────────────────

describe('the record page draws controls from one rule, and from nothing else', () => {
  const source = read(DETAIL_PAGE)

  test('every control branches on the shared helper', () => {
    assert.ok(source.includes('const actions = describeSubmissionActions({'))
    // ONE PANEL NOW, not an employee card and a reviewer card and an advance
    // card. The helper's answer is handed to it whole, and the panel draws the
    // employee's controls from actions.canSubmit / canChangePi and the
    // reviewer's from actions.canRequestChanges / canReject. There is no third
    // rule anywhere.
    assert.equal((source.match(/<PiWorkflowPanel/g) ?? []).length, 1)
    assert.ok(source.includes('actions={actions}'))
    const sections = read(DETAIL_SECTIONS)
    assert.ok(sections.includes('const isReviewer = actions.canRequestChanges || actions.canReject'))
    assert.ok(sections.includes('const ownerActions = actions.canSubmit || actions.canChangePi'))
    assert.ok(!/status === 'submitted' &&\s*canReview/.test(source),
      'no second, looser copy of the rule in a JSX condition')
    assert.ok(!sections.includes('canReview'),
      'a presentational section is never handed a raw capability')

    // The advance decision has its OWN rule, from its own helper, because the
    // two authorities are independent: somebody may hold
    // orders.approve_advance_exception without orders.approve_order.
    assert.ok(source.includes('const advanceActions = describeAdvanceActions({'))
    assert.ok(source.includes('canDecideException: canDecideAdvance'))
    assert.ok(source.includes('canDecide={advanceActions.canDecide}'),
      'and the two exception controls are gated on it alone')
    assert.ok(!/advance_exception_status === 'pending'/.test(source),
      'no second, looser copy of the pending rule in a JSX condition')
  })

  test('capabilities are resolved for the signed-in account', () => {
    assert.ok(source.includes('getEffectivePermissions(supabase, session.user.id, \'orders\')'))
    assert.ok(source.includes('setCanReview(caps.canApproveOrderSubmission)'))
    assert.ok(source.includes('setCanDecideAdvance(caps.canApproveAdvanceException)'),
      'the exception authority is resolved from its own capability, never from canReview')
    assert.ok(source.includes('setViewerId(session.user.id)'),
      'ownership compares the signed-in id, never a View As target')
    assert.ok(source.includes('.catch(() => [])'),
      'a failed permission read must deny rather than admit')
  })

  test('final PI approval is ABSENT, not disabled', () => {
    const source = detailScreen()
    // It used to be a <span> with a lock and an explanation. Manual review found
    // people reading it as the current approval action rather than as a promise
    // about a later phase, which is the one thing a disabled control must not
    // do. There is no approval RPC to reach in this phase, so the honest answer
    // is nothing at all; Phase C introduces a real, unambiguous control.
    assert.ok(!source.includes('APPROVE_BUTTON_LABEL'))
    assert.ok(!source.includes('APPROVE_DISABLED_REASON'))
    assert.ok(!/onClick=\{[^}]*approveSubmission/i.test(source),
      'and there is still no approval RPC behind anything')
    assert.ok(source.includes('APPROVE_EXCEPTION_BUTTON_LABEL'),
      'while the advance exception, which IS decidable, keeps its distinct label')
    // The constant itself stays accurate for whoever renders it next.
    assert.ok(read('src/lib/orders/submissionWorkflow.ts').includes('APPROVE_DISABLED_REASON'))
  })

  test('a second click cannot start a second write', () => {
    assert.ok(source.includes('if (actingRef.current) return'),
      'a ref, because state updates are async and two clicks share a tick')
    assert.ok(source.includes('actingRef.current = true'))
    assert.ok(source.includes('actingRef.current = false'))
    assert.ok(source.includes('acting={acting}'), 'and the panel is told')
    assert.ok(read(DETAIL_SECTIONS).includes('disabled={acting'),
      'so every control shows it')
  })

  test('a success re-reads the record quietly', () => {
    assert.ok(source.includes('await loadDraft({ quiet: true })'),
      'the status, the banner and the history come from the persisted row')
    assert.ok(!source.includes('window.location.reload'))
    assert.ok(!source.includes('router.refresh()'),
      'and the page is not blanked, so the scroll position and an open viewer survive')
  })

  test('a failure shows a fixed sentence, never the database’s own message', () => {
    assert.ok(source.includes('describeSubmissionFailure(error, action).message'))
    assert.ok(!source.includes('error.message'),
      'the raw message never reaches this file, let alone the screen')
  })

  test('Change PI routes to the upload screen with this submission’s id', () => {
    assert.ok(source.includes('router.push(changePiHref(submissionId))'))
    assert.ok(!source.includes('/orders/import?'),
      'the link is built by the helper, not hand-assembled beside it')
  })
})

describe('the submitter and the submission time are shown', () => {
  const source = read(DETAIL_PAGE)

  test('the time comes from the column the database writes', () => {
    assert.ok(source.includes('submission.submitted_at ? formatSavedAt(submission.submitted_at) : null'))
    assert.ok(read(DRAFTS_VIEW).includes("'submitted_by', 'submitted_at'"),
      'and the list selects it too, for the queue order')
  })

  test('the name is batch-fetched, not one query per row', () => {
    assert.ok(source.includes('activityActorIds(history, ['))
    for (const id of ['row.submitted_by', 'row.rejected_by',
                      'row.advance_exception_requested_by', 'row.advance_exception_decided_by']) {
      assert.ok(source.includes(id), `${id} must be resolved in the same users read`)
    }
    assert.ok(source.includes(".in('id', actorIds)"), 'one read for every name on the page')
    assert.ok(source.includes(".select('id, full_name')"),
      'named safe columns: select(*) on public.users is a permission error')
  })

  test('who moved the record last is metadata, not a paragraph', () => {
    // The banner card went in the redesign and its SENTENCE went in the
    // refinement: "Waiting for your decision", "Nothing on this PI can be
    // changed while it is under review" and the rest were generic prose beside
    // controls that already said it. What is left is one quiet line.
    assert.ok(!source.includes('describeSubmissionBanner'))
    assert.ok(read(DETAIL_VIEW).includes("function actorLine("))
    assert.ok(read(DETAIL_SECTIONS).includes('{panel.meta}'))
    for (const id of ['submitterName: draft.submitterName', 'rejectedByName: draft.rejectedByName']) {
      assert.ok(source.includes(id), `${id} still reaches the panel`)
    }
  })

  test('the management note keeps its own place, rendered verbatim', () => {
    assert.ok(source.includes('reviewNote={submission.review_note}'))
    const sections = read(DETAIL_SECTIONS)
    assert.ok(sections.includes('{reviewNote && ('))
    assert.ok(sections.includes('heading={panel.noteHeading}'),
      'the same column carries both decisions, so the heading says which wrote it')
    assert.ok(read(DETAIL_VIEW).includes("REJECTED_NOTE_HEADING = 'Why this was rejected'"))
    assert.ok(sections.includes('<MultilineText'), 'somebody’s own words, not collapsed')
  })
})

describe('the activity history', () => {
  const source = read(DETAIL_PAGE)

  test('is read under the same RLS as everything else, and paged', () => {
    assert.ok(source.includes(".from('order_submission_activity')"))
    assert.ok(source.includes('fetchAllRows<PersistedActivity>'),
      'a silently capped response would look like a complete history')
    assert.ok(source.includes(".order('id', { ascending: true })"),
      'paging needs a deterministic order on a unique column')
  })

  test('shows the action, the actor, the time and any note', () => {
    const sections = read(DETAIL_SECTIONS)
    for (const field of ['{entry.label}', '{entry.actor}', '{entry.at}', '{entry.note}']) {
      assert.ok(sections.includes(field), `${field} belongs on an activity row`)
    }
  })

  test('shows no id and no raw metadata', () => {
    const screen = detailScreen()
    assert.ok(!screen.includes('entry.metadata'))
    assert.ok(!/\{entry\.(id|submissionId|actorId|action)\}/.test(screen))
    assert.ok(!screen.includes('previous_status'))
    // The trail's marker colour is a NAME the activity module chose, so no
    // build of this screen can print an enum by looking one up itself.
    assert.ok(read(DETAIL_SECTIONS).includes('TIMELINE_MARKER[entry.tone]'))
    assert.ok(!read(DETAIL_SECTIONS).includes("'submitted'"))
  })
})

describe('the drafts list carries the review queue', () => {
  const source = read(LIST_PAGE)

  test('the split is the shared helper’s, and only a reviewer gets one', () => {
    assert.ok(source.includes('splitDraftsForReview(entries ?? [], canReview)'))
    assert.ok(source.includes('reviewerRef.current = caps.canApproveOrderSubmission'))
    assert.ok(source.includes('const reviewSection = canReview && ('))
  })

  test('the queue is still the same RLS-filtered read, not a second query', () => {
    const froms = [...source.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    assert.equal(froms.filter(t => t === 'order_submissions').length, 1,
      'one read of the submissions; the sections are a rendering decision')
    assert.ok(!source.includes(".eq('status', 'submitted')"),
      'and no second, narrower server filter for the queue')
  })

  test('a queue row says who submitted it and when', () => {
    assert.ok(source.includes('{entry.submittedAt}'))
    assert.ok(source.includes('{entry.submitter}'))
    assert.ok(source.includes('renderList(review, REVIEW_ACTION_LABEL, true)'),
      'and its action is Review PI, from the shared constant')
    assert.ok(source.includes("renderList(working, 'Open Draft', false)"),
      'while the working list keeps the wording it had')
  })

  test('names are read only when there is a queue to read', () => {
    assert.ok(source.includes('reviewerRef.current\n      ? [...new Set(rows.filter(r => r.status === \'submitted\''),
      'an employee’s own list names nobody, so the query is skipped')
  })

  test('no navigation entry or dashboard was added', () => {
    const nav = read(ORDERS_NAV)
    assert.ok(!nav.includes('/orders/review'))
    assert.ok(!nav.includes('Approvals'))
    const items = [...nav.matchAll(/\{ label: '([^']+)',\s*path:/g)].map(m => m[1])
    assert.deepEqual(items, ['Dashboard', 'Confirmed Orders', 'Order Requests', 'PI Drafts'],
      'one page, and the sidebar is untouched')
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

// ── The way in to the importer ────────────────────────────────────────────────

describe('PI Drafts offers Upload PI', () => {
  const source = read(LIST_PAGE)

  test('the header carries it for a holder of orders.create', () => {
    assert.ok(source.includes('actions={canCreate ? ('), 'gated on the create capability')
    assert.ok(source.includes('{UPLOAD_PI_BUTTON_LABEL}'))
    assert.ok(source.includes('className="boe-btn boe-btn-primary"'), 'the existing primary style')
  })

  test('the empty state carries it too, because that is where a person starts', () => {
    const emptyBlock = source.slice(source.indexOf('const emptyState = ('))
      .slice(0, source.slice(source.indexOf('const emptyState = (')).indexOf('const failureState'))
    assert.ok(emptyBlock.includes('canCreate && ('), 'and it is gated there as well')
    assert.ok(emptyBlock.includes('{UPLOAD_PI_BUTTON_LABEL}'))
  })

  test('a view-only user is offered no upload action anywhere', () => {
    // Both call sites are inside a canCreate gate; neither renders a disabled
    // control, which would only invite a click that the database refuses.
    const uses = [...source.matchAll(/\{UPLOAD_PI_BUTTON_LABEL\}/g)]
    assert.equal(uses.length, 2, 'exactly two: the header and the empty state')
    const gates = [...source.matchAll(/canCreate(\s*\?\s*\(|\s*&&\s*\()/g)]
    assert.equal(gates.length, 2, 'each one behind its own gate')
    assert.ok(!source.includes('disabled={!canCreate}'), 'hidden, not disabled')
  })

  test('the two never stack on a phone', () => {
    // The empty state exists only when there are no rows, and the header button
    // is the one a person with records uses. They are never on screen together,
    // so a narrow viewport cannot show two identical primary buttons.
    assert.ok(source.includes('entries && entries.length === 0 ? ('),
      'the empty state is rendered only for an empty list')
  })

  test('both go to the importer through one named helper', () => {
    assert.ok(source.includes("const goToImport = () => router.push('/orders/import')"))
    const pushes = [...source.matchAll(/router\.push\('\/orders\/import'\)/g)]
    assert.equal(pushes.length, 1, 'the destination is written once')
    assert.equal([...source.matchAll(/onClick=\{goToImport\}/g)].length, 2)
  })

  test('the label says what the control does', () => {
    // "Upload PI", not "New Order": an order comes into existence at approval,
    // with a number, and this button cannot reach that.
    assert.equal(UPLOAD_PI_BUTTON_LABEL, 'Upload PI')
    assert.ok(!source.includes('New Order'), 'the old promise is gone')
  })
})

// ── The employee's reply on a resubmission ────────────────────────────────────

describe('the resubmission reply reaches the database and the trail', () => {
  const source = read(DETAIL_PAGE)

  test('the field is offered only when management asked for changes', () => {
    assert.ok(source.includes('offerReply={submissionOffersReply(submission.status)}'),
      'the gate is the shared helper, not an inline status comparison')
  })

  test('one door carries the reply and the advance declaration together', () => {
    // Phase B replaced the two-door choice with one: the reply and the advance
    // condition travel on the same call, so a submission cannot land with one
    // recorded and the other lost. p_note is still nullable, so an employee with
    // nothing to add submits exactly as they did before.
    assert.ok(source.includes("await supabase.rpc('submit_order_submission_with_advance', {"))
    assert.ok(source.includes('p_note: note,'))
    assert.ok(source.includes('p_advance_condition: advance.condition,'))
    assert.ok(source.includes("p_advance_percent: advance.condition === 'exception' ? advance.percent : null,"),
      'the standard requirement sends no percentage, exactly as the RPC demands')
    assert.ok(source.includes("p_advance_reason: advance.condition === 'exception' ? advance.reason : null,"))
  })

  test('double submission is still prevented on every path', () => {
    // Every door runs through the same runAction, which holds the ref.
    assert.ok(source.includes("=> runAction('submit'"))
    assert.ok(source.includes("runAction('approve_exception'"))
    assert.ok(source.includes("runAction('reject_exception'"))
    assert.ok(source.includes('if (actingRef.current) return'))
  })

  test('the reply is never rendered from the record — it lives on the event', () => {
    assert.ok(!source.includes('submission.employee_note'))
    assert.ok(!source.includes('employee_reply'),
      'there is no new column and no second note field on the record')
  })

  test('Activity already renders it, with the note styling management notes use', () => {
    // The trail's note is rendered once, for every action that carries one —
    // a reviewer's request, a rejection reason, and now an employee's reply.
    // No new UI was needed, which is why there is no second styling to drift.
    const sections = read(DETAIL_SECTIONS)
    assert.ok(sections.includes('{entry.note}'))
    assert.ok(sections.includes("borderLeft: `2px solid ${colors.border}`"),
      'the same left-rule treatment for every note on the trail')
    const noteBlocks = [...sections.matchAll(/\{entry\.note && \(/g)]
    assert.equal(noteBlocks.length, 1, 'one renderer, not one per action')
    // The reviewer ALSO sees the current reply in the workflow panel, because
    // that is where they are being asked to decide. It is read off the same
    // trail entry rather than off the record, which still has no column for it.
    assert.ok(read(DETAIL_PAGE).includes('latestSubmissionReply(draft.activity)'))
  })
})

// ── Phase B: the advance requirement on screen ────────────────────────────────
//
// WHO SEES WHAT. The three audiences share one section and differ in exactly one
// thing — whether the two decision controls are drawn — because the STATE of a
// commercial condition is part of the record's story and hiding it from somebody
// who can read the PI would leave them wondering why it is waiting.

describe('the advance requirement is shown to everybody and decided by few', () => {
  const source = read(DETAIL_PAGE)

  test('the band is one component, drawn once, inside the one workflow panel', () => {
    assert.equal((source.match(/<PiAdvanceBand/g) ?? []).length, 1,
      'one component, so the employee view and the reviewer view cannot drift')
    assert.equal((source.match(/advanceBand=\{/g) ?? []).length, 1,
      'and one placement: the old page drew it inside the review card OR as a '
      + 'card of its own, which is two arrangements to keep in step')
    // Which is also how an exception approver who holds no review authority
    // reaches their decision: the panel is drawn for everybody who can read the
    // PI, so there is no second copy for the case that used to need one.
    assert.ok(read(DETAIL_SECTIONS).includes('{advanceBand && <div className="pi-detail-workflow-band">'),
      'separated by a rule and a quieter ground: the two decisions are different')
  })

  test('the decision controls are gated on the exception capability alone', () => {
    assert.ok(source.includes('canDecide={advanceActions.canDecide}'))
    assert.ok(!/canDecide=\{[^}]*canReview/.test(source),
      'PI review authority must not draw an advance decision control')
    assert.ok(!/canDecide=\{[^}]*canApproveOrderSubmission/.test(source))
  })

  test('a draft shows no advance block, and everything past it does', () => {
    assert.ok(read(DETAIL_VIEW).includes("const show = !advance.undeclared || input.status !== 'draft'"))
  })

  test('the current advance state is stated exactly once on the page', () => {
    // Manual review found it in four places at once: the snapshot, the workflow
    // band, the commercial breakdown's required-advance row, and Activity. The
    // snapshot is now the single current-state source; the band appears only
    // while a decision is outstanding; the breakdown's row is dropped; Activity
    // keeps history, which is a different question.
    assert.ok(source.includes('const advanceBand = advanceActions.isPending ? ('),
      'the band is gated on a pending decision and nothing else')
    assert.ok(source.includes('commercialBreakdownRows(buildCommercialRows('),
      'and the required-advance row is filtered out of the breakdown')
  })

  test('the rejected-exception instruction appears only while the PI is back', () => {
    assert.ok(source.includes("advance.status === 'rejected' && submission.status === 'needs_changes'"))
    assert.ok(source.includes('instruction: ADVANCE_REJECTED_INSTRUCTION'))
    assert.ok(read(DETAIL_SECTIONS).includes('{advanceRefusal.instruction}'))
    assert.ok(source.includes('advanceRefusal = advanceRejectedNow'),
      'and it reaches nobody else: everyone else reads the outcome in the snapshot')
  })

  test('the page claims no payment, and no longer says so at length', () => {
    const screen = detailScreen()
    for (const claim of ['Add Payment', 'payment received', 'Record Payment', 'finance_payment']) {
      assert.ok(!screen.includes(claim), `the screen must not say "${claim}"`)
    }
    assert.ok(!/received|collected|\bpaid\b/i.test(read(DETAIL_VIEW)),
      'the snapshot states a requirement, never a receipt')
    // The disclaimer itself is gone from the record page: it appeared under
    // every advance figure on a screen that never claimed one. It still stands
    // in the submit dialog, which is where the declaration is actually made,
    // and on the import preview's own commercial summary.
    assert.ok(!screen.includes('ADVANCE_NOT_A_PAYMENT'))
    assert.ok(read(REVIEW_MODALS).includes('{ADVANCE_NOT_A_PAYMENT}'),
      'the boundary is stated at the point of declaration')
    assert.ok(read('src/lib/pi/previewView.ts').includes('note: ADVANCE_NOT_A_PAYMENT_NOTE'),
      'and on the preview, whose summary is the only advance it states')
  })

  test('no Finance or payment table is read by this page', () => {
    const tables = [...source.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    for (const table of tables) {
      assert.ok(!/payment|finance/i.test(table), `${table} is out of scope for this page`)
    }
  })

  test('the disabled PI approval explains itself accurately', () => {
    const workflow = read('src/lib/orders/submissionWorkflow.ts')
    assert.ok(workflow.includes('APPROVE_DISABLED_REASON'))
    assert.ok(/order-approval phase/.test(workflow),
      'it says which phase brings approval, now that advance review exists')
    assert.ok(!/after advance review is added/.test(workflow),
      'the old wording stopped being true the moment advance review was added')
  })
})

describe('the submit dialog asks one question and stays short', () => {
  const source = read(REVIEW_MODALS)

  test('the dialog opens on the record’s own declaration', () => {
    assert.ok(source.includes('useState<AdvanceDeclaration>(initialAdvance)'))
    assert.ok(source.includes('initialAdvance: AdvanceDeclaration'))
  })

  test('all THREE choices are drawn, and none is hidden behind another', () => {
    // The defect this replaced: two radio cards, with "no advance" reachable
    // only by knowing 0 was an accepted percentage inside the second one.
    assert.ok(source.includes('{ADVANCE_CHOICES.map(card)}'),
      'the choices come from the shared list, so none can be forgotten here')
    assert.ok(source.includes('{ADVANCE_CHOICE_LABEL[value]}'))
    assert.ok(source.includes('{ADVANCE_CHOICE_HINT[value]}'))
    assert.ok(!source.includes('ADVANCE_EXCEPTION_LABEL'),
      'the old catch-all "Request advance exception" option is gone')
  })

  test('each choice reveals exactly what it needs, and nothing more', () => {
    assert.ok(source.includes("{choice === 'reduced' && ("),
      'the typed percentage exists only for a reduced advance')
    assert.ok(source.includes("{choice === 'none' && ("),
      'No advance states its figures instead of offering a box')
    assert.ok(source.includes('{ADVANCE_NONE_PERCENT_LABEL}'))
    assert.ok(source.includes('{ADVANCE_NONE_AMOUNT_LABEL}'))
  })

  test('every choice shows its rupee figure immediately', () => {
    assert.ok(source.includes('previewAdvanceAmount(percentText, grandTotalValue)'))
    assert.ok(source.includes('{amount}'))
    assert.ok(source.includes('return standardAmount'))
  })

  test('0% is explained rather than left as a bare ₹0', () => {
    assert.ok(source.includes('{ADVANCE_ZERO_EXPLANATION}'))
  })

  test('submit is disabled while the declaration is invalid or in flight', () => {
    assert.ok(source.includes('const blocked = submitting || tooLong || !advance.ok'))
    assert.ok(source.includes('disabled={blocked}'))
    assert.ok(source.includes('if (blocked || !advance.ok) return'),
      'and the handler refuses too, so a defeated button sends nothing')
  })

  test('the validation is the shared one, not a second copy in the dialog', () => {
    assert.ok(source.includes('validateAdvanceDeclaration({'))
    assert.ok(!/percent\s*[<>]=?\s*40/.test(source), 'no bare 40 in a JSX condition')
    assert.ok(!source.includes('parseFloat('), 'no second parser')
    assert.ok(!source.includes('Number(percentText'), 'the dialog never parses the box itself')
  })

  test('the optional employee reply is preserved on a resubmission', () => {
    assert.ok(source.includes('{offerReply && ('))
    assert.ok(source.includes('validateResubmitReply(reply)'))
    assert.ok(source.includes('RESUBMIT_NOTE_LABEL'))
  })

  test('Reject Exception is a small mandatory-reason dialog, not a new component', () => {
    assert.ok(source.includes("export type PiNoteIntent = 'needs_changes' | 'reject' | 'reject_exception'"))
    assert.ok(source.includes('reject_exception: {'))
    assert.ok(source.includes('const valid = note.trim().length > 0'),
      'the same mandatory-reason rule all three decisions share')
  })

  test('rejecting the advance is visibly NOT rejecting the PI', () => {
    const start = source.indexOf('reject_exception: {')
    const copy = source.slice(start, source.indexOf('\n  },', start))
    assert.ok(copy.includes('The PI is NOT rejected'))
    assert.ok(copy.includes('Reject Advance Exception'), 'and its confirm says what it acts on')
    assert.ok(!copy.includes('cannot be undone'),
      'because it can: the employee resubmits with a new proposal')
  })

  test('nothing in the dialogs claims a payment', () => {
    for (const claim of ['payment received', 'Add Payment', 'amount received', 'paid']) {
      assert.ok(!source.toLowerCase().includes(claim.toLowerCase()),
        `the dialogs must not say "${claim}"`)
    }
    assert.ok(source.includes('{ADVANCE_NOT_A_PAYMENT}'))
  })
})
