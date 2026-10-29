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
  ORDER_CONFIRMATION_LABEL,
  matchWorkbookSalesperson,
  orderSalespersonFor,
  salespersonSelectorNote,
  validateOrderConfirmation,
  workbookSalespersonHint,
  type OrderConfirmationDraft,
  type OrderConfirmationField,
} from '@/lib/orders/orderConfirmation'
import { nameSubmitterAsSalesperson } from '@/lib/orders/salesOrderDetails'
import {
  APPROVE_ORDER_BUSY_LABEL,
  APPROVE_ORDER_CONFIRM_LABEL,
  APPROVE_ORDER_DIALOG_TITLE,
  APPROVE_ORDER_FINAL_NOTE,
  APPROVE_ORDER_NOT_A_PAYMENT,
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

type Provided = { salesperson: { id: string; name: string } | null; leadSource: string | null; confirmDate: string | null; dueDate: string | null }

/** A PI submitted today: it provides all four, so the dialog asks nothing. */
const PROVIDED_ALL: Provided = {
  salesperson: { id: 'u-dhruv', name: 'Dhruv Mehta' },
  leadSource: 'reference', confirmDate: '2026-01-31', dueDate: '2026-03-25',
}
const DRAFT_ALL: OrderConfirmationDraft = {
  salesperson: 'u-dhruv', confirmDate: '2026-01-31', dueDate: '2026-03-25', leadSource: 'reference',
}
/** An older PI that provides nothing. */
const PROVIDED_NONE: Provided = { salesperson: null, leadSource: null, confirmDate: null, dueDate: null }
const DRAFT_NONE: OrderConfirmationDraft = { salesperson: null, confirmDate: null, dueDate: null, leadSource: null }

const approveModal = (over: {
  saving?: boolean
  failure?: string | null
  client?: string
  mode?: ApproveDialogMode
  confirmation?: OrderConfirmationDraft
  salespeople?: readonly { id: string; name: string }[]
  confirmationField?: OrderConfirmationField | null
  provided?: Provided
  workbookSalesperson?: string | null
} = {}): string =>
  renderToStaticMarkup(
    <PiApproveOrderModal
      client={over.client ?? 'Kalyan Interiors'}
      mode={over.mode ?? 'approve_and_create'}
      saving={over.saving ?? false}
      failure={over.failure ?? null}
      onCancel={() => {}}
      onConfirm={() => {}}
      salespeople={over.salespeople ?? SALESPEOPLE}
      confirmation={over.confirmation ?? DRAFT_ALL}
      onConfirmationChange={() => {}}
      confirmationField={over.confirmationField ?? null}
      provided={over.provided ?? PROVIDED_ALL}
      workbookSalesperson={over.workbookSalesperson}
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

  test('says approval is final, a number is assigned, the Order is created, and who the salesperson is', () => {
    const body = text(html)
    assert.ok(body.includes(APPROVE_ORDER_FINAL_NOTE))
    assert.ok(/final/i.test(body))
    assert.ok(/official Order number/i.test(body))
    assert.ok(/confirmed Order will be created/i.test(body))
    assert.ok(body.includes('Salesperson: Dhruv Mehta'))
  })

  test('states, out loud, that it records NO payment', () => {
    assert.ok(text(html).includes(APPROVE_ORDER_NOT_A_PAYMENT))
  })

  test('RESTATES NOTHING the page behind it already shows (owner, 2026-10-30)', () => {
    const body = text(html)
    for (const gone of ['Total product value', 'Advance confirmed', 'Exception reason', 'Grand total',
                        'Advance condition', 'Product lines', 'Finance verification', 'PI decision',
                        'Confirm date', 'Due date', 'Lead source', 'Reference', 'From the PI',
                        'Billing percentage', 'Middleman commission', 'Pending from client']) {
      assert.ok(!body.includes(gone), `${gone} is on the page behind this dialog`)
    }
    assert.ok(!/\bline(s)?\b/.test(body.replace(/inline/gi, '')), 'no product-line count')
    assert.doesNotMatch(html, /data-review=/)
  })

  test('offers no Change links, no pickers and no inputs when the PI provides everything', () => {
    assert.ok(!buttonLabels(html).includes('Change'))
    assert.doesNotMatch(html, /<select/)
    assert.doesNotMatch(html, /<input/)
  })

  test('never shows or promises a specific number', () => {
    // The number does not exist until the RPC commits, and a dialog that showed
    // "the next number will be 0413" would be predicting the allocator.
    assert.ok(!/\b\d{4}\b/.test(text(html)))
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

  test('a long salesperson name wraps rather than clips', () => {
    const long = approveModal({
      provided: { ...PROVIDED_ALL, salesperson: { id: 'u-long', name: 'Venkata Subrahmanya Lakshmi Narasimha Prasad' } },
      confirmation: { ...DRAFT_ALL, salesperson: 'u-long' },
    })
    assert.ok(text(long).includes('Venkata Subrahmanya Lakshmi Narasimha Prasad'))
    assert.ok(long.includes('overflow-wrap:anywhere'))
    assert.ok(!/overflow-x\s*:\s*(scroll|auto)/.test(long))
  })

  test('the PI-only door asks nothing and names no salesperson', () => {
    const piOnly = approveModal({ mode: 'approve_pi', provided: PROVIDED_NONE, confirmation: DRAFT_NONE })
    assert.doesNotMatch(piOnly, /<select|<input/)
    assert.ok(!text(piOnly).includes('Salesperson'))
  })
})

// ── The salesperson the PI already names ──────────────────────────────────────

describe('the salesperson is never asked again when the PI or its submitter names one', () => {
  const complete = (salesperson: string | null): OrderConfirmationDraft =>
    ({ salesperson, confirmDate: '2026-01-31', dueDate: '2026-03-25', leadSource: 'reference' })
  const dhruv = { id: 'u-dhruv', name: 'Dhruv Mehta' }
  const priya = { id: 'u-priya', name: 'Priya Rao' }
  const nishant = { id: 'u-nishant', name: 'Nishant Soni' }

  test('1 · saved, else the one workbook match, else whoever submitted the PI', () => {
    assert.deepEqual(orderSalespersonFor({ saved: dhruv, workbookMatch: priya, submitter: nishant }), dhruv)
    assert.deepEqual(orderSalespersonFor({ saved: null, workbookMatch: priya, submitter: nishant }), priya)
    assert.deepEqual(orderSalespersonFor({ saved: null, workbookMatch: null, submitter: nishant }), nishant)
    assert.equal(orderSalespersonFor({ saved: null, workbookMatch: null, submitter: null }), null)
  })

  test('2 · a resolved salesperson is named, not asked, and is what is submitted', () => {
    const html = approveModal({ provided: { ...PROVIDED_ALL, salesperson: nishant }, confirmation: complete('u-nishant') })
    assert.ok(text(html).includes('Salesperson: Nishant Soni'))
    assert.ok(!html.includes('Select a salesperson…'))
    const check = validateOrderConfirmation(complete('u-nishant'))
    assert.equal(check.ok && check.values.salesperson, 'u-nishant')
  })

  test('3 · the workbook match is still exact: no match, a partial name and two people with one name select nobody', () => {
    assert.deepEqual(matchWorkbookSalesperson('  dhruv   MEHTA ', SALESPEOPLE), dhruv)
    assert.equal(matchWorkbookSalesperson('Somebody Else', SALESPEOPLE), null)
    assert.equal(matchWorkbookSalesperson('Dhruv', SALESPEOPLE), null)
    assert.equal(matchWorkbookSalesperson('—', SALESPEOPLE), null)
    assert.equal(matchWorkbookSalesperson(null, SALESPEOPLE), null)
    assert.equal(matchWorkbookSalesperson('Priya Rao', [...SALESPEOPLE, { id: 'u-priya2', name: 'priya  rao' }]), null)
  })

  test('4 · a PI that names nobody at all: the selector opens unselected, with the workbook name as a hint', () => {
    const html = approveModal({
      provided: { ...PROVIDED_ALL, salesperson: null },
      confirmation: complete(null),
      workbookSalesperson: 'Somebody Else',
    })
    assert.equal(selectValue(html, ORDER_CONFIRMATION_LABEL.salesperson), '', 'the selector opens unselected')
    assert.ok(text(html).includes('The workbook names “Somebody Else” — a hint only.'))
    assert.ok(!text(html).includes('Salesperson:'), 'nobody is named')
    for (const person of SALESPEOPLE) assert.ok(html.includes(`value="${person.id}"`), `${person.name} is choosable`)
    const check = validateOrderConfirmation(complete(null))
    assert.equal(check.ok === false && check.field, 'salesperson')
  })

  test('5 · when the database refuses the resolved person, the selector opens on them', () => {
    const html = approveModal({ confirmationField: 'salesperson' })
    assert.equal(selectValue(html, ORDER_CONFIRMATION_LABEL.salesperson), 'u-dhruv')
    assert.ok(isEditable(html, ORDER_CONFIRMATION_LABEL.salesperson))
    assert.ok(!text(html).includes('no saved salesperson'), 'the nobody-named note is not shown')
  })

  test('6 · the hint is the workbook’s name, tidied, and nothing for a blank or a dash', () => {
    assert.equal(workbookSalespersonHint('  Dhruv   Mehta '), 'Dhruv Mehta')
    for (const blank of [null, undefined, '', '   ', '—']) assert.equal(workbookSalespersonHint(blank), null)
    assert.equal(salespersonSelectorNote(null),
      'This PI has no saved salesperson. Choose the person responsible; nobody is selected for you.')
  })

  test('7 · the page resolves the salesperson from the PI and its submitter — never the viewer approving it', () => {
    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    assert.ok(page.includes('const orderSalesperson = orderSalespersonFor({'))
    assert.ok(page.includes('submitter: submission.submitted_by'))
    assert.ok(page.includes('salesperson: orderSalesperson?.id ?? null,'))
    assert.ok(page.includes('salesperson: orderSalesperson,'))
    assert.ok(page.includes('workbookSalesperson={workbookSalespersonHint(documentAuthor)}'))
    assert.ok(!/salesperson: *(viewerId|profile)/.test(page))
  })

  test('8 · Submit names the person submitting when Sales chose nobody — and only then', async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = []
    const client = (error: unknown = null) => ({
      rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ error }) },
    })
    const none = { available: true, salesperson_id: null, lead_source: 'website', sample_type: null }

    assert.deepEqual(await nameSubmitterAsSalesperson(client(), 'pi-1', none, 'u-nishant'), { error: null })
    assert.deepEqual(calls, [{ fn: 'set_order_submission_sales_details', args: {
      p_submission_id: 'pi-1', p_salesperson_id: 'u-nishant', p_lead_source: 'website', p_expected_version: null,
    } }], 'the submitter, with the lead source kept as loaded')

    calls.length = 0
    await nameSubmitterAsSalesperson(client(), 'pi-1', { ...none, salesperson_id: 'u-dhruv' }, 'u-nishant')
    await nameSubmitterAsSalesperson(client(), 'pi-1', { ...none, available: false }, 'u-nishant')
    await nameSubmitterAsSalesperson(client(), 'pi-1', none, null)
    assert.equal(calls.length, 0, 'a saved salesperson is never replaced, and nothing is guessed')

    const refused = { message: 'ORDER_SUBMISSION_NOT_EDITABLE' }
    assert.deepEqual(await nameSubmitterAsSalesperson(client(refused), 'pi-1', none, 'u-nishant'), { error: refused })

    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    const send = page.slice(page.indexOf('const send = async () => {'), page.indexOf('return supporting.send('))
    assert.ok(send.includes('nameSubmitterAsSalesperson(supabase, submissionId, salesDetails, viewerId)'),
      'run inside the send step, after the dates are saved')
    assert.ok(send.includes('if (named.error) return { data: null, error: named.error }'), 'a refusal sends nothing')
  })

  test('9 · a missing date or lead source is asked for; a given one is simply used', () => {
    const html = approveModal({
      provided: { ...PROVIDED_ALL, dueDate: null, leadSource: null },
      confirmation: { ...DRAFT_ALL, dueDate: null, leadSource: null },
    })
    assert.equal((html.match(/type="date"/g) ?? []).length, 1, 'only the missing due date')
    assert.ok(text(html).includes('Due date *') && !text(html).includes('Confirm date'))
    assert.ok(isEditable(html, ORDER_CONFIRMATION_LABEL.lead_source))
    const check = validateOrderConfirmation({ ...DRAFT_ALL, leadSource: null })
    assert.equal(check.ok === false && check.field, 'lead_source')
  })

  test('10 · an older PI that provides nothing asks for all four', () => {
    const html = approveModal({ provided: PROVIDED_NONE, confirmation: DRAFT_NONE })
    assert.equal((html.match(/type="date"/g) ?? []).length, 2)
    assert.equal((html.match(/<select/g) ?? []).length, 2)
  })

  test('13 · Create Order behaviour and payload are untouched', () => {
    const page = readFileSync('src/app/orders/drafts/[submissionId]/page.tsx', 'utf8')
    // The RPC, its name and its four parameters are exactly what they were.
    assert.ok(page.includes('p_assigned_to:   check.values.salesperson,'),
      'the id sent is still the VALIDATED draft value')
    assert.ok(page.includes('validateOrderConfirmation('),
      'and it still goes through the same gate')
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
