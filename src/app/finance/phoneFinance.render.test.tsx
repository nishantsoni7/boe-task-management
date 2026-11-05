/**
 * FINANCE ON A PHONE (owner, 2026-11-05, "phones: content first", Phase 3).
 *
 * Below 768px the Finance lists are three-line cards (.fph-list and the fph-*
 * slot classes), Bank Statements is compact, Reimbursements has one Filter
 * button, and the money-not-with-the-company strip is one line that opens on
 * tap. The desktop is unchanged: every rule that moves anything sits inside
 * max-width: 767px.
 *
 * Run: npm run test:file -- src/app/finance/phoneFinance.render.test.tsx
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { PaymentsTable, type PaymentRequest } from './page'
import { BankSyncCheck } from './bank/bankSyncCheck'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const CSS = read('src/app/globals.css')
const PHASE3 = CSS.slice(CSS.indexOf('PHONE PHASE 3 — FINANCE'))

function row(over: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: 'r1', request_number: 'REQ-1', human_payment_id: 'P-AA-0001', client_name: 'Sharma Furnishings',
    amount: 125000, payment_date: '2026-11-01', payment_mode: 'hdfc', received_in: null,
    collected_by_user_id: null, collected_from_text: null, handed_over_to_user_id: null, handed_over_at: null,
    collection_handover_note: null, proof_note: null, order_number: null, order_id: null, order_request_id: null,
    order_request_number: null, sales_note: null, payment_against: 'new_order', payment_target_type: 'order',
    status: 'pending_approval', submitted_by: 'u1', submitted_by_name: 'Anita Rao', admin_note: null,
    created_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-01T09:00:00Z', rejected_at: null,
    clarification_requested_at: null, ...over,
  } as PaymentRequest
}

const noop = () => {}
const table = (salesView: boolean) => renderToStaticMarkup(createElement(PaymentsTable, {
  rows: [row()], destinations: new Map(), isAdmin: !salesView, userId: 'u1', cutoff: Date.now(),
  onRowClick: noop, onEdit: noop, onDelete: noop, salesView, totals: salesView ? new Map([['r1', 250000]]) : null,
}))
const cellClasses = (markup: string) =>
  [...markup.slice(markup.indexOf('<tbody')).matchAll(/<td[^>]*class="([^"]*)"/g)].map(m => m[1])

describe('Payment Requests: each row is a three-line card on a phone', () => {
  test('the review list: client and amount, mode, Against and status, then ID, date, Added by and the buttons', () => {
    const markup = table(false)
    assert.match(markup, /<div class="fph-list"/)
    assert.deepEqual(cellClasses(markup), ['fph-l3', 'fin-num fph-end1', 'fph-title', 'fph-l3', 'fph-l2', 'fph-l2 fph-grow', 'fph-l3 fph-grow', 'fph-end2', 'fph-end3'])
  })

  test("the salesperson's list keeps its own cells, the total labelled", () => {
    const markup = table(true)
    assert.deepEqual(cellClasses(markup), ['fph-l3', 'fph-title', 'fph-l2 fph-grow', 'fph-end2 fph-total', 'fph-end1', 'fph-l3', 'fph-l3', 'fph-end3'])
    assert.match(PHASE3, /td\.fph-total::before \{ content: 'Before GST '/)
  })

  test('the row is still the button that opens the payment', () => {
    assert.match(table(false), /<tr[^>]*role="button"/)
  })

  test('Upload statements leaves the phone header (Bank Statements is in the menu)', () => {
    assert.match(read('src/app/finance/page.tsx'), /className="boe-btn boe-btn-ghost boe-desktop-only">Upload statements<\/Link>/)
  })
})

describe('Bank Statements on a phone', () => {
  const view = read('src/app/finance/bank/BankStatementsView.tsx')

  test('each account card has one short line', () => {
    const markup = renderToStaticMarkup(createElement(BankSyncCheck, {
      account: 'all', onOpen: noop,
      overview: {
        accounts: ['hdfc', 'hdfc_sec'],
        months: [
          { account: 'hdfc', month: '2026-10', not_synced: 3, not_synced_amount: 1000, not_in_bank: 1 },
          { account: 'hdfc_sec', month: '2026-10', not_synced: 0, not_synced_amount: 0, not_in_bank: 0 },
        ],
        gaps: [],
      },
    }))
    assert.match(markup, /class="bank-sync-short bank-sync-bad">3 unmatched · 1 not in bank</)
    assert.match(markup, /class="bank-sync-short bank-sync-good">✓ All matched</)
    assert.match(PHASE3, /\.bank-sync-short \{ display: none; \}/)
  })

  test('the three tables are cards, and Upload statement is an icon in the header', () => {
    assert.match(view, /<div className="fin-table-wrap fph-list">/)
    assert.equal(view.split('className="fph-title"').length - 1, 3)
    assert.match(view, /boe-btn boe-btn-primary boe-desktop-only" onClick=\{\(\) => setUploading\(true\)\}>Upload statement</)
    assert.match(view, /boe-phone-only boe-header-icon boe-header-icon--add" aria-label="Upload statement"/)
  })

  test('Month and Account share one row of 44px selects', () => {
    assert.match(PHASE3, /\.bank-month select \{ width: 100%; height: 44px;/)
  })
})

describe('Reimbursements on a phone', () => {
  const view = read('src/app/finance/reimbursements/ReimbursementsView.tsx')

  test('search and one Filter button; the dates and dropdowns open in a sheet', () => {
    assert.match(view, /className=\{`boe-phone-only orders-phone-filter/)
    assert.match(view, /className=\{`reimb-filters\$\{filtersOpen \? ' is-open' : ''\}`\}/)
    assert.match(CSS, /\n\.reimb-filters \{ display: contents; \}/, 'the desktop toolbar is unchanged')
    assert.match(PHASE3, /\.reimb-filters\.is-open \{\s*position: fixed;/)
  })

  test('each reimbursement is a card, and Download Excel stays on a phone as an icon', () => {
    assert.match(view, /<div className="boe-card fph-list"/)
    assert.match(view, /data-testid="download-all-reimbursements"/)
    assert.match(view, /boe-phone-only boe-header-icon" aria-label=/)
  })
})

describe('the money-not-with-the-company strip on a phone', () => {
  const card = read('src/components/finance/UnclosedFundsCard.tsx')

  test('one line with a chevron; the detail opens under it', () => {
    assert.match(card, /className="boe-phone-only boe-unclosed-toggle" aria-expanded=\{phoneOpen\}/)
    assert.match(PHASE3, /\.boe-unclosed \.boe-unclosed-more \{ display: none !important; \}/)
    assert.match(PHASE3, /\.boe-unclosed-actions \.boe-btn \{ min-height: 44px !important;/)
  })
})

describe('the desktop is untouched', () => {
  test('outside the phone media queries, Phase 3 only hides phone-only pieces', () => {
    const outside = PHASE3.slice(PHASE3.indexOf('*/') + 2).replace(/@media \(max-width: 767px\) \{[\s\S]*?\n\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = outside.match(/[^{}]+\{[^}]*\}/g) ?? []
    assert.deepEqual(rules.map(r => r.trim()), [
      '.bank-sync-short { display: none; }',
      '.reimb-filters { display: contents; }',
      '.reimb-sheet-backdrop { display: none; }',
    ])
  })
})
