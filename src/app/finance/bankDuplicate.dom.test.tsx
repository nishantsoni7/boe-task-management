/**
 * THE DUPLICATE SECTION OF THE PAYMENT WINDOW — behaviour, run for real in a DOM.
 *
 * A pending request beside the payment already confirmed, and the one press that merges them
 * (merge_payment_request, 20270608000000). What a person sees, what each press sends, and what
 * happens when the database refuses. The rules themselves are the database's
 * (supabase/tests/payment_request_merge_pglite.mjs proves them).
 *
 * Run: npm run test:file -- src/app/finance/bankDuplicate.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BankMatchPanel } from './bankMarkUi'
import type { BankMark } from '@/lib/finance/bankMarks'
import type { MergeResult } from '@/lib/finance/paymentDuplicates'

// next/link reads `self`, which the DOM harness does not define.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true })

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

type Calls = [string, unknown[]][]
type Answer = { data?: unknown; error?: unknown }

const payRow = (over: Record<string, unknown> = {}) => ({
  id: 'E1', human_payment_id: 'P-AA-0089', client_name: null, status: 'approved_unlinked', amount: 1338565, payment_date: '2026-11-05',
  payment_mode: 'hdfc', proof_note: 'SBIN226309390349', created_at: '2026-11-06T09:00:00Z', submitted_by_user: { full_name: 'Nishant Soni' }, ...over,
})
const suspense = (id: string) => ({
  payment_request_id: id, destination_source: 'none', destination_kind: 'suspense', destination_order_count: 0,
  destination_submission_count: 0, destination_customer_count: 0, destination_order_id: null, destination_order_number: null,
  destination_submission_id: null, destination_reference: null,
})
const linkRow = { payment_id: 'E1', line_id: 'L1', bank_statement_lines: { line_date: '2026-11-05', statement_no: 143 } }

const request = {
  id: 'R1', human_payment_id: 'P-AA-0093', status: 'pending_approval', amount: 1338565, client_name: 'Northbliss', payment_date: '2026-11-05',
  payment_mode: 'hdfc', proof_note: null as string | null, submitted_by_name: 'Mohit Sharma', created_at: '2026-11-07T10:30:00Z',
}
const twin = (holders = [{ paymentId: 'E1', humanId: 'P-AA-0089', clientName: null as string | null, status: 'approved_unlinked' }]): BankMark => ({
  kind: 'lookalike', lineId: 'L1', lineDate: '2026-11-05', deposit: 1338565,
  narration: 'NEFT CR-SBIN0010098-NFSPROPERTIES-BEST OF EXPORTS-SBIN226309390349', holders,
})
const RESULT = {
  merged_request_id: 'R1', request_number: 'PAY-REQ-93', request_human_id: 'P-AA-0093', submitted_by: 'U-MOHIT', client_name: 'Northbliss',
  into_payment_id: 'E1', into_human_id: 'P-AA-0089', into_request_number: 'PAY-REQ-89', allocations_applied: 1, order_id: null, proof_files_moved: 1, bank_links_released: 0,
}

function open(opts: {
  payment?: Partial<typeof request>
  mark?: BankMark
  details?: unknown[]          // payments found by their details
  holders?: unknown[]          // payments holding the credit
  readFails?: boolean
  canVerify?: boolean
  urgent?: boolean
  refuse?: string
}) {
  const reads: string[] = []
  const sent: { fn: string; args: unknown }[] = []
  const merged: MergeResult[] = []
  const tables: Record<string, Answer | ((calls: Calls) => Answer)> = {
    finance_payment_requests: calls => (calls.some(([n, a]) => n === 'in' && a[0] === 'id') ? { data: opts.holders ?? [] } : { data: opts.details ?? [] }),
    bank_line_payment_links: { data: [linkRow] },
    payment_proof_attachments: { data: [{ payment_request_id: 'R1' }] },
    finance_payment_destinations: { data: [suspense('R1'), suspense('E1')] },
    finance_payment_allocations: { data: [] },
    finance_payment_allocation_intents: { data: [{ payment_request_id: 'R1', legacy_order_no: 'OLD-478' }] },
  }
  const supabase = {
    from: (table: string) => {
      reads.push(table)
      if (opts.readFails) throw new Error('offline')
      const calls: Calls = []
      const proxy: unknown = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'then') {
            const a = tables[table]
            const answer = typeof a === 'function' ? a(calls) : a ?? {}
            return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: answer.data ?? [], error: answer.error ?? null }).then(ok, bad)
          }
          return (...args: unknown[]) => { calls.push([prop, args]); return proxy }
        },
      })
      return proxy
    },
    rpc: async (fn: string, args: unknown) => {
      sent.push({ fn, args })
      return opts.refuse ? { data: null, error: { message: opts.refuse } } : { data: RESULT, error: null }
    },
  } as unknown as SupabaseClient
  const ui = mount(
    <BankMatchPanel
      supabase={supabase}
      payment={{ ...request, ...opts.payment }}
      mark={opts.mark ?? twin()}
      canVerify={opts.canVerify ?? true}
      canVerifyUrgent={opts.urgent ?? false}
      onChanged={() => {}}
      onVerified={() => {}}
      onMerged={r => { merged.push(r) }}
    />,
  )
  cleanup = () => ui.unmount()
  return { ui, reads, sent, merged }
}

describe('a request beside the payment already confirmed', () => {
  test('says it is a request, and lays the two side by side', async () => {
    const { ui } = open({ holders: [payRow()] })
    await ui.settle()
    const text = ui.text()
    assert.ok(text.includes('Sent by Mohit Sharma'))
    assert.ok(text.includes('This may already be in Confirmed Payments.'))
    assert.match(text, /P-AA-0089 has the same amount, date, account and bank credit as this request\./)
    assert.equal(ui.all('.bank-dup-head b').map(b => b.textContent).join(' | '), 'P-AA-0093 | P-AA-0089')
    for (const fact of ['Added by', 'Amount', 'Payment date', 'Account', 'Bank credit', 'UTR', 'Client', 'For', 'Proof']) assert.ok(text.includes(fact), fact)
    assert.ok(text.includes('Old order OLD-478'), 'what Sales asked for')
    assert.ok(text.includes('Merge applies it'))
    assert.ok(text.includes('Request left it blank'))
    assert.ok(text.includes('Same credit'))
    assert.equal(ui.all('.bank-dup-row.is-differs').length, 1, 'only the client differs')
  })

  test('the old "unlink, delete, then verify" advice is gone: merge replaces it', async () => {
    const { ui } = open({ holders: [payRow()] })
    await ui.settle()
    assert.ok(!ui.text().includes('May be a duplicate.'))
    assert.ok(!ui.text().includes('unlink that payment, delete it in Confirmed Payments'))
  })

  test('opens the payment and the credit it holds', async () => {
    const { ui } = open({ holders: [payRow()] })
    await ui.settle()
    assert.deepEqual(ui.all('a').map(a => a.getAttribute('href')), ['/finance/received?payment=E1', '/finance/bank?month=2026-11&credit=L1'])
  })

  test('Merge asks first, saying exactly what will happen, and sends nothing yet', async () => {
    const { ui, sent } = open({ holders: [payRow()] })
    await ui.settle()
    ui.click(ui.button('Merge into P-AA-0089'))
    const text = ui.text()
    assert.ok(text.includes('Merge P-AA-0093 into P-AA-0089?'))
    assert.ok(text.includes('It is applied to Old order OLD-478, as Sales asked.'))
    assert.ok(text.includes('P-AA-0093 is closed as merged. It is not rejected.'))
    assert.ok(text.includes('Mohit Sharma is told it was already recorded.'))
    assert.ok(text.includes('A merge cannot be undone from this window.'))
    assert.deepEqual(sent, [])
    ui.click(ui.button('Cancel'))
    assert.ok(ui.button('Merge into P-AA-0089'), 'back to the comparison')
    assert.deepEqual(sent, [])
  })

  test('confirming sends the one merge, with the note, and hands the answer on', async () => {
    const { ui, sent, merged } = open({ holders: [payRow()] })
    await ui.settle()
    ui.click(ui.button('Merge into P-AA-0089'))
    ui.type(ui.one<HTMLInputElement>('.bank-dup-confirm input'), 'Same NEFT, entered twice')
    ui.click(ui.all('.bank-dup-confirm button').find(b => (b.textContent ?? '').includes('Merge into P-AA-0089'))!)
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'merge_payment_request', args: { p_request_id: 'R1', p_into_payment_id: 'E1', p_note: 'Same NEFT, entered twice' } }])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].intoHumanId, 'P-AA-0089'); assert.equal(merged[0].submittedBy, 'U-MOHIT')
  })

  test('a blank note is sent as no note', async () => {
    const { ui, sent } = open({ holders: [payRow()] })
    await ui.settle()
    ui.click(ui.button('Merge into P-AA-0089'))
    ui.click(ui.all('.bank-dup-confirm button').find(b => (b.textContent ?? '').includes('Merge into P-AA-0089'))!)
    await ui.settle()
    assert.deepEqual((sent[0].args as { p_note: unknown }).p_note, null)
  })

  test('a refusal stays on the window, in a sentence, and nothing is announced', async () => {
    const { ui, merged } = open({ holders: [payRow()], refuse: 'MERGE_ALLOCATED_ELSEWHERE: P-AA-0089 is already allocated somewhere else' })
    await ui.settle()
    ui.click(ui.button('Merge into P-AA-0089'))
    ui.click(ui.all('.bank-dup-confirm button').find(b => (b.textContent ?? '').includes('Merge into P-AA-0089'))!)
    await ui.settle()
    assert.equal(merged.length, 0)
    assert.match(ui.one('[role="alert"]').textContent ?? '', /already allocated somewhere other than where Sales asked/)
    assert.ok(ui.button('Cancel'), 'still asking, so it can be tried again or cancelled')
  })
})

describe('when Merge is not offered', () => {
  test('without the right to decide, the comparison is shown and no Merge button is drawn', async () => {
    const { ui } = open({ holders: [payRow()], canVerify: false })
    await ui.settle()
    assert.ok(ui.text().includes('This may already be in Confirmed Payments.'))
    assert.equal(ui.all('button').filter(b => (b.textContent ?? '').includes('Merge')).length, 0)
  })

  test('a different amount says so in words and draws no Merge button', async () => {
    const { ui } = open({ holders: [payRow({ amount: 1338000 })] })
    await ui.settle()
    assert.match(ui.text(), /The amounts differ by ₹565\.00\./)
    assert.ok(ui.text().includes('Differs by ₹565.00'))
    assert.equal(ui.all('button').filter(b => (b.textContent ?? '').includes('Merge')).length, 0)
  })

  test('a payment not yet verified is shown, and the way forward is said', async () => {
    const { ui } = open({ holders: [payRow({ status: 'pending_approval' })] })
    await ui.settle()
    assert.match(ui.text(), /Verify one of the two, then merge the other into it\./)
    assert.equal(ui.all('button').filter(b => (b.textContent ?? '').includes('Merge')).length, 0)
  })
})

describe('found by its details, before any statement is uploaded', () => {
  test('a request with no credit yet still meets the payment already recorded', async () => {
    const { ui } = open({ mark: { kind: 'uncovered' }, details: [payRow()], urgent: true })
    await ui.settle()
    assert.ok(ui.text().includes('This may already be in Confirmed Payments.'))
    assert.ok(ui.button('Merge into P-AA-0089'))
    assert.ok(ui.text().includes('Request not linked'))
  })

  test('the search waits behind a link while a duplicate is on screen, and the urgent form stays closed', async () => {
    const { ui } = open({ mark: { kind: 'uncovered' }, details: [payRow()], urgent: true })
    await ui.settle()
    assert.equal(ui.all('.bank-search').length, 0)
    assert.equal(ui.all('.bank-form').length, 0)
    ui.click(ui.button('Look for a different credit'))
    assert.equal(ui.all('.bank-search').length, 1)
    assert.ok(ui.text().includes('This is different money, and it cannot wait'))
  })

  test('with two look-alikes the person picks which to compare', async () => {
    const { ui } = open({
      mark: { kind: 'uncovered' },
      details: [payRow(), payRow({ id: 'E2', human_payment_id: 'P-AA-0090', payment_date: '2026-11-01', client_name: 'Other Hotels' })],
    })
    await ui.settle()
    assert.ok(ui.text().includes('2 payments look like this one'))
    assert.equal(ui.all('.bank-dup-head b').map(b => b.textContent).join(' | '), 'P-AA-0093 | P-AA-0089')
    ui.click(ui.button('Compare'))
    assert.equal(ui.all('.bank-dup-head b').map(b => b.textContent).join(' | '), 'P-AA-0093 | P-AA-0090')
  })
})

describe('what stays as it was', () => {
  test('nothing like it: no duplicate section, and the panel is the one it always was', async () => {
    const { ui } = open({ mark: { kind: 'none' }, details: [] })
    await ui.settle()
    assert.equal(ui.all('.bank-dup').length, 0)
    assert.ok(ui.text().includes('No bank credit matches this payment.'))
  })

  test('a failed read leaves today\'s warning standing', async () => {
    const { ui } = open({ readFails: true, holders: [payRow()] })
    await ui.settle()
    assert.equal(ui.all('.bank-dup').length, 0)
    assert.ok(ui.text().includes('May be a duplicate.'))
  })

  test('a payment already verified never looks for a duplicate', async () => {
    const { ui, reads } = open({ payment: { status: 'approved_unlinked' }, holders: [payRow()] })
    await ui.settle()
    assert.deepEqual(reads, [])
    assert.equal(ui.all('.bank-dup').length, 0)
  })

  test('a cash payment is not looked for in the bank, so nothing is read', async () => {
    const { ui, reads } = open({ payment: { payment_mode: 'pnb' }, holders: [payRow()] })
    await ui.settle()
    assert.deepEqual(reads, [])
    assert.equal(ui.all('.bank-panel').length, 0)
  })
})
