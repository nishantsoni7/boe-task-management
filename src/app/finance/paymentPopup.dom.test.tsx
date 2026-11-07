/**
 * THE PAYMENT REQUESTS POPUP, RUN FOR REAL.
 *
 * What the redesign promises and these prove on the real component:
 *   * every fact is stated ONCE (the record the money is for, the client, who
 *     sent it, the reason Finance gave);
 *   * the Decision comes before the history, names what each choice does, and
 *     draws nothing before a choice (no greyed Confirm);
 *   * Delete sits away from Edit;
 *   * the states keep their rules: a verifier never decides their own payment
 *     (and is told why), a verified payment is view-only with a way to its record,
 *     an admin's status correction opens on demand.
 *
 * Run: npm run test:file -- src/app/finance/paymentPopup.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { createClient } from '@/lib/supabase/client'
import { DetailsModal } from './paymentRequestsDetails'
import { fmtAmount, fmtDate, type PaymentRequest } from './paymentRequestsModel'

// next/link reads `self`, which jsdom's window has but the harness does not copy across.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true })

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

// ── A fake client: every table answers with the rows it was given ────────────
type Rows = Record<string, unknown[]>
type RpcCall = { name: string; args: unknown }

function fakeSupabase(tables: Rows, rpcError: string | null = null) {
  const rpcCalls: RpcCall[] = []
  const builder = (table: string) => {
    const b: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null })
        return () => b
      },
    })
    return b
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      return rpcError ? { data: null, error: { message: rpcError } } : { data: null, error: null }
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: 'no' } }) }) },
  }
  return { supabase: client as unknown as ReturnType<typeof createClient>, rpcCalls }
}

// ── What the projection says a payment is for ───────────────────────────────
const projectionRow = (over: Record<string, unknown>) => ({
  payment_request_id: 'p-1', destination_source: 'intent', destination_kind: 'confirmed_order',
  destination_order_count: 1, destination_submission_count: 0, destination_customer_count: 1,
  destination_order_id: 'o-1', destination_order_number: '0524', destination_submission_id: null,
  destination_reference: '0524', ...over,
})
// An old order is not in the projection: it reads Suspense there, and is named from the intent.
const OLD_ORDER_TABLES: Rows = {
  finance_payment_destinations: [projectionRow({
    destination_kind: 'suspense', destination_source: 'none', destination_order_count: 0,
    destination_order_id: null, destination_order_number: null, destination_reference: null,
  })],
  finance_payment_allocation_intents: [{ payment_request_id: 'p-1', legacy_order_no: '478' }],
}

const REQUEST: PaymentRequest = {
  id: 'p-1', request_number: 'PAY-REQ-2026-0094', human_payment_id: 'P-AA-0094',
  client_name: 'Northbliss', amount: 1191600, payment_date: '2026-11-06',
  payment_mode: 'pnb', received_in: null,
  collected_by_user_id: null, collected_from_text: null, handed_over_to_user_id: null,
  handed_over_at: null, collection_handover_note: null,
  proof_note: null, order_number: null, order_id: null, order_request_id: null, order_request_number: null,
  sales_note: null, payment_against: 'new_order', payment_target_type: '',
  status: 'pending_approval', submitted_by: 'u-mohit', submitted_by_name: 'Mohit Sharma',
  admin_note: null, created_at: '2026-11-07T07:14:00Z', updated_at: '2026-11-07T07:14:00Z',
  rejected_at: null, clarification_requested_at: null,
}

const SUBMITTED_ROW = {
  id: 'a-1', event_type: 'request_submitted', payload: {}, created_at: '2026-11-07T07:14:00Z',
  actor: { full_name: 'Mohit Sharma' },
}

type Props = Partial<Parameters<typeof DetailsModal>[0]>

async function open(tables: Rows, request: Partial<PaymentRequest>, props: Props = {}, rpcError: string | null = null) {
  const { supabase, rpcCalls } = fakeSupabase(tables, rpcError)
  const calls: string[] = []
  const ui = mount(
    <DetailsModal
      request={{ ...REQUEST, ...request }}
      onClose={() => calls.push('close')}
      supabase={supabase}
      userId="u-viewer"
      onCorrected={() => calls.push('corrected')}
      onEdit={() => calls.push('edit')}
      onDelete={() => calls.push('delete')}
      {...props}
    />,
  )
  cleanup = () => ui.unmount()
  await ui.settle()
  return { ui, calls, rpcCalls }
}

/** An admin who can verify: the viewer in the screenshot that started this. */
const ADMIN: Props = { isAdmin: true, mayCorrectPayments: true, mayApprovePayments: true, mayDecideOwnPayments: true }
const count = (text: string, part: string) => text.split(part).length - 1

describe('every fact is stated once', () => {
  test('the record the money is for appears in one place, and the old three are gone', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES, finance_payment_request_activity_log: [SUBMITTED_ROW] }, {}, ADMIN)
    const text = ui.text()
    assert.equal(count(text, 'Old order 478'), 1)
    assert.ok(text.includes('Not in BOE One'), 'what an old order is, as a caption under it')
    for (const gone of ['Payment Against', 'Order Number', 'What this payment is for', 'Read from the record itself']) {
      assert.ok(!text.includes(gone), `"${gone}" must not come back`)
    }
  })

  test('the client is in the header only, with the paid date; who sent it is in Activity only', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES, finance_payment_request_activity_log: [SUBMITTED_ROW] }, {}, ADMIN)
    const text = ui.text()
    assert.equal(count(text, 'Northbliss'), 1)
    assert.ok(text.includes(`Northbliss · Paid ${fmtDate('2026-11-06')}`))
    assert.ok(!text.includes('Submitted by'), 'the header no longer repeats the sender')
    assert.equal(count(text, 'Mohit Sharma'), 1, 'the sender is named once, in Activity')
  })

  test('the amount is in the header, once, beside the state', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    assert.equal(count(ui.text(), fmtAmount(1191600)), 1)
    assert.ok(ui.text().includes('Waiting for Finance'))
  })

  test('a reason from Finance is read once: the banner has it, Activity keeps who and when', async () => {
    const reason = 'The receipt shows ₹4,00,000 but the request says ₹4,50,000.'
    const { ui } = await open({
      ...OLD_ORDER_TABLES,
      finance_payment_request_activity_log: [
        { id: 'a-2', event_type: 'status_changed', payload: { to_status: 'needs_clarification', note: reason },
          created_at: '2026-11-07T09:40:00Z', actor: { full_name: 'Nitish Bansal' } },
        SUBMITTED_ROW,
      ],
    }, { status: 'needs_clarification', admin_note: reason }, { userId: 'u-mohit' })
    const text = ui.text()
    assert.equal(count(text, reason), 1)
    assert.ok(text.includes('Clarification required'))
    assert.ok(text.includes('Nitish Bansal'), 'who asked is still in Activity')
    assert.equal(ui.one('[role="note"]').textContent?.includes(reason), true)
  })

  test('an earlier round’s note is not hidden: only the one the banner shows', async () => {
    const earlier = 'First question: which account?'
    const latest = 'Second question: which date?'
    const { ui } = await open({
      ...OLD_ORDER_TABLES,
      finance_payment_request_activity_log: [
        { id: 'a-3', event_type: 'status_changed', payload: { to_status: 'needs_clarification', note: latest },
          created_at: '2026-11-08T09:00:00Z', actor: { full_name: 'Nitish Bansal' } },
        { id: 'a-2', event_type: 'status_changed', payload: { to_status: 'needs_clarification', note: earlier },
          created_at: '2026-11-07T09:00:00Z', actor: { full_name: 'Nitish Bansal' } },
        SUBMITTED_ROW,
      ],
    }, { status: 'needs_clarification', admin_note: latest }, { userId: 'u-mohit' })
    assert.equal(count(ui.text(), latest), 1)
    assert.equal(count(ui.text(), earlier), 1)
  })
})

describe('"Paid for" says whether the money is attached yet', () => {
  test('a pending request is a promise; a verified one is a fact', async () => {
    const promised = await open({ finance_payment_destinations: [projectionRow({})] }, {}, ADMIN)
    assert.ok(promised.ui.text().includes('Confirmed Order 0524'))
    assert.ok(promised.ui.text().includes('Attaches when verified'))
    promised.ui.unmount()
    const fact = await open({ finance_payment_destinations: [projectionRow({ destination_source: 'allocation' })] },
      { status: 'approved_linked' }, ADMIN)
    assert.ok(fact.ui.text().includes('Allocated'))
    assert.ok(!fact.ui.text().includes('Attaches when verified'))
  })

  test('nothing is claimed until the destination has been read', async () => {
    const { supabase } = fakeSupabase({})
    const ui = mount(<DetailsModal request={REQUEST} onClose={() => {}} supabase={supabase} userId="u-viewer" {...ADMIN} />)
    cleanup = () => ui.unmount()
    assert.ok(ui.text().includes('Reading…'))
    assert.ok(!ui.text().includes('Suspense'))
  })
})

describe('proof, reference and notes: one card', () => {
  test('a waiting payment without proof says so; empty reference and notes draw no rows', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    const text = ui.text()
    assert.ok(text.includes('No payment proof attached'))
    assert.ok(!text.includes('Reference') && !text.includes('No reference provided'))
    assert.ok(!text.includes('Notes') && !text.includes('No notes provided'))
  })

  test('a reference and a note appear when somebody wrote them', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, { proof_note: 'Slip 40918', sales_note: 'Collected by hand.' }, ADMIN)
    assert.ok(ui.text().includes('Slip 40918') && ui.text().includes('Collected by hand.'))
  })
})

describe('the Decision', () => {
  test('it comes before Activity, and nothing is drawn before a choice', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES, finance_payment_request_activity_log: [SUBMITTED_ROW] }, {}, ADMIN)
    const text = ui.text()
    const activity = ui.all('div').find(d => d.textContent === 'Activity')
    assert.ok(activity, 'the Activity heading is drawn')
    assert.ok(ui.one('[role="radiogroup"]').compareDocumentPosition(activity) & 4, 'Decision comes before Activity')
    assert.equal(ui.all('[role="radio"]').length, 3)
    assert.ok(!text.includes('Select a decision to continue'))
    assert.equal(ui.all('button').filter(b => b.textContent === 'Confirm').length, 0, 'no greyed Confirm')
    assert.equal(ui.all('textarea#decision-note').length, 0)
  })

  test('Verify: an optional note for the sender, a consequence from the destination, a named button', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    ui.click(ui.one('[role="radio"]'))
    assert.ok(ui.text().includes('Note for Mohit (optional)'))
    assert.ok(ui.text().includes("It will be verified as received and attached to Old order 478. Mohit is notified. This can't be undone from this page."))
    assert.equal(ui.button('Verify payment').disabled, false, 'a note is optional')
  })

  test('Reject and Needs Clarification need a note, say so beside it, and name their button', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    ui.click(ui.all('[role="radio"]')[2])
    assert.ok(ui.text().includes('Why you are rejecting it (required)'))
    assert.equal(ui.button('Reject payment').disabled, true)
    assert.ok(ui.text().includes('Required before you can send.'))
    ui.type(ui.one<HTMLTextAreaElement>('#decision-note'), 'Already recorded as P-AA-0071')
    assert.equal(ui.button('Reject payment').disabled, false)
    assert.ok(!ui.text().includes('Required before you can send.'))

    ui.click(ui.all('[role="radio"]')[1])
    assert.ok(ui.text().includes('Your question for Mohit (required)'))
    assert.equal(ui.button('Send to Mohit').disabled, false, 'the note typed so far is kept across the choices')
  })

  test('a reason of spaces is no reason', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    ui.click(ui.all('[role="radio"]')[2])
    ui.type(ui.one<HTMLTextAreaElement>('#decision-note'), '   ')
    assert.equal(ui.button('Reject payment').disabled, true)
  })

  test('Verify goes through the one approval door, and a refusal stays on screen', async () => {
    const { ui, rpcCalls, calls } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN, 'Somebody else decided first')
    ui.click(ui.one('[role="radio"]'))
    ui.click(ui.button('Verify payment'))
    await ui.settle()
    assert.deepEqual(rpcCalls.map(c => c.name), ['approve_finance_payment_request'])
    assert.ok(ui.text().includes('Somebody else decided first'))
    assert.ok(!calls.includes('corrected'), 'a refused decision closes nothing')
  })

  test('Cancel puts the card back as it was', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    ui.click(ui.one('[role="radio"]'))
    ui.click(ui.button('Cancel'))
    assert.equal(ui.all('textarea#decision-note').length, 0)
  })

  test('somebody who recorded the payment is told why they cannot decide it', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, { submitted_by: 'u-viewer' },
      { mayApprovePayments: true, mayDecideOwnPayments: false })
    assert.equal(ui.all('[role="radiogroup"]').length, 0)
    assert.ok(ui.text().includes('You recorded this payment, so another verifier decides it.'))
  })

  test('nobody is told that who may not decide anything anyway', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, { mayApprovePayments: false })
    assert.equal(ui.all('[role="radiogroup"]').length, 0)
    assert.ok(!ui.text().includes('You recorded this payment'))
  })
})

describe('the actions', () => {
  test('Delete is at the far left, away from Edit', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, ADMIN)
    const del = ui.button('Delete'), edit = ui.button('Edit')
    assert.equal(del.style.marginRight, 'auto')
    assert.ok(del.compareDocumentPosition(edit) & 4, 'Delete comes before Edit')
  })

  test('a salesperson reapplies a rejected request; the buttons call their handlers', async () => {
    const { ui, calls } = await open({ ...OLD_ORDER_TABLES }, { status: 'rejected', submitted_by: 'u-viewer' }, { userId: 'u-viewer' })
    ui.click(ui.button('Reapply'))
    ui.click(ui.button('Delete'))
    assert.deepEqual(calls, ['edit', 'delete'])
  })

  test('a reader who may do nothing gets no footer', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, {}, {})
    assert.equal(ui.all('button').filter(b => ['Edit', 'Delete', 'Reapply'].includes(b.textContent ?? '')).length, 0)
  })
})

describe('an administrator’s status correction', () => {
  const ADMIN_NOT_DECIDING: Props = { ...ADMIN, mayApprovePayments: false }

  test('it is a line that opens on demand, not a card with a dropdown', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, { status: 'rejected' }, ADMIN_NOT_DECIDING)
    assert.equal(ui.all('select[aria-label="Correct status"]').length, 0)
    const toggle = ui.button('Correct status')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    ui.click(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(ui.all('select[aria-label="Correct status"]').length, 1)
  })

  test('it never offers the verified statuses', async () => {
    const { ui } = await open({ ...OLD_ORDER_TABLES }, { status: 'rejected' }, ADMIN_NOT_DECIDING)
    ui.click(ui.button('Correct status'))
    const options = ui.all<HTMLOptionElement>('select[aria-label="Correct status"] option').map(o => o.value)
    assert.ok(options.length > 0 && !options.some(v => v.startsWith('approved')))
  })
})

describe('a verified payment', () => {
  test('is view-only here, and says where to manage it, with a link', async () => {
    const { ui } = await open({ finance_payment_destinations: [projectionRow({ destination_source: 'allocation' })] },
      { status: 'approved_linked' }, ADMIN)
    assert.ok(ui.text().includes('This payment is verified. It is managed in Confirmed Payments.'))
    const link = ui.all<HTMLAnchorElement>('a').find(a => (a.textContent ?? '').includes('Open in Confirmed Payments'))
    assert.ok(link, 'a way to the record')
    assert.equal(link.getAttribute('href'), '/finance/received?payment=p-1')
    assert.equal(ui.all('[role="radiogroup"]').length, 0)
    assert.equal(ui.all('button').filter(b => b.textContent === 'Edit').length, 0)
  })
})
