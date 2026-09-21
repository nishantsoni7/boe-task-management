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

import { PiApproveOrderModal, PiFinanceVerifyModal, type ApproveDialogMode } from './piReviewModals'
import {
  APPROVE_SUMMARY_EXTRA_LABEL,
  buildApprovalSummary,
} from '@/app/orders/drafts/[submissionId]/piDetailView'
import {
  ORDER_CONFIRMATION_LABEL,
  ORDER_CONFIRMATION_MESSAGE,
  resolveSavedSalesperson,
  validateOrderConfirmation,
  type OrderConfirmationDraft,
  type OrderConfirmationField,
} from '@/lib/orders/orderConfirmation'
import {
  APPROVE_ORDER_BUSY_LABEL,
  APPROVE_ORDER_CONFIRM_LABEL,
  APPROVE_ORDER_DIALOG_TITLE,
  APPROVE_ORDER_FINAL_NOTE,
  APPROVE_ORDER_NOT_A_PAYMENT,
  APPROVE_SUMMARY_LABEL,
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

/** The people the control offers, as the page reads them. */
const SALESPEOPLE = [
  { id: 'u-dhruv', name: 'Dhruv Mehta' },
  { id: 'u-priya', name: 'Priya Rao' },
  { id: 'u-nishant', name: 'Nishant Soni' },
]

const approveModal = (over: {
  saving?: boolean
  failure?: string | null
  client?: string
  productValue?: string
  advanceConfirmed?: string | null
  exception?: { reason: string | null; status: string | null } | null
  mode?: ApproveDialogMode
  confirmation?: OrderConfirmationDraft
  salespeople?: readonly { id: string; name: string }[]
  confirmationField?: OrderConfirmationField | null
} = {}): string =>
  renderToStaticMarkup(
    <PiApproveOrderModal
      client={over.client ?? 'Kalyan Interiors'}
      mode={over.mode ?? 'approve_and_create'}
      rows={buildApprovalSummary({
        client: over.client ?? 'Kalyan Interiors',
        productValue: over.productValue ?? '₹10,00,000',
        advanceConfirmed: over.advanceConfirmed === undefined ? '₹4,72,000' : over.advanceConfirmed,
        exception: over.exception ?? null,
      })}
      saving={over.saving ?? false}
      failure={over.failure ?? null}
      onCancel={() => {}}
      onConfirm={() => {}}
      salespeople={over.salespeople ?? SALESPEOPLE}
      confirmation={over.confirmation ?? {
        salesperson: null, confirmDate: null, dueDate: null, leadSource: null,
      }}
      onConfirmationChange={() => {}}
      confirmationField={over.confirmationField ?? null}
    />,
  )

/**
 * Which option a `<select>` opened on, by the field label it follows.
 *
 * React's SERVER render marks the chosen option with `selected` rather than
 * putting `value` on the select, so that is what is read here. Returns '' for
 * the placeholder — an unselected field — and null when the field is absent.
 */
const selectValue = (html: string, label: string): string | null => {
  const at = html.indexOf(label)
  if (at < 0) return null
  const open = html.indexOf('<select', at)
  if (open < 0) return null
  const block = html.slice(open, html.indexOf('</select>', open))
  const chosen = block.match(/<option\b[^>]*\bselected\b[^>]*>/)?.[0] ?? null
  if (!chosen) return null
  return chosen.match(/value="([^"]*)"/)?.[1] ?? ''
}

/** Whether the control after `label` is enabled and editable. */
const isEditable = (html: string, label: string): boolean => {
  const at = html.indexOf(label)
  if (at < 0) return false
  const tag = html.slice(at).match(/<(select|input)\b[^>]*>/)?.[0] ?? ''
  return tag !== '' && !tag.includes('disabled') && !tag.includes('readonly')
}

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

  test('shows the THREE facts a reviewer confirms against', () => {
    const body = text(html)
    assert.ok(body.includes('Kalyan Interiors'), 'client')
    assert.ok(body.includes(APPROVE_SUMMARY_EXTRA_LABEL.productValue))
    assert.ok(body.includes('₹10,00,000'), 'the product value')
    assert.ok(body.includes(APPROVE_SUMMARY_EXTRA_LABEL.advanceConfirmed))
    assert.ok(body.includes('₹4,72,000'), 'the confirmed advance')
  })

  test('THE SEVEN REPEATED ROWS ARE GONE from the rendered dialog', () => {
    const body = text(html)
    for (const gone of ['Grand total', 'Advance condition', 'Product lines',
                        'Approved payment', 'Pending / unapproved payment',
                        'Total attached payment', 'PI decision']) {
      assert.ok(!body.includes(gone), `${gone} is on the page behind this dialog`)
    }
    assert.ok(!/\bline(s)?\b/.test(body.replace(/inline/gi, '')), 'no product-line count')
    assert.ok(!body.includes(APPROVE_SUMMARY_LABEL.finance),
      'and nothing 20261226000000 removed has come back')
  })

  test('the product value is the PAGE\u2019S figure, never the grand total', () => {
    // The page prints ₹10,00,000 as "Product value" and ₹11,80,000 as the grand
    // total. The dialog must carry the first and never the second.
    const body = text(html)
    assert.ok(body.includes('₹10,00,000'))
    assert.ok(!body.includes('₹11,80,000'), 'the grand total is not this dialog\u2019s figure')
    for (const wrong of ['Total before GST', 'PI total', 'Billing value']) {
      assert.ok(!body.includes(wrong), `${wrong} is a different number`)
    }
  })

  test('Confirm date and Due date appear ONCE each, as editable inputs', () => {
    const body = text(html)
    // Once in the label of its own input, and nowhere as a read-only row.
    assert.equal(body.split(ORDER_CONFIRMATION_LABEL.confirm_date).length - 1, 1)
    assert.equal(body.split(ORDER_CONFIRMATION_LABEL.due_date).length - 1, 1)
    assert.ok(isEditable(html, 'Confirm date'), 'and it is still editable')
    assert.ok(isEditable(html, 'Due date'), 'and so is it')
    assert.equal((html.match(/type="date"/g) ?? []).length, 2, 'two date inputs, no more')
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

  test('long client names and long currency values wrap rather than clip', () => {
    const long = approveModal({
      client: 'Kalyan Interiors & Contract Furnishing Solutions Private Limited',
      productValue: '₹12,34,56,789',
    })
    assert.ok(text(long).includes('Kalyan Interiors & Contract Furnishing Solutions Private Limited'))
    assert.ok(long.includes('overflow-wrap:anywhere'), 'the VALUE breaks instead of overflowing')
    assert.ok(long.includes('flex-wrap:wrap'), 'and the row wraps before it pushes')
    assert.ok(!/overflow-x\s*:\s*(scroll|auto)/.test(long))
  })
})

// ── The salesperson the PI already names ──────────────────────────────────────

describe('the salesperson is preselected from the PI, or not at all', () => {
  test('1 · the PI\u2019s saved salesperson is preselected', () => {
    const saved = resolveSavedSalesperson({ savedName: 'Dhruv Mehta', options: SALESPEOPLE })
    assert.equal(saved, 'u-dhruv')
    const html = approveModal({ confirmation: {
      salesperson: saved, confirmDate: null, dueDate: null, leadSource: null,
    } })
    assert.equal(selectValue(html, ORDER_CONFIRMATION_LABEL.salesperson), 'u-dhruv')
  })

  test('2 · the SUBMITTER is never used as the salesperson', () => {
    // The PI names Dhruv; Nishant submitted it. Two different people, and the
    // dropdown must carry the first.
    const saved = resolveSavedSalesperson({ savedName: 'Dhruv Mehta', options: SALESPEOPLE })
    assert.equal(saved, 'u-dhruv')
    assert.notEqual(saved, 'u-nishant')
    // And a PI naming nobody does not borrow the submitter to fill the gap.
    assert.equal(resolveSavedSalesperson({ savedName: null, options: SALESPEOPLE }), null)
  })

  test('3 · the logged-in user is never an automatic fallback', () => {
    // IT CANNOT REACH FOR ONE. The resolver takes a saved name and a list of
    // options, and its body names no identity of any other kind.
    const source = resolveSavedSalesperson.toString()
    for (const leak of [/\bviewer\b/i, /\bsession\b/i, /\bauth\b/i,
                        /\bcurrentUser\b/i, /\bviewerId\b/i, /\bprofile\b/i]) {
      assert.ok(!leak.test(source), `${leak} is not an input to preselection`)
    }
    // And the page hands it exactly two things: the PI's name and the options.
    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    const call = page.slice(page.indexOf('resolveSavedSalesperson({'))
      .slice(0, page.slice(page.indexOf('resolveSavedSalesperson({')).indexOf('})') + 2)
    assert.ok(call.includes('savedName: documentAuthor'), 'the PI document\u2019s own name')
    assert.ok(call.includes('options: salespeople'))
    assert.ok(!/viewerId|session|profile|submitterName/.test(call),
      'no identity of the reader or the submitter is in reach of it')

    // Nor does it fall back to the only option, or the first one.
    assert.equal(resolveSavedSalesperson({ savedName: '', options: [SALESPEOPLE[0]] }), null)
    assert.equal(resolveSavedSalesperson({ savedName: 'Somebody Else', options: SALESPEOPLE }), null)
  })

  test('4 · a name that cannot be matched EXACTLY leaves the field unselected', () => {
    for (const unmatched of ['D. Mehta', 'Dhruv', 'Mehta', 'Dhruv M', 'Dhruvv Mehta', '—']) {
      assert.equal(resolveSavedSalesperson({ savedName: unmatched, options: SALESPEOPLE }), null,
        `"${unmatched}" must not be guessed into a person`)
    }
    // Case and stray whitespace are normalised — same person, not a guess.
    assert.equal(resolveSavedSalesperson({ savedName: '  dhruv   mehta ', options: SALESPEOPLE }), 'u-dhruv')
    // Two people of the same name is an ambiguity a machine must not resolve.
    assert.equal(resolveSavedSalesperson({
      savedName: 'Dhruv Mehta',
      options: [...SALESPEOPLE, { id: 'u-other', name: 'Dhruv Mehta' }],
    }), null)
  })

  test('4b · an unmatched salesperson keeps the existing required validation', () => {
    const draft: OrderConfirmationDraft = {
      salesperson: resolveSavedSalesperson({ savedName: 'D. Mehta', options: SALESPEOPLE }),
      confirmDate: '2026-01-31', dueDate: '2026-03-25', leadSource: 'reference',
    }
    assert.equal(draft.salesperson, null)
    const check = validateOrderConfirmation(draft)
    assert.equal(check.ok, false)
    assert.equal(check.ok === false && check.field, 'salesperson')
    assert.equal(check.ok === false && check.message, ORDER_CONFIRMATION_MESSAGE.salesperson)
    // And the dialog draws it as an empty, still-required control.
    const html = approveModal({ confirmation: draft })
    assert.equal(selectValue(html, ORDER_CONFIRMATION_LABEL.salesperson), '')
    assert.ok(text(html).includes('Select a salesperson…'))
  })

  test('5 · the dropdown stays editable, with every option still offered', () => {
    const html = approveModal({ confirmation: {
      salesperson: 'u-dhruv', confirmDate: null, dueDate: null, leadSource: null,
    } })
    assert.ok(isEditable(html, ORDER_CONFIRMATION_LABEL.salesperson),
      'preselected is not the same as decided')
    for (const person of SALESPEOPLE) {
      assert.ok(html.includes(`value="${person.id}"`), `${person.name} is still choosable`)
    }
    assert.ok(html.includes('Select a salesperson…'), 'and it can be cleared again')
  })

  test('12 · Lead source is still required, and still a select', () => {
    const html = approveModal()
    assert.ok(text(html).includes(`${ORDER_CONFIRMATION_LABEL.lead_source} *`))
    assert.ok(isEditable(html, ORDER_CONFIRMATION_LABEL.lead_source))
    const draft: OrderConfirmationDraft = {
      salesperson: 'u-dhruv', confirmDate: '2026-01-31', dueDate: '2026-03-25', leadSource: null,
    }
    const check = validateOrderConfirmation(draft)
    assert.equal(check.ok, false)
    assert.equal(check.ok === false && check.field, 'lead_source')
  })

  test('13 · Create Order behaviour and payload are untouched', () => {
    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    // The RPC, its name and its four parameters are exactly what they were.
    assert.ok(page.includes('p_assigned_to:   check.values.salesperson,'),
      'the id sent is still the VALIDATED draft value, not the preselection')
    assert.ok(page.includes('validateOrderConfirmation('),
      'and it still goes through the same gate')
    // Preselection only ever seeds the draft; it never reaches the call.
    assert.ok(!page.includes('p_assigned_to:   resolveSavedSalesperson'))
    assert.ok(!page.includes('resolveSavedSalesperson') || page.includes('setConfirmation(prev => ({'),
      'it is written into the draft the person can still change')
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
