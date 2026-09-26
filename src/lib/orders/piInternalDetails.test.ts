import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
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
