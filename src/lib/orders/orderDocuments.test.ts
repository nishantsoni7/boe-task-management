/**
 * THE DOCUMENT VOCABULARY, AND WHAT A SCREEN IS ALLOWED TO SAY.
 *
 * Three properties are worth a test here, and the third is the one that matters:
 *
 *   1. A path is attempt-scoped, or a retry after a half-finished attempt could
 *      never write anything — order-files objects are immutable.
 *   2. `downloadable` means BOTH files. A screen that offers one and implies the
 *      other is coming is worse than one that offers neither.
 *   3. A FAILURE MESSAGE CONTRIBUTES NO TEXT OF ITS OWN. The sanitizer is an
 *      allow-list, so an error nobody anticipated cannot leak a credential, a
 *      hostname or a stack frame — because none of its words are used.
 *
 * Pure and offline. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderDocuments.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ORDER_DOCUMENTS_GENERIC_FAILURE,
  ORDER_DOCUMENT_COLUMNS,
  ORDER_DOCUMENT_FAILURES,
  ORDER_DOCUMENT_STATUSES,
  ORDER_DOCUMENT_STATUS_LABEL,
  ORDER_DOCUMENT_UNKNOWN_FAILURE,
  buildOrderDocumentsView,
  currentOrderDocument,
  isOrderDocumentReady,
  isOrderDocumentStatus,
  latestOrderDocument,
  orderDocumentAttemptPath,
  orderDocumentVersionPrefix,
  sanitizeOrderDocumentFailure,
  type OrderDocumentRow,
} from './orderDocuments'

const ORDER = '11111111-2222-3333-4444-555555555555'

function row(over: Partial<OrderDocumentRow> = {}): OrderDocumentRow {
  return {
    id: 'v1', order_id: ORDER, version: 1, status: 'ready', attempt_count: 1,
    claimed_at: null, completed_at: '2026-08-20T10:00:00Z',
    last_error_code: null, last_error_message: null,
    excel_path: orderDocumentAttemptPath(ORDER, 1, 1, 'xlsx'),
    pdf_path: orderDocumentAttemptPath(ORDER, 1, 1, 'pdf'),
    excel_sha256: 'a'.repeat(64), pdf_sha256: 'b'.repeat(64),
    excel_bytes: 1000, pdf_bytes: 2000,
    created_at: '2026-08-20T09:00:00Z', updated_at: '2026-08-20T10:00:00Z',
    ...over,
  }
}

// ── 1. The states ─────────────────────────────────────────────────────────────

describe('the status vocabulary', () => {
  test('is exactly four, matching the SQL CHECK', () => {
    assert.deepEqual([...ORDER_DOCUMENT_STATUSES], ['pending', 'claimed', 'ready', 'failed'])
  })

  test('a value outside the set is not a status', () => {
    for (const bad of ['generating', 'done', '', 'READY', null, 7]) {
      assert.equal(isOrderDocumentStatus(bad), false, String(bad))
    }
  })

  test('`claimed` is shown as Generating — a lease is not a person\'s concern', () => {
    assert.equal(ORDER_DOCUMENT_STATUS_LABEL.claimed, 'Generating')
    assert.ok(!Object.values(ORDER_DOCUMENT_STATUS_LABEL).some(l => /claim/i.test(l)))
  })
})

// ── 2. Paths ──────────────────────────────────────────────────────────────────

describe('where a document lives', () => {
  test('the version prefix is the shape 20260908000000 reserved', () => {
    assert.equal(orderDocumentVersionPrefix(ORDER, 1), `orders/${ORDER}/versions/1`)
  })

  test('a write is ATTEMPT-scoped, so a retry never needs to replace an object', () => {
    assert.equal(
      orderDocumentAttemptPath(ORDER, 2, 3, 'xlsx'),
      `orders/${ORDER}/versions/2/attempts/3/approved.xlsx`)
    assert.equal(
      orderDocumentAttemptPath(ORDER, 2, 3, 'pdf'),
      `orders/${ORDER}/versions/2/attempts/3/approved.pdf`)
  })

  test('two attempts of one version never collide', () => {
    const a = orderDocumentAttemptPath(ORDER, 1, 1, 'xlsx')
    const b = orderDocumentAttemptPath(ORDER, 1, 2, 'xlsx')
    assert.notEqual(a, b)
  })

  test('every attempt key still sits under its own version prefix', () => {
    const prefix = orderDocumentVersionPrefix(ORDER, 4)
    assert.ok(orderDocumentAttemptPath(ORDER, 4, 9, 'pdf')?.startsWith(`${prefix}/`))
  })

  test('version 1 is not a prefix of version 10', () => {
    // A guard written with a bare startsWith would otherwise let one version
    // publish another's files.
    assert.ok(!orderDocumentVersionPrefix(ORDER, 10).startsWith(`${orderDocumentVersionPrefix(ORDER, 1)}/`))
  })

  test('an unknown kind or an impossible counter yields null, never a plausible key', () => {
    // @ts-expect-error — the type forbids it; the runtime must too.
    assert.equal(orderDocumentAttemptPath(ORDER, 1, 1, 'docx'), null)
    assert.equal(orderDocumentAttemptPath(ORDER, 0, 1, 'pdf'), null)
    assert.equal(orderDocumentAttemptPath(ORDER, 1, 0, 'pdf'), null)
    assert.equal(orderDocumentAttemptPath(ORDER, 1.5, 1, 'pdf'), null)
    assert.equal(orderDocumentAttemptPath('not-a-uuid', 1, 1, 'pdf'), null)
    assert.equal(orderDocumentAttemptPath('', 1, 1, 'pdf'), null)
  })

  test('a key can never climb out of the bucket', () => {
    for (const bad of ['../secrets', 'orders/../x', '/absolute']) {
      assert.equal(orderDocumentAttemptPath(bad, 1, 1, 'pdf'), null, bad)
    }
  })
})

// ── 3. The select ─────────────────────────────────────────────────────────────

describe('what a client selects', () => {
  const columns = ORDER_DOCUMENT_COLUMNS.split(',').map(c => c.trim())

  test('never names claim_token — it is granted to no client role', () => {
    // Naming it would not merely be untidy: PostgreSQL would refuse the whole
    // select, so every read of this table would fail.
    assert.ok(!columns.includes('claim_token'))
  })

  test('never names claimed_by either, and is never `*`', () => {
    assert.ok(!columns.includes('*'))
    assert.equal(new Set(columns).size, columns.length)
  })
})

// ── 4. Ready means both files ─────────────────────────────────────────────────

describe('document-ready', () => {
  test('is true only when the status is ready AND both files are named', () => {
    assert.equal(isOrderDocumentReady(row()), true)
  })

  test('is false with only the workbook', () => {
    assert.equal(isOrderDocumentReady(row({ pdf_path: null })), false)
  })

  test('is false with only the PDF', () => {
    assert.equal(isOrderDocumentReady(row({ excel_path: null })), false)
  })

  test('is false for a blank path, which is not a file', () => {
    assert.equal(isOrderDocumentReady(row({ pdf_path: '   ' })), false)
  })

  test('is false for every state but ready, whatever the paths say', () => {
    for (const status of ['pending', 'claimed', 'failed']) {
      assert.equal(isOrderDocumentReady(row({ status })), false, status)
    }
  })
})

// ── 5. What the screen shows ──────────────────────────────────────────────────

describe('the Order documents view', () => {
  test('an Order nobody has asked about shows nothing and offers nothing', () => {
    const view = buildOrderDocumentsView([])
    assert.equal(view.version, null)
    assert.equal(view.downloadable, false)
    assert.equal(view.working, false)
    assert.equal(view.failure, null)
  })

  test('a queued version is working, and offers no download', () => {
    const view = buildOrderDocumentsView([row({ status: 'pending', excel_path: null, pdf_path: null, completed_at: null })])
    assert.equal(view.working, true)
    assert.equal(view.downloadable, false)
    assert.equal(view.excelPath, null)
    assert.equal(view.pdfPath, null)
    assert.equal(view.statusLabel, 'Queued')
  })

  test('a version being generated says Generating, not Claimed', () => {
    const view = buildOrderDocumentsView([row({ status: 'claimed', excel_path: null, pdf_path: null, completed_at: null })])
    assert.equal(view.statusLabel, 'Generating')
    assert.equal(view.tone, 'blue')
    assert.equal(view.working, true)
  })

  test('a ready version offers BOTH paths and nothing else', () => {
    const view = buildOrderDocumentsView([row()])
    assert.equal(view.downloadable, true)
    assert.ok(view.excelPath?.endsWith('approved.xlsx'))
    assert.ok(view.pdfPath?.endsWith('approved.pdf'))
    assert.equal(view.working, false)
    assert.equal(view.failure, null)
  })

  test('a failed version reports the STORED sentence, never the code', () => {
    const view = buildOrderDocumentsView([row({
      status: 'failed', excel_path: null, pdf_path: null, completed_at: null,
      last_error_code: 'WORKBOOK_UNREADABLE',
      last_error_message: ORDER_DOCUMENT_FAILURES.WORKBOOK_UNREADABLE,
    })])
    assert.equal(view.failure, ORDER_DOCUMENT_FAILURES.WORKBOOK_UNREADABLE)
    assert.ok(!view.failure?.includes('WORKBOOK_UNREADABLE'))
    assert.equal(view.downloadable, false)
  })

  test('a failure with no stored message falls back to a sentence, not to silence', () => {
    const view = buildOrderDocumentsView([row({
      status: 'failed', excel_path: null, pdf_path: null, completed_at: null,
      last_error_code: 'X', last_error_message: null,
    })])
    assert.equal(view.failure, ORDER_DOCUMENTS_GENERIC_FAILURE)
  })

  test('attempt count is shown only when it is more than one', () => {
    assert.equal(buildOrderDocumentsView([row({ attempt_count: 1 })]).attempts, null)
    assert.equal(buildOrderDocumentsView([row({ attempt_count: 3 })]).attempts, 3)
  })
})

// ── 6. A ready version and an in-flight one, at once ──────────────────────────

describe('an amendment generating over documents that already exist', () => {
  const ready1 = row({ id: 'v1', version: 1 })
  const busy2 = row({
    id: 'v2', version: 2, status: 'claimed',
    excel_path: null, pdf_path: null, completed_at: null, attempt_count: 1,
  })

  test('the person keeps the documents they already have', () => {
    const view = buildOrderDocumentsView([ready1, busy2])
    assert.equal(view.version, 1)
    assert.equal(view.downloadable, true)
  })

  test('and is still told the new ones are coming', () => {
    assert.equal(buildOrderDocumentsView([ready1, busy2]).working, true)
  })

  test('a FAILED newer version is reported while the older stays downloadable', () => {
    const failed2 = row({
      id: 'v2', version: 2, status: 'failed',
      excel_path: null, pdf_path: null, completed_at: null,
      last_error_code: 'PDF_RENDER_FAILED',
      last_error_message: ORDER_DOCUMENT_FAILURES.PDF_RENDER_FAILED,
    })
    const view = buildOrderDocumentsView([ready1, failed2])
    assert.equal(view.downloadable, true, 'version 1 is untouched by version 2 failing')
    assert.equal(view.version, 1)
    assert.equal(view.failure, ORDER_DOCUMENT_FAILURES.PDF_RENDER_FAILED,
      'and the failure is still reported, or somebody waits for documents that are not coming')
  })

  test('currentOrderDocument prefers the newest READY version', () => {
    const ready3 = row({ id: 'v3', version: 3 })
    assert.equal(currentOrderDocument([ready1, busy2, ready3])?.id, 'v3')
  })

  test('latestOrderDocument is the newest of ANY kind', () => {
    assert.equal(latestOrderDocument([ready1, busy2])?.id, 'v2')
  })

  test('neither mutates the array it is given', () => {
    const rows = [busy2, ready1]
    const before = rows.map(r => r.id)
    currentOrderDocument(rows)
    latestOrderDocument(rows)
    assert.deepEqual(rows.map(r => r.id), before)
  })
})

// ── 7. A failure says only what was written in advance ────────────────────────

describe('sanitizing a failure', () => {
  test('a known code maps to its own prewritten sentence', () => {
    const { code, message } = sanitizeOrderDocumentFailure('WORKBOOK_MISSING')
    assert.equal(code, 'WORKBOOK_MISSING')
    assert.equal(message, ORDER_DOCUMENT_FAILURES.WORKBOOK_MISSING)
  })

  test('an UNKNOWN failure contributes NOT ONE WORD of its own', () => {
    // The whole security property, stated as a test. An allow-list cannot leak
    // a secret it never reads — which is why this is not a scrubber.
    const leaks = [
      'postgres://user:hunter2@db.internal:5432/prod',
      'Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature',
      'Error: connect ECONNREFUSED 10.0.0.4:5432\n    at TCPConnectWrap.afterConnect',
      'SUPABASE_SERVICE_ROLE_KEY=sbp_0123456789abcdef',
      '/var/task/node_modules/@supabase/storage-js/dist/index.js:118',
    ]
    for (const raw of leaks) {
      const { code, message } = sanitizeOrderDocumentFailure(raw)
      assert.equal(code, ORDER_DOCUMENT_UNKNOWN_FAILURE)
      assert.equal(message, ORDER_DOCUMENTS_GENERIC_FAILURE)
      assert.ok(!message.includes(raw))
      for (const fragment of ['hunter2', 'Bearer', 'sbp_', '10.0.0.4', 'node_modules', 'postgres://']) {
        assert.ok(!message.includes(fragment), `${fragment} leaked`)
        assert.ok(!code.includes(fragment), `${fragment} leaked into the code`)
      }
    }
  })

  test('a thrown Error object leaks nothing either', () => {
    const { code, message } = sanitizeOrderDocumentFailure(new Error('service_role key sbp_abc rejected'))
    assert.equal(code, ORDER_DOCUMENT_UNKNOWN_FAILURE)
    assert.equal(message, ORDER_DOCUMENTS_GENERIC_FAILURE)
    assert.ok(!message.includes('sbp_abc'))
  })

  test('null, undefined and an empty string are all the generic failure', () => {
    for (const bad of [null, undefined, '', '   ']) {
      assert.equal(sanitizeOrderDocumentFailure(bad).code, ORDER_DOCUMENT_UNKNOWN_FAILURE)
    }
  })

  test('not one prewritten message mentions a credential, a host or a path', () => {
    const all = [...Object.values(ORDER_DOCUMENT_FAILURES), ORDER_DOCUMENTS_GENERIC_FAILURE]
    for (const message of all) {
      assert.ok(!/https?:\/\/|postgres:\/\/|Bearer|service_role|sbp_|node_modules|\bat \w+\.|\/var\//i.test(message),
        `a prewritten failure message must not carry internals: ${message}`)
      // Written for a person: a sentence, not a token.
      assert.ok(/^[A-Z]/.test(message) && message.endsWith('.'), message)
    }
  })
})
