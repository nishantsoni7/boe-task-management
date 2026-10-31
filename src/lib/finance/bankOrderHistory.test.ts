import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { orderSuggestionLabel, samePayer, suggestOrdersForLine, type PayerHistoryEntry } from './bankOrderHistory'

const HOTEL_NEW = '99999047729686-TPT-FURNITURE ADVANCE-HOTEL ALANKAR PRIVATE LIMITED'
const HOTEL_OLD = 'NEFT CR-KKBK0000958-HOTEL ALANKAR PRIVATE LIMITED-BESTOFEXPORTS-KKBKH26295886339'
const TGM = 'NEFT CR-KKBK0000958-TGM HOTEL LLP-BEST OF EXPORTS-KKBKH26295886339'

const entry = (over: Partial<PayerHistoryEntry>): PayerHistoryEntry => ({
  narration: HOTEL_OLD, lineDate: '2026-10-19', allocatedAmount: 250000, paymentId: 'p1', humanPaymentId: 'P-AA-0034',
  targetType: 'order', targetId: 'o1', reference: 'BE-ORD-1001', reservedOrderNumber: null, ...over,
})

describe('same payer', () => {
  test('the same company in two different narration layouts', () => {
    assert.equal(samePayer(HOTEL_NEW, HOTEL_OLD), true)
  })
  test('a different company is not the same payer', () => {
    assert.equal(samePayer(TGM, HOTEL_OLD), false)
    assert.equal(samePayer('REF-PAYUCON-KYQXK4MJAB52BNOVCQ-23/9/26', HOTEL_OLD), false)
  })
  test('a narration that names nobody never matches anything', () => {
    assert.equal(samePayer('SOME UNREADABLE TEXT', 'SOME UNREADABLE TEXT'), false)
  })
})

describe('order suggestions', () => {
  test('suggests where the earlier money from the same payer went, with the evidence', () => {
    const [s] = suggestOrdersForLine({ narration: HOTEL_NEW }, [entry({})])
    assert.equal(s.targetId, 'o1')
    assert.equal(s.times, 1)
    assert.equal(s.latest.humanPaymentId, 'P-AA-0034')
    assert.equal(orderSuggestionLabel(s), 'Order BE-ORD-1001')
  })

  test('nothing is suggested for another payer', () => {
    assert.deepEqual(suggestOrdersForLine({ narration: TGM }, [entry({})]), [])
  })

  test('the most used order comes first, at most two are offered', () => {
    const history = [
      entry({ paymentId: 'a', targetId: 'o1', lineDate: '2026-08-01' }),
      entry({ paymentId: 'b', targetId: 'o2', reference: 'BE-ORD-1002', lineDate: '2026-09-01' }),
      entry({ paymentId: 'c', targetId: 'o2', reference: 'BE-ORD-1002', lineDate: '2026-10-01' }),
      entry({ paymentId: 'd', targetId: 'o3', reference: 'BE-ORD-1003', lineDate: '2026-07-01' }),
    ]
    const out = suggestOrdersForLine({ narration: HOTEL_NEW }, history)
    assert.deepEqual(out.map(s => s.targetId), ['o2', 'o1'])
    assert.equal(out[0].times, 2)
    assert.equal(out[0].latest.paymentId, 'c')
  })

  test('a PI Draft is described by its reserved Order number when it has one', () => {
    const [s] = suggestOrdersForLine({ narration: HOTEL_NEW }, [
      entry({ targetType: 'pi_draft', reference: 'quote.xlsx', reservedOrderNumber: 'BE-ORD-2001' }),
    ])
    assert.equal(orderSuggestionLabel(s), 'PI for Order BE-ORD-2001 (quote.xlsx)')
  })
})

describe('the page and the migration', () => {
  const ROOT = join(__dirname, '..', '..', '..')
  const migration = readFileSync(join(ROOT, 'supabase', 'migrations', '20270419000000_finance_bank_add_confirmed_payment.sql'), 'utf8')

  test('the add function is definer, fixed search_path, no anon, and checks both permissions first', () => {
    assert.ok(/security definer\s*\r?\nset search_path = public, pg_temp/.test(migration))
    assert.ok(migration.includes('revoke all on function public.create_payment_from_bank_line(uuid, boolean) from public, anon'))
    assert.ok(migration.indexOf('assert_bank_reconcile_door()') < migration.indexOf("'create'"))
  })

  test('it goes through the ordinary payment door, links, and verifies only through complete_payment_entry', () => {
    assert.ok(migration.includes('public.submit_payment_request('))
    assert.ok(migration.includes('insert into public.bank_line_payment_links'))
    assert.ok(migration.includes('public.complete_payment_entry(v_pay_id)'))
    assert.ok(!migration.includes('approve_finance_payment_request'), 'verification has one door')
  })

  test('every duplicate guard is in the database, and the line is locked first', () => {
    for (const code of ['BANK_LINE_ALREADY_LINKED', 'BANK_LINE_CLASSIFIED', 'BANK_PAYMENT_DUPLICATE', 'BANK_PAYMENT_POSSIBLE_DUPLICATE']) {
      assert.ok(migration.includes(code), code)
    }
    assert.ok(migration.indexOf('for update') < migration.indexOf("raise exception 'BANK_PAYMENT_DUPLICATE"))
  })

  test('holds no account number (the repository is public)', () => {
    assert.ok(!/\b\d{10,}\b/.test(migration.replace(/20270419000000/g, '')))
  })

  test('the screen adds one payment per press and the word "Add to Confirmed" appears on it', () => {
    const modal = readFileSync(join(ROOT, 'src', 'app', 'finance', 'bank', 'bankAddConfirmedModal.tsx'), 'utf8')
    assert.ok(modal.includes("rpc('add_bank_line_to_confirmed'"))
    assert.ok(modal.includes('disabled={busy'))
    const dir = join(ROOT, 'src', 'app', 'finance', 'bank')
    assert.ok(readdirSync(dir).includes('bankAddConfirmedModal.tsx'))
  })
})
