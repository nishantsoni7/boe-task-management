/**
 * THE TWO PHASE C DIALOGS, ACTUALLY RENDERED.
 *
 * These are the last two decisions taken on a PI, and one of them is
 * irreversible: it creates a numbered Order that the business will refer to for
 * years. What the dialogs SAY is therefore part of the safety mechanism, not
 * decoration — in particular the sentence that neither of them records a payment,
 * because "Verify" and "Approve" beside a grand total are both read as "the
 * money is in" unless the screen says otherwise, and no payment record exists
 * anywhere in this phase to make that true.
 *
 * So this renders the REAL exports the PI detail page opens and reads the markup
 * that comes out. What it does NOT test is inline pixel values: a padding is a
 * design decision that will change, and a test that fails when a dialog breathes
 * differently is a test nobody keeps.
 *
 * Run:
 *   npx tsx --test src/components/orders/piApprovalModals.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import { PiApproveOrderModal, PiFinanceVerifyModal } from './piReviewModals'
import { buildApprovalSummary } from '@/app/orders/drafts/[submissionId]/piDetailView'
import {
  APPROVE_ORDER_BUSY_LABEL,
  APPROVE_ORDER_CONFIRM_LABEL,
  APPROVE_ORDER_DIALOG_TITLE,
  APPROVE_ORDER_FINAL_NOTE,
  APPROVE_ORDER_NOT_A_PAYMENT,
  FINANCE_SUMMARY_PENDING,
  FINANCE_SUMMARY_VERIFIED,
  VERIFY_FINANCE_BUSY_LABEL,
  VERIFY_FINANCE_BUTTON_LABEL,
  VERIFY_FINANCE_CONFIRM,
  VERIFY_FINANCE_DIALOG_TITLE,
  VERIFY_FINANCE_NOT_A_PAYMENT,
} from '@/lib/orders/finalApproval'

/** Text content, with the tags taken out — for "does it SAY this" checks. */
const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

const buttonLabels = (html: string): string[] =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]).trim())

/** Whether every button in the panel is disabled — the in-flight state. */
function allButtonsDisabled(html: string): boolean {
  const opens = [...html.matchAll(/<button\b([^>]*)>/g)].map(m => m[1])
  return opens.length > 0 && opens.every(attrs => attrs.includes('disabled=""'))
}

const verifyModal = (over: { saving?: boolean; failure?: string | null } = {}): string =>
  renderToStaticMarkup(
    <PiFinanceVerifyModal
      client="Kalyan Interiors"
      grandTotal="₹11,80,000"
      advanceLabel="Standard advance (40%)"
      saving={over.saving ?? false}
      failure={over.failure ?? null}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )

const approveModal = (over: {
  saving?: boolean
  failure?: string | null
  financeVerified?: boolean
  productCount?: number
  advanceLabel?: string
} = {}): string =>
  renderToStaticMarkup(
    <PiApproveOrderModal
      client="Kalyan Interiors"
      rows={buildApprovalSummary({
        client: 'Kalyan Interiors',
        grandTotal: '₹11,80,000',
        advanceLabel: over.advanceLabel ?? 'Standard advance (40%)',
        financeVerified: over.financeVerified ?? true,
        productCount: over.productCount ?? 3,
      })}
      saving={over.saving ?? false}
      failure={over.failure ?? null}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )

// ── Verify finance ────────────────────────────────────────────────────────────

describe('the finance verification dialog', () => {
  const html = verifyModal()

  test('is titled for what it does, and names the PI it is about', () => {
    assert.ok(text(html).includes(VERIFY_FINANCE_DIALOG_TITLE))
    assert.ok(text(html).includes('Kalyan Interiors'))
  })

  test('shows the two figures being signed off, and no more', () => {
    const body = text(html)
    assert.ok(body.includes('₹11,80,000'))
    assert.ok(body.includes('Standard advance (40%)'))
    // NOT the breakdown, the addresses or the products. They are on the page
    // behind this dialog in full, and a truncated copy helps nobody.
    for (const absent of ['GST', 'Discount', 'Ship to', 'Bill to', 'Transportation']) {
      assert.ok(!body.includes(absent), `${absent} belongs on the page, not in this dialog`)
    }
  })

  test('states what it IS confirming', () => {
    const body = text(html)
    assert.ok(body.includes(VERIFY_FINANCE_CONFIRM))
    assert.ok(/commercial figures/i.test(body))
    assert.ok(/advance terms/i.test(body))
  })

  test('states, out loud, that it records NO payment', () => {
    // The single most important sentence in this dialog.
    assert.ok(text(html).includes(VERIFY_FINANCE_NOT_A_PAYMENT))
    assert.ok(/does not record receipt of any payment/i.test(text(html)))
    assert.ok(/No payment, request or receipt is created/i.test(text(html)))
  })

  test('offers exactly Cancel and Verify Finance', () => {
    assert.deepEqual(buttonLabels(html), ['', 'Cancel', VERIFY_FINANCE_BUTTON_LABEL],
      'the first is the × control, which carries an aria-label rather than text')
    assert.ok(html.includes('aria-label="Close"'))
  })

  test('demands no typed confirmation — verification is a yes', () => {
    assert.ok(!html.includes('<textarea'))
    assert.ok(!html.includes('<input'))
  })

  test('in flight, nothing can be pressed twice', () => {
    const busy = verifyModal({ saving: true })
    assert.ok(text(busy).includes(VERIFY_FINANCE_BUSY_LABEL))
    assert.ok(allButtonsDisabled(busy),
      'the confirm, Cancel and the × control all go dead together')
  })

  test('a failure keeps the dialog open and says why, in fixed words', () => {
    const failed = verifyModal({ failure: 'You do not have permission to verify this PI for finance.' })
    assert.ok(text(failed).includes('You do not have permission to verify this PI for finance.'))
    assert.ok(text(failed).includes(VERIFY_FINANCE_DIALOG_TITLE), 'and the dialog is still there')
  })
})

// ── Approve & create ──────────────────────────────────────────────────────────

describe('the final approval dialog', () => {
  const html = approveModal()

  test('is titled Approve PI & Create Order', () => {
    assert.ok(text(html).includes(APPROVE_ORDER_DIALOG_TITLE))
    assert.equal(APPROVE_ORDER_DIALOG_TITLE, 'Approve PI & Create Order')
  })

  test('shows the five facts a reviewer confirms against', () => {
    const body = text(html)
    assert.ok(body.includes('Kalyan Interiors'), 'client')
    assert.ok(body.includes('₹11,80,000'), 'grand total')
    assert.ok(body.includes('Standard advance (40%)'), 'the declared advance condition')
    assert.ok(body.includes(FINANCE_SUMMARY_VERIFIED), 'the finance state')
    assert.ok(body.includes('3 lines'), 'the number of product lines')
  })

  test('does not repeat the advance figures the page already carries', () => {
    // The CONDITION is named; the rupee value stays on the page, where it is
    // derived once from the current grand total.
    const body = text(html)
    assert.ok(!/₹4,72,000/.test(body))
    assert.ok(!body.includes('Standard requirement'))
  })

  test('one product line reads as one line', () => {
    assert.ok(text(approveModal({ productCount: 1 })).includes('1 line'))
  })

  test('an unverified PI says so, rather than hiding the row', () => {
    // The dialog is only reachable when approval is READY, so this state should
    // not normally be seen — and if a stale screen ever produces it, the summary
    // must report it rather than imply a sign-off that never happened.
    assert.ok(text(approveModal({ financeVerified: false })).includes(FINANCE_SUMMARY_PENDING))
  })

  test('says approval is final, a number is assigned, and the Order is created', () => {
    const body = text(html)
    assert.ok(body.includes(APPROVE_ORDER_FINAL_NOTE))
    assert.ok(/final/i.test(body))
    assert.ok(/official Order number/i.test(body))
    assert.ok(/confirmed Order will be created/i.test(body))
  })

  test('states, out loud, that it records NO payment', () => {
    assert.ok(text(html).includes(APPROVE_ORDER_NOT_A_PAYMENT))
  })

  test('never shows or promises a specific number', () => {
    // The number does not exist until the RPC commits, and a dialog that showed
    // "the next number will be 0413" would be predicting the allocator.
    assert.ok(!/\b\d{4}\b/.test(text(html).replace(/₹[\d,]+/g, '').replace(/40%/g, '')))
  })

  test('offers exactly Cancel and Approve & Create Order', () => {
    assert.deepEqual(buttonLabels(html), ['', 'Cancel', APPROVE_ORDER_CONFIRM_LABEL])
  })

  test('in flight, nothing can be pressed twice', () => {
    const busy = approveModal({ saving: true })
    assert.ok(text(busy).includes(APPROVE_ORDER_BUSY_LABEL))
    assert.ok(allButtonsDisabled(busy))
  })

  test('a failure keeps the dialog open, and says no Order was created', () => {
    const failed = approveModal({
      failure: 'This PI could not be approved just now. Try again in a moment. No Order has been created.',
    })
    assert.ok(text(failed).includes('No Order has been created.'))
    assert.ok(text(failed).includes(APPROVE_ORDER_DIALOG_TITLE))
  })
})

// ── The rules both dialogs share ──────────────────────────────────────────────

describe('both dialogs follow the BOE form-modal rules', () => {
  const sources = readFileSync('src/components/orders/piReviewModals.tsx', 'utf8')

  test('a backdrop click is inert', () => {
    for (const html of [verifyModal(), approveModal()]) {
      const overlay = html.slice(0, html.indexOf('>') + 1)
      assert.ok(!overlay.includes('onClick'),
        'somebody may be mid-decision; a stray click must not discard it')
    }
    // The rule itself is not re-decided in this file.
    assert.ok(sources.includes('shouldCloseFormModal'))
  })

  test('Escape closes, and only while nothing is in flight', () => {
    assert.ok(sources.includes('useEscapeDismiss(dismiss, !saving)'))
    const dismissals = [...sources.matchAll(/const dismiss = \(reason[\s\S]{0,120}?\}/g)].map(m => m[0])
    assert.ok(dismissals.length >= 4)
    for (const body of dismissals) {
      assert.ok(/if \((saving|submitting|deleting)\) return/.test(body),
        'every dismissal refuses while a write is in flight')
    }
  })

  test('each is announced to a screen reader as a modal with a name', () => {
    for (const html of [verifyModal(), approveModal()]) {
      assert.ok(html.includes('role="dialog"'))
      assert.ok(html.includes('aria-modal="true"'))
      assert.ok(/aria-label="[^"]+"/.test(html))
    }
  })

  test('each fits a small screen and scrolls inside itself', () => {
    // The shared PANEL: capped at the viewport with its own vertical scroll, so
    // a long dialog never makes the PAGE scroll sideways or vertically behind it.
    for (const html of [verifyModal(), approveModal()]) {
      assert.ok(html.includes('max-width:460px'))
      assert.ok(html.includes('max-height:calc(100vh - 32px)'))
      assert.ok(html.includes('overflow-y:auto'))
      assert.ok(!/overflow-x\s*:\s*(scroll|auto)/.test(html),
        'nothing in a dialog may scroll horizontally')
    }
  })

  test('the footer buttons wrap rather than overflow', () => {
    for (const html of [verifyModal(), approveModal()]) {
      assert.ok(html.includes('flex-wrap:wrap'))
    }
  })

  test('the body is locked while either is open', () => {
    assert.ok((sources.match(/useScrollLock\(true\)/g) ?? []).length >= 4)
  })

  test('neither renders a raw database message', () => {
    // The page passes a fixed sentence chosen by describeSubmissionFailure, and
    // the dialogs render the string they are handed. They never see an error
    // OBJECT, so no build of them can print statement text, a column name or an
    // id by accident.
    //
    // `.message` is NOT forbidden outright: the browser's own validation
    // helpers legitimately return { ok: false, message } for a typed percentage
    // or an over-long reply, and refusing those would refuse the field-level
    // feedback that keeps somebody off a round trip. What must be absent is any
    // route from an ERROR to the markup.
    const modalCode = sources.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    for (const forbidden of [
      'error.message', 'err.message', 'PGRST', 'errcode', 'PostgrestError',
      'describeSubmissionFailure', 'supabase',
    ]) {
      assert.ok(!modalCode.includes(forbidden), `${forbidden} must not reach a dialog`)
    }
    // The only failure a dialog knows about is a plain string prop.
    assert.ok(modalCode.includes('failure: string | null'))
  })
})
