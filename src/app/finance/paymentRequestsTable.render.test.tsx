/**
 * THE PAYMENT REQUESTS TABLE, ACTUALLY RENDERED.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * A source guard proves a string is in a file. It cannot prove that a column
 * landed in the markup in the right POSITION, that a removed badge is genuinely
 * absent from every row rather than merely absent from one branch, or that a
 * null payment mode came out as an em dash instead of the word "null". So this
 * renders the real component and reads what comes out.
 *
 * WHAT IS NOT TESTED HERE: inline pixel values, except the two that are the
 * change rather than a decoration — the column shares in the colgroup, which
 * are the fix for the blank band beside Client, and the absence of a right
 * alignment on Amount. A padding is a design decision that will move, and a
 * test that fails when a cell breathes differently is a test nobody keeps.
 *
 * DESKTOP AND MOBILE ARE THE SAME MARKUP HERE, deliberately. This page has no
 * separate card list: its narrow-width representation is this table inside an
 * `overflow-x: auto` wrapper, which is asserted below. So a column added to the
 * table is a column present on a phone, and the mobile check is a check that
 * the wrapper is still there and that nothing forces a minimum width wider than
 * a phone — not a second set of expectations about different markup.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentRequestsTable.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { PaymentsTable, type PaymentRequest } from './page'
import type { PaymentDestination } from '@/lib/finance/paymentDestination'
import { PAYMENT_MODES, LEGACY_PAYMENT_MODES } from '@/lib/finance/paymentEntry'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SOURCE = read('src/app/finance/page.tsx')

const USER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

function row(over: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    request_number: 'REQ-1',
    human_payment_id: 'P-AA-0001',
    client_name: 'Sharma Furnishings Pvt Ltd',
    amount: 125000,
    payment_date: '2026-08-01',
    payment_mode: 'hdfc',
    received_in: null,
    collected_by_user_id: null,
    collected_from_text: null,
    handed_over_to_user_id: null,
    handed_over_at: null,
    collection_handover_note: null,
    proof_note: null,
    order_number: null,
    order_id: null,
    order_request_id: null,
    order_request_number: null,
    sales_note: null,
    payment_against: 'new_order',
    payment_target_type: 'order',
    status: 'pending_approval',
    submitted_by: USER,
    submitted_by_name: 'Anita Rao',
    admin_note: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    rejected_at: null,
    clarification_requested_at: null,
    ...over,
  }
}

const noop = () => {}

function render(rows: PaymentRequest[], opts: {
  destinations?: Map<string, PaymentDestination> | null
  isAdmin?: boolean
} = {}): string {
  return renderToStaticMarkup(
    <PaymentsTable
      rows={rows}
      destinations={opts.destinations ?? null}
      isAdmin={opts.isAdmin ?? false}
      userId={USER}
      cutoff={Date.parse('2026-08-27T00:00:00Z')}
      highlightId={null}
      onRowClick={noop}
      onView={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  )
}

/** The header cells, in the order they are drawn. */
function headers(markup: string): string[] {
  const head = markup.slice(markup.indexOf('<thead'), markup.indexOf('</thead>'))
  return [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(m => m[1])
}

/** The <td> cells of the first body row, in order, stripped of markup. */
function firstRowCells(markup: string): string[] {
  const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
  const tr = body.slice(0, body.indexOf('</tr>'))
  return [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map(m => m[1].replace(/<[^>]*>/g, '').trim())
}

// ── 1. The column order ──────────────────────────────────────────────────────

describe('1. the required column order', () => {
  test('1a. nine headers, in the order the screen calls for', () => {
    assert.deepEqual(headers(render([row()])), [
      'Payment ID', 'Client', 'Amount', 'Payment Date', 'Payment Mode',
      'Against', 'Status', 'Requested By', 'Action',
    ])
  })

  test('1b. Payment Mode sits between Payment Date and Against, not at the end', () => {
    const h = headers(render([row()]))
    assert.equal(h.indexOf('Payment Mode'), h.indexOf('Payment Date') + 1)
    assert.equal(h.indexOf('Against'), h.indexOf('Payment Mode') + 1)
  })

  test('1c. every body row has one cell per header', () => {
    const markup = render([row(), row({ id: 'a1b2c3d4-0000-4000-8000-000000000002' })])
    const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
    const rows = body.split('</tr>').filter(r => r.includes('<td'))
    assert.equal(rows.length, 2)
    for (const r of rows) {
      assert.equal([...r.matchAll(/<td[^>]*>/g)].length, 9)
    }
  })

  test('1d. the preserved columns still carry their values', () => {
    const cells = firstRowCells(render([row()]))
    assert.equal(cells[0], 'P-AA-0001')                       // Payment ID
    assert.ok(cells[1].startsWith('Sharma Furnishings'))      // Client
    assert.ok(cells[3].length > 0)                            // Payment Date
    assert.ok(cells[6].length > 0)                            // Status
    assert.equal(cells[7], 'Anita Rao')                       // Requested By
    assert.ok(cells[8].includes('View'))                      // Action
  })
})

// ── 2. The Review badge is gone ──────────────────────────────────────────────

describe('2. Pending is stated once, in Status', () => {
  test('2a. no "Review" badge beside the client name, for any viewer', () => {
    // The badge used to be drawn for approvers on a pending row. There is no
    // approver flag to pass any more, so this is asserted the only way that
    // means anything: across every combination the table still varies on.
    for (const isAdmin of [true, false]) {
      for (const status of ['pending_approval', 'needs_clarification', 'rejected', 'approved']) {
        const cells = firstRowCells(render([row({ status })], { isAdmin }))
        assert.equal(cells[1], 'Sharma Furnishings Pvt Ltd',
          `client cell must hold the name alone (isAdmin=${isAdmin}, status=${status})`)
      }
    }
  })

  test('2b. and no OTHER badge took its place in that cell', () => {
    const markup = render([row()])
    const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
    const clientCell = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][1][1]
    // One element, holding one string. A chip would be a second.
    assert.equal([...clientCell.matchAll(/<span|<div/g)].length, 1)
  })

  test('2c. Pending is still visible — in the Status column', () => {
    const cells = firstRowCells(render([row({ status: 'pending_approval' })]))
    assert.match(cells[6], /Pending/i)
  })

  test('2d. the capability is no longer passed to the table at all', () => {
    // Approval authority still gates the row-click review router and the modal
    // it opens. What is gone is a table taking it to tint a cell.
    assert.equal(SOURCE.includes('canApprove={caps.canApprovePayment}'), false)
    assert.ok(SOURCE.includes("if (caps.canApprovePayment && r.status === 'pending_approval')"))
    assert.ok(SOURCE.includes('mayApprovePayments={caps.canApprovePayment}'))
  })
})

// ── 3. Amount is left-aligned ────────────────────────────────────────────────

describe('3. Amount reads left, header and value together', () => {
  const markup = render([row()])

  test('3a. the header carries no right alignment', () => {
    const head = markup.slice(markup.indexOf('<thead'), markup.indexOf('</thead>'))
    const th = [...head.matchAll(/<th\b[^>]*>/g)][2][0]
    assert.equal(/text-align:\s*right/.test(th), false, 'Amount header must not be right-aligned')
  })

  test('3b. nor does the value cell', () => {
    const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
    const td = [...body.matchAll(/<td[^>]*>/g)][2][0]
    assert.equal(/text-align:\s*right/.test(td), false, 'Amount cell must not be right-aligned')
  })

  test('3c. Action is still right-aligned — it is the only column that should be', () => {
    const head = markup.slice(markup.indexOf('<thead'), markup.indexOf('</thead>'))
    const ths = [...head.matchAll(/<th\b[^>]*>/g)].map(m => m[0])
    assert.equal(ths.filter(t => /text-align:\s*right/.test(t)).length, 1)
    assert.match(ths[8], /text-align:\s*right/)
  })

  test('3d. Indian currency formatting and weight are preserved', () => {
    const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
    const [open, value] = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][2]
      .slice(0, 2) as [string, string]
    // 1,25,000 — lakh grouping, not 125,000.
    assert.match(value, /1,25,000/)
    assert.match(open, /font-weight:\s*700/)
    assert.match(open, /font-variant-numeric:\s*tabular-nums/)
  })
})

// ── 4. The width rebalance ───────────────────────────────────────────────────

describe('4. the blank band between Client and Amount is closed', () => {
  const markup = render([row()])

  test('4a. a colgroup declares every column\'s share', () => {
    const colgroup = markup.slice(markup.indexOf('<colgroup'), markup.indexOf('</colgroup>'))
    const widths = [...colgroup.matchAll(/width:\s*(\d+)%/g)].map(m => Number(m[1]))
    assert.equal(widths.length, 9, 'one share per column')
    assert.equal(widths.reduce((a, b) => a + b, 0), 100, 'the shares must total 100')
  })

  test('4b. Client no longer takes the leftover width', () => {
    const colgroup = markup.slice(markup.indexOf('<colgroup'), markup.indexOf('</colgroup>'))
    const widths = [...colgroup.matchAll(/width:\s*(\d+)%/g)].map(m => Number(m[1]))
    // Wide enough for a normal name, and no longer the widest thing on screen:
    // Against, which holds the longest prose, is the column that may be.
    assert.ok(widths[1] >= 12, 'Client must still fit an ordinary name')
    assert.ok(widths[1] <= widths[5], 'Client must not out-reserve the longest-text column')
  })

  test('4c. no fixed table layout, and no forced minimum width', () => {
    // Both are how this could have clipped a name on a 1280px laptop.
    assert.equal(/table-layout:\s*fixed/.test(markup), false)
    assert.equal(/min-width:\s*\d/.test(markup), false)
  })

  test('4d. the long-text cells still truncate with the full value on hover', () => {
    const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
    assert.ok(body.includes('title="Sharma Furnishings Pvt Ltd"'), 'client keeps its title')
    assert.equal([...body.matchAll(/text-overflow:\s*ellipsis/g)].length >= 3, true)
  })
})

// ── 5. Payment Mode ──────────────────────────────────────────────────────────

describe('5. Payment Mode shows the value the row already carries', () => {
  test('5a. each current mode prints its established label', () => {
    for (const { value, label } of PAYMENT_MODES) {
      const cells = firstRowCells(render([row({ payment_mode: value })]))
      assert.equal(cells[4], label, `${value} must read as ${label}`)
    }
  })

  test('5b. and so does every retired one — Bank Transfer, Cash, UPI, Cheque, Other', () => {
    for (const { value, label } of LEGACY_PAYMENT_MODES) {
      const cells = firstRowCells(render([row({ payment_mode: value })]))
      assert.equal(cells[4], label, `${value} must read as ${label}`)
    }
  })

  test('5c. no raw database identifier reaches the screen for a known mode', () => {
    const known = [...PAYMENT_MODES, ...LEGACY_PAYMENT_MODES].map(m => m.value)
    for (const value of known) {
      const markup = render([row({ payment_mode: value })])
      const body = markup.slice(markup.indexOf('<tbody'), markup.indexOf('</tbody>'))
      if (value === 'other') continue           // its label IS the word
      assert.equal(body.includes(`>${value}<`), false, `${value} must not print raw`)
    }
  })

  test('5d. a historical null falls back quietly to an em dash', () => {
    for (const missing of [null, undefined, '', '   ']) {
      const cells = firstRowCells(
        render([row({ payment_mode: missing as unknown as string })]))
      assert.equal(cells[4], '—', `a ${JSON.stringify(missing)} mode must read as an em dash`)
      assert.equal(/null|undefined/.test(cells[4]), false)
    }
  })

  test('5e. an unrecognised stored value is shown as stored, not relabelled', () => {
    // The formatter's own rule: a row carrying something neither list knows is
    // a fact worth seeing. This column does not get to hide it.
    const cells = firstRowCells(render([row({ payment_mode: 'neft_legacy' })]))
    assert.equal(cells[4], 'neft_legacy')
  })

  test('5f. the value is read from payment_mode — never from the destination', () => {
    // A destination answers "what is this payment FOR". Deriving a mode from it
    // would be inventing one, and the Against column is where it belongs.
    const destination: PaymentDestination = {
      paymentId: 'a1b2c3d4-0000-4000-8000-000000000001',
      source: 'allocation',
      kind: 'confirmed_order',
      orderCount: 1,
      submissionCount: 0,
      customerCount: 1,
      orderId: 'b1b2c3d4-0000-4000-8000-000000000009',
      orderNumber: 'BOE/2026/0042',
      submissionId: null,
      reference: 'BOE/2026/0042',
    }
    const cells = firstRowCells(render([row({ payment_mode: 'upi' })], {
      destinations: new Map([[destination.paymentId, destination]]),
    }))
    assert.equal(cells[4], 'UPI')
    assert.match(cells[5], /BOE\/2026\/0042/)   // Against is unchanged
  })
})

// ── 6. Query count, and the mobile representation ────────────────────────────

describe('6. no new query, and the narrow-width view keeps the column', () => {
  test('6a. payment_mode was already in the bounded list select', () => {
    // The column costs nothing: it is read by the same page query that already
    // returns it, which is why no per-row request appears anywhere here.
    const at = SOURCE.indexOf('id, request_number, human_payment_id, client_name, amount, payment_date')
    assert.ok(at > 0, 'the list select must still be one literal column list')
    assert.match(SOURCE.slice(at, at + 200), /payment_date, payment_mode/)
    // And it is a bounded page, not the whole table.
    assert.ok(SOURCE.includes('pageRange(page)'))
  })

  test('6b. the table itself issues no request of any kind', () => {
    const table = SOURCE.slice(SOURCE.indexOf('export function PaymentsTable'),
                               SOURCE.indexOf('// ── Page ──'))
    for (const forbidden of ['supabase', 'fetch(', 'useEffect', 'useQuery']) {
      assert.equal(table.includes(forbidden), false,
        `the table must not ${forbidden} — one row must never cost one request`)
    }
  })

  test('6c. the narrow-width fallback is intact, so Payment Mode is on a phone too', () => {
    // There is no separate card list on this page: the mobile representation IS
    // this table, scrolled horizontally. A column added above is therefore
    // present at every width, and what has to hold is the wrapper.
    const markup = render([row()])
    assert.match(markup, /overflow-x:\s*auto/)
    assert.match(markup, /-webkit-overflow-scrolling:\s*touch/)
    // And nothing on the page renders an alternative compact list that would
    // need the column adding separately.
    assert.equal(/matchMedia|isMobile/.test(SOURCE), false)
  })

  test('6d. the actions stay usable — they are still the last cell, unwrapped', () => {
    const cells = firstRowCells(render([row()], { isAdmin: true }))
    assert.ok(cells[8].includes('View'))
    assert.ok(cells[8].includes('Delete'), 'an admin still gets Delete')
  })
})
