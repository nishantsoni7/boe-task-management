/**
 * 20270612000000 — a PNB, Paytm or Canara payment is Confirmed when its cash is
 * WITH THE COMPANY (the company cash custodian accepted or received it), and
 * from no other door.
 *
 * The behaviour is proven on PGlite by
 * supabase/tests/non_hdfc_confirmed_on_company_receipt_pglite.mjs (18 checks).
 * This pins the migration's restated bodies against their sources, the screen
 * helper, and the screens that stop offering Verify.
 *
 * Run: npm run test:file -- src/lib/finance/nonHdfcConfirmedOnCompanyReceipt.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { awaitsCompanyCash, CONFIRMED_WHEN_CASH_ARRIVES, ACCEPT_CONFIRMS_NOTE } from './cashJourney'
import { bankVerifyRefusal } from './bankMarks'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const NEW = read('supabase/migrations/20270612000000_finance_non_hdfc_confirmed_on_company_receipt.sql')
const M418 = read('supabase/migrations/20270418000000_finance_handover_not_received_final.sql')
const M516 = read('supabase/migrations/20270516000000_finance_bank_proof_before_verify.sql')

/** One CREATE OR REPLACE FUNCTION statement, up to the closing dollar-quote line. */
function fnBody(sql: string, name: string): string[] {
  const lines = sql.split('\n')
  const start = lines.findIndex(l => l.toLowerCase().startsWith(`create or replace function public.${name}(`))
  assert.ok(start >= 0, `${name} is defined`)
  let tag: string | null = null
  const out: string[] = []
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    if (!tag) { const m = /(\$[a-z_]*\$)/i.exec(lines[i]); if (m) tag = m[1]; continue }
    if (lines[i].includes(tag) && /;\s*$/.test(lines[i])) break
  }
  return out
}

/** Every line of `old` appears in `next`, in order: `next` only ADDED lines. */
function onlyAdds(old: string[], next: string[]): boolean {
  let j = 0
  for (const line of old) {
    while (j < next.length && next[j] !== line) j++
    if (j === next.length) return false
    j++
  }
  return true
}

describe('the migration restates three bodies and only adds to them', () => {
  test('accept_cash_handover: the 20270418000000 body plus one confirming block', () => {
    const old = fnBody(M418, 'accept_cash_handover')
    const next = fnBody(NEW, 'accept_cash_handover')
    assert.ok(onlyAdds(old, next), 'every old line is still there, in order')
    const added = next.filter(l => !old.includes(l)).join('\n')
    assert.match(added, /finance_confirm_payment_on_company_receipt\(/)
    assert.doesNotMatch(next.join('\n'), /approve_finance_payment_request/, 'it goes through the helper, never the door directly')
  })

  test('receive_cash_directly: the 20270418000000 body plus one confirming call', () => {
    const old = fnBody(M418, 'receive_cash_directly')
    const next = fnBody(NEW, 'receive_cash_directly')
    assert.ok(onlyAdds(old, next))
    assert.match(next.join('\n'), /finance_confirm_payment_on_company_receipt\(\s*v_id,/)
  })

  test('complete_payment_entry: the 20270516000000 body plus the cash wait, after the bank wait', () => {
    const old = fnBody(M516, 'complete_payment_entry')
    const next = fnBody(NEW, 'complete_payment_entry')
    assert.ok(onlyAdds(old, next))
    const text = next.join('\n')
    assert.ok(text.indexOf('finance_payment_awaits_bank_match') < text.indexOf('finance_payment_awaits_company_cash'))
    assert.ok(text.indexOf('finance_payment_awaits_company_cash') < text.indexOf('approve_finance_payment_request'),
      'the wait comes before the one verification door is called')
    assert.match(text, /'waiting_for_cash', true/)
  })

  test('the pending-only guard and "not received is final" survive in the restated handover bodies', () => {
    for (const name of ['accept_cash_handover', 'receive_cash_directly']) {
      assert.doesNotMatch(fnBody(NEW, name).join('\n'), /'pending', 'disputed'/, name)
    }
    assert.match(fnBody(NEW, 'accept_cash_handover').join('\n'), /if v_h\.status <> 'pending' then/)
  })
})

describe('the rule and its helpers', () => {
  test('the trigger fires on status and payment_mode only, and refuses with the greppable codes', () => {
    assert.match(NEW, /create trigger finance_payment_requests_require_company_cash\s+before update of status, payment_mode on public\.finance_payment_requests/)
    assert.match(NEW, /PAYMENT_NEEDS_COMPANY_CASH/)
    assert.match(NEW, /PAYMENT_EDIT_NEEDS_COMPANY_CASH/)
  })

  test('test data is exempt and only the custody modes are watched', () => {
    const awaits = fnBody(NEW, 'finance_payment_awaits_company_cash').join('\n')
    assert.match(awaits, /payment_mode_requires_custody\(p_mode\)/)
    assert.match(awaits, /not coalesce\(p_is_test, false\)/)
    assert.match(awaits, /not public\.finance_payment_is_closed\(p_payment_id\)/)
  })

  test('the confirming helper goes through the one verification door, in its own sub-transaction, and never raises', () => {
    const fn = fnBody(NEW, 'finance_confirm_payment_on_company_receipt').join('\n')
    assert.match(fn, /public\.approve_finance_payment_request\(p_payment_id, p_note\)/)
    assert.match(fn, /exception when others then\s+raise warning/)
    assert.match(fn, /v_pay\.status <> 'pending_approval'/)
    assert.match(fn, /finance_payment_is_closed\(p_payment_id\)/)
  })

  test('no helper is granted to a client role, and the migration writes no data', () => {
    for (const f of ['finance_payment_awaits_company_cash(uuid, text, boolean)', 'finance_payment_requests_require_company_cash()', 'finance_confirm_payment_on_company_receipt(uuid, text)']) {
      assert.ok(NEW.includes(`revoke all on function public.${f} from public, anon, authenticated;`), f)
    }
    assert.doesNotMatch(NEW.replace(/^--.*$/gm, ''), /^\s*(insert into|update|delete from)\s+public\.finance_payment_requests/im)
  })
})

describe('the screens', () => {
  const state = (s: string) => ({ state: s as 'with_holder' })

  test('awaitsCompanyCash: tracked and known to be elsewhere', () => {
    for (const s of ['with_holder', 'waiting', 'disputed']) {
      for (const m of ['pnb', 'paytm', 'canara']) assert.equal(awaitsCompanyCash(m, state(s)), true, `${m} ${s}`)
    }
    assert.equal(awaitsCompanyCash('pnb', state('with_company')), false)
  })

  test('awaitsCompanyCash: HDFC accounts and unknown states keep their Verify', () => {
    assert.equal(awaitsCompanyCash('hdfc', state('with_holder')), false)
    assert.equal(awaitsCompanyCash('hdfc_sec', state('waiting')), false)
    assert.equal(awaitsCompanyCash('paytm', undefined), false)
    assert.equal(awaitsCompanyCash('paytm', null), false)
    assert.equal(awaitsCompanyCash(undefined, state('waiting')), false)
  })

  test('the database refusals read as sentences, and unrelated errors are left alone', () => {
    assert.match(bankVerifyRefusal('PAYMENT_NEEDS_COMPANY_CASH: payment X is not with the company yet') ?? '', /cash custodian accepts it/)
    assert.match(bankVerifyRefusal('PAYMENT_EDIT_NEEDS_COMPANY_CASH: …') ?? '', /cash is not with the company/)
    assert.equal(bankVerifyRefusal('something else'), null)
  })

  test('the words are said once and used', () => {
    assert.equal(CONFIRMED_WHEN_CASH_ARRIVES, 'Confirmed when the cash reaches the company')
    assert.match(ACCEPT_CONFIRMS_NOTE, /accepting also confirms/)
    for (const f of ['src/components/finance/CashPaymentActions.tsx', 'src/components/finance/HandoverCard.tsx', 'src/app/modules/AttentionPanel.tsx']) {
      assert.match(read(f), /ACCEPT_CONFIRMS_NOTE/, f)
    }
  })

  test('Payment Requests popup: no Verify while the cash is elsewhere, and the page reads the state', () => {
    const details = read('src/app/finance/paymentRequestsDetails.tsx')
    assert.match(details, /const waitingForCash = !!awaitsCash && !verifiedAtTheBank/)
    assert.match(details, /verifiedAtTheBank \|\| waitingForCash \? DECISIONS\.filter\(d => d\.key !== 'approve'\)/)
    const page = read('src/app/finance/page.tsx')
    assert.match(page, /awaitsCash=\{awaitsCompanyCash\(detailRequest\.payment_mode, detailCash\.data\?\.get\(detailRequest\.id\)\)\}/)
  })

  test('PI / Order payment rows: Approve is wrapped for tracked rows only (an untracked row needs no query)', () => {
    const src = read('src/components/orders/PiPaymentCard.tsx')
    assert.match(src, /row\.tracksCash \? \(\s*(\/\/[^\n]*\n\s*)?<ApproveUnlessCashPending paymentId=\{row\.paymentId\}>\{approveButton\}<\/ApproveUnlessCashPending>\s*\) : approveButton/)
    const wrapper = read('src/components/finance/ApproveUnlessCashPending.tsx')
    assert.match(wrapper, /awaitsCompanyCash\(p\?\.paymentMode, p\)/)
  })

  test('nothing special-cases Canara in the cash words any more', () => {
    for (const f of ['src/lib/finance/cashJourney.ts', 'src/lib/finance/cashJourneyBoard.ts', 'src/lib/finance/handover.ts',
      'src/components/finance/CashPaymentActions.tsx', 'src/app/finance/handovers/page.tsx']) {
      assert.doesNotMatch(read(f), /isCanaraMode/, f)
    }
  })
})
