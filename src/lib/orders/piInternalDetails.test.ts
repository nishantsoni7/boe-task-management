import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SUBMISSION_DATE_LABEL,
  middlemanAnswerMissing,
  submissionCommissionBlock,
  submissionDateErrors,
  submissionDatesFrom,
  submissionDetailsSave,
  submissionNeedsConfirmation,
  submitWithInternalDates,
  SUBMISSION_CONFIRM_REQUIRED,
  INTERNAL_DETAILS_NETWORK_FAILURE,
  internalDetailsSaveFailure,
  COMMISSION_RESTRICTED_TEXT,
  PI_COMMISSION_COLUMNS,
  PI_INTERNAL_DETAIL_COLUMNS,
  withCommission,
  describeMiddleman,
  formatIsoDay,
  internalDetailsForm,
  internalDetailsMissing,
  internalDetailsPayload,
  internalDetailsReadiness,
  internalDetailsShapeErrors,
  internalDetailsSubmitBlock,
  workbookDateNotes,
  type PiInternalDetailsForm,
} from './piInternalDetails'
import { ORDER_PI_HANDOFF_COLUMNS } from './orderPiHandoff'
import { PI_DRAFT_DETAIL_COLUMNS } from './draftsView'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

const blankForm = (): PiInternalDetailsForm => internalDetailsForm({})

describe('internal details — what is missing, in the database\'s order', () => {
  test('nothing entered asks for the confirmation date first', () => {
    assert.equal(internalDetailsMissing({}), 'enter the order confirmation date')
  })

  test('a blank WORKBOOK date does not matter once the app date is entered', () => {
    const row = {
      order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
      workbook_order_confirmation_date: null, workbook_due_date: null,
      middleman_commission: 'no',
    }
    assert.equal(internalDetailsMissing(row), null)
    assert.deepEqual(internalDetailsReadiness(row), { ready: false, problem: 'confirm the internal details' })
  })

  test('due before confirmation is named (the 23 Sep / 15 Sep pair)', () => {
    assert.equal(internalDetailsMissing({ order_confirmation_date: '2026-09-23', due_date: '2026-09-15' }),
      'the due date is before the order confirmation date')
  })

  test('the middleman question must be answered', () => {
    assert.match(internalDetailsMissing({ order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }) ?? '',
      /Is there a middleman commission\?/)
  })

  test('Yes needs a recipient, a basis, and the figure for that basis', () => {
    const base = { order_confirmation_date: '2026-09-20', due_date: '2026-11-20', middleman_commission: 'yes' }
    assert.equal(internalDetailsMissing(base), 'name who receives the middleman commission')
    assert.equal(internalDetailsMissing({ ...base, middleman_recipient: 'Agent' }),
      'give the middleman commission as an amount or a percentage')
    assert.equal(internalDetailsMissing({ ...base, middleman_recipient: 'Agent', middleman_commission_basis: 'amount' }),
      'enter the middleman commission amount')
    assert.equal(internalDetailsMissing({ ...base, middleman_recipient: 'Agent', middleman_commission_basis: 'percent', middleman_commission_percent: 2 }),
      'enter the middleman commission percentage and what it is a percentage of')
    assert.equal(internalDetailsMissing({ ...base, middleman_recipient: 'Agent', middleman_commission_basis: 'percent',
      middleman_commission_percent: 2, middleman_commission_percent_of: 'total_before_gst' }), null)
  })

  test('complete and confirmed is ready; the submit dialog then has nothing to say', () => {
    const row = { order_confirmation_date: '2026-09-20', due_date: '2026-11-20', middleman_commission: 'no',
      internal_details_confirmed_at: '2026-09-26T11:00:00Z' }
    assert.deepEqual(internalDetailsReadiness(row), { ready: true })
    assert.equal(internalDetailsSubmitBlock(row), null)
    assert.match(internalDetailsSubmitBlock({}) ?? '', /^Before sending this PI for review, enter the order confirmation date in Internal details\.$/)
  })

  test('the screen mirrors the SQL check word for word', () => {
    const sql = read('supabase/migrations/20270122000000_order_submission_internal_details.sql')
    for (const phrase of [
      'enter the order confirmation date', 'enter the due date',
      'the due date is before the order confirmation date',
      'name who receives the middleman commission',
      'give the middleman commission as an amount or a percentage',
      'enter the middleman commission amount',
      'enter the middleman commission percentage and what it is a percentage of',
      'confirm the internal details',
    ]) {
      assert.ok(sql.includes(phrase), `the SQL readiness check says "${phrase}"`)
    }
  })
})

describe('internal details — the form', () => {
  test('No sends nothing else, even if something was typed on the Yes branch first', () => {
    const f = { ...blankForm(), middleman_commission: 'no' as const, middleman_recipient: 'typed then abandoned',
      middleman_commission_basis: 'amount' as const, middleman_commission_amount: '5000' }
    const p = internalDetailsPayload(f)
    assert.equal(p.middleman_commission, 'no')
    assert.equal(p.middleman_recipient, null)
    assert.equal(p.middleman_commission_basis, null)
    assert.equal(p.middleman_commission_amount, null)
  })

  test('each basis sends only its own figure', () => {
    const f = { ...blankForm(), middleman_commission: 'yes' as const, middleman_recipient: 'Agent',
      middleman_commission_basis: 'percent' as const, middleman_commission_amount: '5000',
      middleman_commission_percent: '2.5', middleman_commission_percent_of: 'grand_total' as const }
    const p = internalDetailsPayload(f)
    assert.equal(p.middleman_commission_amount, null)
    assert.equal(p.middleman_commission_percent, '2.5')
    assert.equal(p.middleman_commission_percent_of, 'grand_total')
  })

  test('the payload names exactly the keys the RPC accepts', () => {
    const sql = read('supabase/migrations/20270122000000_order_submission_internal_details.sql')
    for (const key of Object.keys(internalDetailsPayload(blankForm()))) {
      assert.ok(sql.includes(`'${key}'`), `${key} is an accepted key`)
    }
  })

  test('shape errors: date order, amount range and decimals, percentage range', () => {
    const f = blankForm()
    assert.ok(internalDetailsShapeErrors({ ...f, order_confirmation_date: '2026-09-23', due_date: '2026-09-15' }, null).due_date)
    assert.equal(internalDetailsShapeErrors({ ...f, order_confirmation_date: '2026-09-20', due_date: '2026-09-20' }, null).due_date, undefined)
    const yes = { ...f, middleman_commission: 'yes' as const, middleman_commission_basis: 'amount' as const }
    assert.ok(internalDetailsShapeErrors({ ...yes, middleman_commission_amount: '0' }, 100).middleman_commission_amount)
    assert.ok(internalDetailsShapeErrors({ ...yes, middleman_commission_amount: '1.234' }, 100).middleman_commission_amount)
    assert.ok(internalDetailsShapeErrors({ ...yes, middleman_commission_amount: '101' }, 100).middleman_commission_amount)
    assert.deepEqual(internalDetailsShapeErrors({ ...yes, middleman_commission_amount: '99.50' }, 100), {})
    const pct = { ...f, middleman_commission: 'yes' as const, middleman_commission_basis: 'percent' as const }
    assert.ok(internalDetailsShapeErrors({ ...pct, middleman_commission_percent: '120' }, null).middleman_commission_percent)
    assert.deepEqual(internalDetailsShapeErrors({ ...pct, middleman_commission_percent: '2.5' }, null), {})
  })
})

describe('internal details — what the reviewer reads', () => {
  test('describeMiddleman states the basis of a percentage', () => {
    assert.equal(describeMiddleman({}), 'Not answered')
    assert.equal(describeMiddleman({ middleman_commission: 'no' }), 'No')
    assert.equal(describeMiddleman({ middleman_commission: 'yes', middleman_recipient: 'Agent',
      middleman_commission_basis: 'percent', middleman_commission_percent: '2.5',
      middleman_commission_percent_of: 'total_before_gst' }), 'Yes — Agent, 2.5% of Total before GST')
    assert.match(describeMiddleman({ middleman_commission: 'yes', middleman_recipient: 'Agent',
      middleman_commission_basis: 'amount', middleman_commission_amount: 50000 }), /^Yes — Agent, ₹50,000/)
  })

  test('the app date and the workbook date are both shown when they differ — never chosen silently', () => {
    assert.deepEqual(workbookDateNotes({ order_confirmation_date: '2026-09-23', workbook_order_confirmation_date: '2026-09-20' }),
      ["The workbook's confirmation date is 20 Sep 2026; the app says 23 Sep 2026."])
    assert.deepEqual(workbookDateNotes({ order_confirmation_date: '2026-09-20', workbook_order_confirmation_date: '2026-09-20' }), [])
    assert.deepEqual(workbookDateNotes({ due_date: '2026-11-20', workbook_due_date: null }), [])
  })

  test('formatIsoDay has no time zone to get wrong', () => {
    assert.equal(formatIsoDay('2026-09-20'), '20 Sep 2026')
    assert.equal(formatIsoDay('2026-09-26T23:59:00+05:30'), '26 Sep 2026')
    assert.equal(formatIsoDay(null), null)
  })
})

describe('internal details — CLIENT PRIVACY', () => {
  // The workbook's OWN dates are not internal — they are what a client PDF
  // prints (clientDocumentPrivacy.test.ts proves the app dates are not, from
  // the rendered bytes). The internal answers are these:
  const INTERNAL = ['middleman', 'internal_details']

  test('the PI detail page reads them (the reviewer sees them)', () => {
    for (const c of PI_INTERNAL_DETAIL_COLUMNS) assert.ok(PI_DRAFT_DETAIL_COLUMNS.includes(c), c)
  })

  test('the column list behind the Order screen and BOTH PDF routes names no middleman or confirmation column', () => {
    for (const c of ORDER_PI_HANDOFF_COLUMNS) {
      for (const bad of INTERNAL) assert.ok(!String(c).includes(bad), `ORDER_PI_HANDOFF_COLUMNS carries ${c}`)
    }
  })

  test('no client-facing document, download or message module mentions them', () => {
    for (const file of [
      'src/lib/orders/confirmedPdf.ts',
      'src/lib/orders/confirmedPdfRender.ts',
      'src/lib/orders/piVersionPdf.ts',
      'src/app/api/orders/[id]/documents/route.ts',
      'src/app/api/orders/[id]/pi-versions/[versionId]/pdf/route.ts',
      'src/app/api/orders/submissions/notify/route.ts',
      'src/lib/pi/previewView.ts',
    ]) {
      const src = read(file)
      for (const bad of ['middleman', 'internal_details']) {
        assert.ok(!src.includes(bad), `${file} mentions ${bad}`)
      }
    }
  })
})

// 20270122000000 §1b: the commission is its own reader-only table. The PI row
// (readable by every Order viewer) carries no commission column at all.
describe('the commission, laid over the PI row only for a reader', () => {
  const commission = {
    middleman_commission: 'yes', middleman_recipient: 'Agent', middleman_commission_basis: 'amount',
    middleman_commission_amount: '50000', middleman_commission_percent: null, middleman_commission_percent_of: null,
  }
  const pi = { order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
    internal_details_confirmed_at: '2026-09-26T10:00:00Z' }

  test('the PI row reads no commission column; the commission read names all six', () => {
    for (const c of PI_INTERNAL_DETAIL_COLUMNS) assert.ok(!c.startsWith('middleman'), c)
    assert.ok(!PI_DRAFT_DETAIL_COLUMNS.includes('middleman'), 'PI_DRAFT_DETAIL_COLUMNS names no commission column')
    assert.equal(PI_COMMISSION_COLUMNS.split(', ').length, 6)
  })

  test('a reader sees the answer', () => {
    const row = withCommission(pi, commission, true)
    assert.equal(row.commission_restricted, false)
    assert.match(describeMiddleman(row), /^Yes — Agent, /)
  })

  test('anybody else sees "Restricted", never "Not answered", and no value survives', () => {
    const row = withCommission(pi, commission, false)
    assert.equal(describeMiddleman(row), COMMISSION_RESTRICTED_TEXT)
    assert.equal(row.middleman_recipient, null)
    assert.equal(row.middleman_commission_amount, null)
  })

  test('a restricted viewer is not told the answer is missing; readiness is the stamp', () => {
    assert.deepEqual(internalDetailsReadiness(withCommission(pi, null, false)), { ready: true })
    assert.deepEqual(internalDetailsReadiness(withCommission({ ...pi, internal_details_confirmed_at: null }, null, false)),
      { ready: false, problem: 'confirm the internal details' })
  })

  test('a reader with no row yet is "Not answered"', () => {
    const row = withCommission(pi, null, true)
    assert.equal(describeMiddleman(row), 'Not answered')
    assert.equal(internalDetailsMissing(row), 'answer "Is there a middleman commission?"')
  })
})

// Found in the 2026-09-27 workflow run: a dropped connection showed Sales the
// browser's bare 'TypeError: Failed to fetch'.
describe('internalDetailsSaveFailure', () => {
  test('a request that never arrived is said in plain language', () => {
    for (const message of ['TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      assert.equal(internalDetailsSaveFailure({ message, code: '' }), INTERNAL_DETAILS_NETWORK_FAILURE, message)
    }
  })
  test('a database refusal keeps its own words', () => {
    const refusal = 'ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION: the due date cannot be before the order confirmation date'
    assert.equal(internalDetailsSaveFailure({ message: refusal, code: 'P0001' }), refusal)
    assert.equal(internalDetailsSaveFailure(null), 'The internal details could not be saved.')
  })
})

// The checklist's internal-details gaps now come from withOrderDetailsRequirements —
// see salesOrderDetails.test.tsx.

// ── The two dates, at Submit for Approval (2026-09-27) ───────────────────────
//
// The upload no longer asks the client-facing workbook for Date of Order
// Confirmation or Dispatch Date Finalized; the Submit for Approval dialog does,
// and saves them through the SAME RPC into the SAME columns before sending.
describe('submission dates — required at Submit, in the workbook\'s words', () => {
  test('the labels are the workbook\'s own', () => {
    assert.equal(SUBMISSION_DATE_LABEL.order_confirmation_date, 'Date of Order Confirmation')
    assert.equal(SUBMISSION_DATE_LABEL.due_date, 'Dispatch Date Finalized')
  })

  test('both empty: submission is blocked, one message under each field', () => {
    assert.deepEqual(submissionDateErrors({ order_confirmation_date: '', due_date: '' }), {
      order_confirmation_date: 'Enter the Date of Order Confirmation.',
      due_date: 'Enter the Dispatch Date Finalized.',
    })
  })

  test('either one absent blocks it', () => {
    assert.deepEqual(Object.keys(submissionDateErrors({ order_confirmation_date: '2026-09-20', due_date: '' })), ['due_date'])
    assert.deepEqual(Object.keys(submissionDateErrors({ order_confirmation_date: '', due_date: '2026-11-20' })), ['order_confirmation_date'])
    assert.deepEqual(Object.keys(submissionDateErrors({ order_confirmation_date: '   ', due_date: '2026-11-20' })), ['order_confirmation_date'])
  })

  test('a date that is not a calendar date, or a dispatch before confirmation, is named', () => {
    assert.equal(submissionDateErrors({ order_confirmation_date: '2026-02-30', due_date: '2026-11-20' }).order_confirmation_date,
      'Enter a real calendar date.')
    assert.equal(submissionDateErrors({ order_confirmation_date: '2026-09-23', due_date: '2026-09-15' }).due_date,
      'The Dispatch Date Finalized cannot be before the Date of Order Confirmation.')
  })

  test('both present and in order: nothing to say', () => {
    assert.deepEqual(submissionDateErrors({ order_confirmation_date: '2026-09-20', due_date: '2026-09-20' }), {})
    assert.deepEqual(submissionDateErrors({ order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }), {})
  })

  test('the dialog opens on what the record holds', () => {
    assert.deepEqual(submissionDatesFrom({}), { order_confirmation_date: '', due_date: '' })
    assert.deepEqual(submissionDatesFrom({ order_confirmation_date: '2026-09-20', due_date: '2026-11-20T00:00:00Z' }),
      { order_confirmation_date: '2026-09-20', due_date: '2026-11-20' })
  })

  test('the date rule is the same as the SQL gate\'s, not a second one', () => {
    // Every date the dialog accepts, the gate's own mirror accepts too.
    for (const pair of [['2026-09-20', '2026-09-20'], ['2026-09-20', '2026-11-20']]) {
      const [c, d] = pair
      assert.deepEqual(submissionDateErrors({ order_confirmation_date: c, due_date: d }), {})
      assert.equal(internalDetailsMissing({ order_confirmation_date: c, due_date: d, middleman_commission: 'no' }), null)
    }
    // And every pair it refuses, the gate refuses.
    assert.equal(internalDetailsMissing({ order_confirmation_date: '2026-09-23', due_date: '2026-09-15' }),
      'the due date is before the order confirmation date')
  })
})

describe('submissionDetailsSave — what Submit writes before it sends', () => {
  const answered = { status: 'draft', middleman_commission: 'yes', middleman_recipient: 'Agent',
    middleman_commission_basis: 'amount', middleman_commission_amount: '50000' }

  test('unchanged and already confirmed: nothing is saved, the PI is simply sent', () => {
    const row = { ...answered, order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
      internal_details_confirmed_at: '2026-09-26T00:00:00Z' }
    assert.deepEqual(submissionDetailsSave(row, submissionDatesFrom(row)), { kind: 'none' })
  })

  test('new dates are saved as FULL STATE — the commission resent, never blanked — and confirmed', () => {
    const plan = submissionDetailsSave(answered, { order_confirmation_date: '2026-09-20', due_date: '2026-11-20' })
    assert.equal(plan.kind, 'save')
    if (plan.kind !== 'save') return
    assert.equal(plan.confirm, true)
    assert.deepEqual(plan.payload, {
      order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
      middleman_commission: 'yes', middleman_recipient: 'Agent',
      middleman_commission_basis: 'amount', middleman_commission_amount: '50000',
      middleman_commission_percent: null, middleman_commission_percent_of: null,
    })
  })

  test('same dates but never confirmed: saved once, with the confirmation', () => {
    const row = { ...answered, order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }
    assert.equal(submissionDetailsSave(row, submissionDatesFrom(row)).kind, 'save')
  })

  test('a changed date on a confirmed PI is saved again (the RPC clears and re-stamps)', () => {
    const row = { ...answered, order_confirmation_date: '2026-09-20', due_date: '2026-11-20',
      internal_details_confirmed_at: '2026-09-26T00:00:00Z' }
    assert.equal(submissionDetailsSave(row, { order_confirmation_date: '2026-09-20', due_date: '2026-12-01' }).kind, 'save')
  })

  test('a viewer who cannot read the commission is refused, so it is never erased', () => {
    const plan = submissionDetailsSave({ status: 'draft', commission_restricted: true },
      { order_confirmation_date: '2026-09-20', due_date: '2026-11-20' })
    assert.equal(plan.kind, 'refused')
  })

  test('the payload names only keys the RPC accepts', () => {
    const sql = read('supabase/migrations/20270122000000_order_submission_internal_details.sql')
    const plan = submissionDetailsSave(answered, { order_confirmation_date: '2026-09-20', due_date: '2026-11-20' })
    assert.equal(plan.kind, 'save')
    if (plan.kind !== 'save') return
    for (const key of Object.keys(plan.payload)) assert.ok(sql.includes(`'${key}'`), key)
  })
})

describe('what still waits outside the Submit dialog', () => {
  test('only the middleman answer', () => {
    assert.equal(submissionCommissionBlock({ middleman_commission: 'no' }), null)
    assert.equal(submissionCommissionBlock({}),
      'Before sending this PI for review, answer "Is there a middleman commission?" in Internal details.')
    assert.equal(middlemanAnswerMissing({ commission_restricted: true }), null)
  })
})

describe('the Submit dialog is wired to the one RPC and the one gate', () => {
  const page = () => read('src/app/orders/drafts/[submissionId]/page.tsx')
  test('the page submits through submitWithInternalDates, with the one RPC and the tick', () => {
    const src = page()
    const handler = src.slice(src.indexOf('const submitForApproval = useCallback('), src.indexOf('const submitForApproval = useCallback(') + 4500)
    assert.ok(handler.includes('await submitWithInternalDates({'))
    assert.ok(handler.includes("saveDetails: (payload, confirm) => supabase.rpc('save_order_submission_internal_details', {"))
    assert.ok(handler.includes('acknowledged,'), 'the tick is passed through, never assumed')
    assert.ok(handler.includes('savedEarlier: savedDatesRef.current,'), 'a retry knows what was already saved')
    assert.ok(handler.includes('if (result.saved) await loadDraft({ quiet: true })'), 'and the page re-reads after a partial success')
    const open = src.slice(src.indexOf('function openSubmit() {'), src.indexOf('function openSubmit() {') + 240)
    assert.ok(open.includes('savedDatesRef.current = null') && open.includes("setDialog('submit')"), 'a fresh dialog starts clean')
    assert.ok(src.includes('onSubmit: openSubmit'), 'the Complete PI details Submit control opens it')
  })
  test('the dialog is given the PI\'s internal details while it is being prepared, and the middleman block only', () => {
    const src = page()
    assert.ok(src.includes('internalDetails={internalDetailsStillOpen(submission) ? submission : null}'))
    assert.ok(src.includes('const internalSubmitBlock = submissionCommissionBlock(submission)'))
  })
  test('the server gate is still the trigger that checks both dates', () => {
    const sql = read('supabase/migrations/20270123000000_order_submission_internal_details_required_on_submit.sql')
    assert.ok(sql.includes("raise exception 'ORDER_SUBMISSION_INCOMPLETE: % before sending this PI for review'"))
    const problem = read('supabase/migrations/20270122000000_order_submission_internal_details.sql')
    assert.ok(problem.includes('enter the order confirmation date') && problem.includes('enter the due date'))
  })
})

// ── Save, then send: two transactions, and what the submitter is told ──────
describe('submitWithInternalDates — the sequence behind Submit', () => {
  const row = { status: 'draft', middleman_commission: 'no' }
  const dates = { order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }
  const describe_ = () => 'This PI could not be submitted just now. Try again in a moment.'

  function fakes(sendResults: { data: unknown; error: unknown }[], saveError: { message: string; code?: string } | null = null) {
    const calls: string[] = []
    const saved: { payload: Record<string, string | null>; confirm: boolean }[] = []
    return {
      calls, saved,
      saveDetails: async (payload: Record<string, string | null>, confirm: true) => {
        calls.push('save'); saved.push({ payload, confirm }); return { error: saveError }
      },
      send: async () => { calls.push('send'); return sendResults.shift() ?? { data: null, error: null } },
    }
  }

  test('without the tick nothing is written and nothing is sent', async () => {
    const f = fakes([{ data: {}, error: null }])
    const r = await submitWithInternalDates({ row, dates, acknowledged: false, savedEarlier: null,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, [])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.message, SUBMISSION_CONFIRM_REQUIRED)
  })

  test('with the tick: saved with the confirmation, then sent — both dates present succeeds', async () => {
    const f = fakes([{ data: { exception_requested: false }, error: null }])
    const r = await submitWithInternalDates({ row, dates, acknowledged: true, savedEarlier: null,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, ['save', 'send'])
    assert.equal(f.saved[0].confirm, true)
    assert.equal(f.saved[0].payload.order_confirmation_date, '2026-09-20')
    assert.equal(r.ok, true)
  })

  test('a refused save sends nothing and says the PI was not sent', async () => {
    const f = fakes([], { message: 'ORDER_SUBMISSION_STALE: this PI changed while you were editing it.', code: 'P0001' })
    const r = await submitWithInternalDates({ row, dates, acknowledged: true, savedEarlier: null,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, ['save'])
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.message ?? '', /ORDER_SUBMISSION_STALE/)
      assert.match(r.message ?? '', /The PI was not sent\.$/)
      assert.equal(r.saved, null)
    }
  })

  test('saved, then the send fails: the message says exactly that, and the dates are reported as saved', async () => {
    const f = fakes([{ data: null, error: { message: 'TypeError: Failed to fetch' } }])
    const r = await submitWithInternalDates({ row, dates, acknowledged: true, savedEarlier: null,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, ['save', 'send'])
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.deepEqual(r.saved, dates)
    assert.match(r.message ?? '', /^The dates were saved and the internal details confirmed, but the PI was not sent\./)
    assert.match(r.message ?? '', /Try again in a moment\./, 'with the send failure in its own words')
    assert.match(r.message ?? '', /Submit again to retry — the dates are kept and will not be saved twice\.$/)
    // No button label: after the supporting-files question the dialog's button
    // reads "Submit without these files", not "Submit for Approval".
    assert.ok(!/Press Submit for Approval/.test(r.message ?? ''))
  })

  test('the retry after that only sends — even before the page has re-read the record', async () => {
    // The worst case: the re-read after the failure did not land, so `row` is
    // still the unconfirmed one. The dates this dialog saved are remembered.
    const f = fakes([{ data: {}, error: null }])
    const r = await submitWithInternalDates({ row, dates, acknowledged: true, savedEarlier: dates,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, ['send'], 'no second save, so no stale-version refusal')
    assert.equal(r.ok, true)
  })

  test('the retry after the re-read also only sends: the record is now confirmed with those dates', async () => {
    const reread = { ...row, ...dates, internal_details_confirmed_at: '2026-09-27T12:00:00Z' }
    assert.equal(submissionNeedsConfirmation(reread, dates), false, 'nothing left to tick')
    const f = fakes([{ data: {}, error: null }])
    await submitWithInternalDates({ row: reread, dates, acknowledged: false, savedEarlier: null,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, ['send'])
  })

  test('changing a date after a failed send saves the new dates (and asks for the tick again)', async () => {
    const changed = { ...dates, due_date: '2026-12-01' }
    const reread = { ...row, ...dates, internal_details_confirmed_at: '2026-09-27T12:00:00Z' }
    assert.equal(submissionNeedsConfirmation(reread, changed), true)
    const f = fakes([{ data: {}, error: null }])
    await submitWithInternalDates({ row: reread, dates: changed, acknowledged: true, savedEarlier: dates,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, ['save', 'send'])
  })

  test('nothing to save: a send failure is left for the usual wording', async () => {
    const confirmed = { ...row, ...dates, internal_details_confirmed_at: '2026-09-27T12:00:00Z' }
    const f = fakes([{ data: null, error: { message: 'ORDER_SUBMISSION_INCOMPLETE: x' } }])
    const r = await submitWithInternalDates({ row: confirmed, dates, acknowledged: false, savedEarlier: null,
      saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.equal(r.ok, false)
    if (!r.ok) { assert.equal(r.message, null); assert.equal(r.saved, null) }
  })

  test('a restricted viewer is refused before anything is written', async () => {
    const f = fakes([])
    const r = await submitWithInternalDates({ row: { status: 'draft', commission_restricted: true }, dates,
      acknowledged: true, savedEarlier: null, saveDetails: f.saveDetails, send: f.send, describeSendFailure: describe_ })
    assert.deepEqual(f.calls, [])
    assert.equal(r.ok, false)
  })
})
