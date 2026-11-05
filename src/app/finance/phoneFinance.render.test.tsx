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
const PHASE3_AT = CSS.indexOf('PHONE PHASE 3 — FINANCE')
// The Finance block runs to the next Phase 3 block (several modules append theirs).
const PHASE3_NEXT = CSS.indexOf('PHONE PHASE 3 —', PHASE3_AT + 20)
const PHASE3 = CSS.slice(PHASE3_AT, PHASE3_NEXT < 0 ? undefined : CSS.lastIndexOf('/* ═', PHASE3_NEXT))

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

// ── PHONE PHASE 4 (owner, 2026-11-05): the Finance pages Phase 3 left below 8.5 ──
const PHASE4_AT = CSS.indexOf('PHONE PHASE 4 — ORDERS & FINANCE (owner')
const PHASE4_NEXT = CSS.indexOf('PHONE PHASE 4 —', PHASE4_AT + 20)
const PHASE4 = CSS.slice(PHASE4_AT, PHASE4_NEXT < 0 ? undefined : CSS.lastIndexOf('/* ═', PHASE4_NEXT))
const FOUNDERS_CSS = read('src/app/finance/founders/founders.module.css')
const FOUNDERS_PHONE = FOUNDERS_CSS.slice(FOUNDERS_CSS.indexOf('A phone, Phase 4'))

describe('Phase 4: header text buttons are icons on a phone, the words stay on a desktop', () => {
  test('a header holding them stays one row: the title gives way, never the icons', () => {
    assert.match(PHASE4, /\.boe-page-header:has\(\.fin-hdr-icons\) \{ flex-wrap: nowrap; \}/)
    assert.match(PHASE4, /\.boe-page-header:has\(\.fin-hdr-icons\) \.boe-header-actions \{ flex: none !important; flex-wrap: nowrap !important; \}/)
    for (const file of ['src/app/finance/expenses/ExpensesView.tsx', 'src/app/finance/founders/FounderPayoutsView.tsx']) {
      assert.ok(read(file).includes('<div className="fin-hdr-icons" style={{ display: \'flex\''), file)
    }
  })

  test('Expenses: Quick Capture is the mic, Add Expense the +', () => {
    const view = read('src/app/finance/expenses/ExpensesView.tsx')
    assert.match(view, /className="boe-btn boe-btn-ghost boe-desktop-only">\s*\{QUICK_CAPTURE_LABEL\}/)
    assert.match(view, /className="boe-btn boe-btn-primary boe-desktop-only">\s*Add Expense/)
    assert.match(view, /className="boe-phone-only boe-header-icon"\s*aria-label=\{QUICK_CAPTURE_LABEL\}/)
    assert.match(view, /className="boe-phone-only boe-header-icon boe-header-icon--add"\s*aria-label="Add Expense"/)
  })

  test('Payments to verify and Confirmed Payments: Record Payment is the +', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(view.includes('className="boe-btn boe-btn-primary boe-desktop-only"'))
    assert.match(view, /className="boe-phone-only boe-header-icon boe-header-icon--add"\s*aria-label=\{RECORD_PAYMENT_ACTION_LABEL\}/)
  })

  test("Founders' payouts: Download is an icon, New payout the +", () => {
    const view = read('src/app/finance/founders/FounderPayoutsView.tsx')
    assert.ok(view.includes('className="boe-btn boe-btn-ghost boe-desktop-only"'))
    assert.ok(view.includes('className="boe-btn boe-btn-primary boe-desktop-only" data-testid="new-founder-payout"'))
    assert.match(view, /className="boe-phone-only boe-header-icon"[^>]*aria-label=\{downloading \? 'Preparing the Excel file' : 'Download Excel'\}/)
    assert.match(view, /className="boe-phone-only boe-header-icon boe-header-icon--add"[^>]*aria-label="New payout"/)
  })
})

describe('Phase 4: filters open as a sheet from the bottom on a phone', () => {
  test('Expenses: the panel is fixed to the bottom edge, its dates and dropdowns 44px', () => {
    const view = read('src/app/finance/expenses/ExpensesView.tsx')
    assert.ok(view.includes('className="expense-filter-panel"'))
    assert.ok(view.includes('className="expense-filter-away"'))
    assert.match(PHASE4, /\.expense-filter-panel \{\s*position: fixed !important;[^}]*bottom: 0 !important;/)
    assert.match(PHASE4, /\.expense-filter-panel \.expense-filter-dates input \{[^}]*height: 44px; font-size: 16px;/)
    assert.match(PHASE4, /\.expense-filter-panel \.expense-filter-select \{ height: 44px !important; font-size: 16px !important; \}/)
  })

  test("Founders' payouts: the same sheet, with a Done that is drawn on a phone only", () => {
    const payments = read('src/app/finance/founders/FounderPayments.tsx')
    assert.ok(payments.includes('className={`boe-btn boe-btn-primary ${styles.filterDone}`} onClick={() => setFiltersOpen(false)}'))
    assert.match(FOUNDERS_CSS, /\n\.filterPanel \.filterDone \{ display: none; \}/)
    assert.match(FOUNDERS_PHONE, /\.filterPanel \{\s*position: fixed;[^}]*bottom: 0;/)
  })
})

describe("Phase 4: Founders' payouts never scrolls sideways on a phone", () => {
  test('Month by month is a list per side; the twelve-column grid is not drawn', () => {
    const overview = read('src/app/finance/founders/FounderOverview.tsx')
    assert.ok(overview.includes('<div className={styles.monthCards}>'))
    assert.ok(overview.includes('const paid = months.filter(m => (year.months.get(m)?.get(s.side) ?? 0) > 0)'))
    assert.ok(overview.includes('className={`fin-table-wrap ${styles.monthsWrap}`}'))
    assert.match(FOUNDERS_CSS, /\n\.monthCards \{ display: none; \}/, 'the desktop keeps the grid')
    assert.match(FOUNDERS_PHONE, /\.panel \.monthsWrap, \.panel \.monthsNote \{ display: none; \}/)
  })

  test('chips, links and the side switch are touch-sized, and no text is under 12px', () => {
    assert.match(FOUNDERS_PHONE, /\.roleChip \{ height: 40px;/)
    assert.match(FOUNDERS_PHONE, /\.link \{ display: inline-flex; align-items: center; min-height: 44px; \}/)
    assert.match(FOUNDERS_PHONE, /\.sideSwitch \{ height: 44px; \}/)
    assert.match(FOUNDERS_PHONE, /\.pickGroup \{ font-size: 12px; \}/)
  })
})
