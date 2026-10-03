/**
 * A salesperson deleting their own never-approved payment request: the client
 * policy, the failure wording, the call, the confirmation dialog — and the
 * migration that is the actual authority.
 *
 * Run: npx tsx --test src/lib/finance/ownPaymentRequestDeletion.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  canDeleteOwnPaymentRequest,
  deleteOwnPaymentRequest,
  describeOwnDeleteFailure,
  OWN_DELETE_CANCEL_LABEL,
  OWN_DELETE_CONFIRM_LABEL,
  OWN_DELETE_MESSAGE,
  OWN_DELETE_TITLE,
} from './ownPaymentRequestDeletion'
import { DeleteOwnPaymentRequestModal } from '@/components/finance/DeleteOwnPaymentRequestModal'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const ME = 'a1000000-0000-4000-8000-000000000001'
const OTHER = 'a1000000-0000-4000-8000-000000000002'

describe('canDeleteOwnPaymentRequest — which rows are offered Delete', () => {
  test('the owner, in each request-stage status (Archive is old rejected rows)', () => {
    for (const status of ['pending_approval', 'needs_clarification', 'rejected']) {
      assert.equal(canDeleteOwnPaymentRequest({ status, submitted_by: ME }, ME), true, status)
    }
  })
  test('never another person\'s request', () => {
    assert.equal(canDeleteOwnPaymentRequest({ status: 'pending_approval', submitted_by: OTHER }, ME), false)
  })
  test('never an approved or confirmed payment, or an unknown status', () => {
    for (const status of ['approved_unlinked', 'approved_linked', 'whatever', '']) {
      assert.equal(canDeleteOwnPaymentRequest({ status, submitted_by: ME }, ME), false, status)
    }
  })
  test('not before the signed-in user is known', () => {
    for (const u of ['', null, undefined]) {
      assert.equal(canDeleteOwnPaymentRequest({ status: 'rejected', submitted_by: ME }, u), false)
    }
  })
})

describe('describeOwnDeleteFailure', () => {
  test('each database refusal reads as a plain sentence', () => {
    assert.match(describeOwnDeleteFailure({ message: 'PAYMENT_APPROVED: an approved or confirmed payment cannot be deleted.' }), /approved/i)
    assert.match(describeOwnDeleteFailure({ message: 'PAYMENT_NOT_OWNER: only the person' }), /raised/i)
    assert.match(describeOwnDeleteFailure({ message: 'PAYMENT_NOT_FOUND: payment request not found.' }), /could not be found/i)
    assert.match(describeOwnDeleteFailure({ message: 'PAYMENT_REQUEST_DELETED: ...' }), /already been deleted/i)
  })
  test('anything else says nothing changed — never a raw database message', () => {
    const msg = describeOwnDeleteFailure({ message: 'duplicate key value violates unique constraint "x"' })
    assert.match(msg, /Nothing was changed/)
    assert.equal(/duplicate|constraint/.test(msg), false)
    assert.match(describeOwnDeleteFailure(null), /Nothing was changed/)
  })
})

describe('deleteOwnPaymentRequest', () => {
  const clientReturning = (result: { data?: unknown; error?: { message: string } | null }, seen: unknown[] = []) => ({
    rpc: async (name: string, args: unknown) => { seen.push([name, args]); return { data: result.data ?? null, error: result.error ?? null } },
  })

  test('calls the one RPC with only the payment id', async () => {
    const seen: unknown[] = []
    const r = await deleteOwnPaymentRequest(clientReturning({ data: { already_deleted: false } }, seen) as never, 'pay-1')
    assert.deepEqual(seen, [['delete_own_payment_request', { p_payment_id: 'pay-1' }]])
    assert.deepEqual(r, { outcome: 'success', alreadyDeleted: false })
  })
  test('a repeat that the database treats as a no-op is still a success', async () => {
    const r = await deleteOwnPaymentRequest(clientReturning({ data: { already_deleted: true } }) as never, 'pay-1')
    assert.deepEqual(r, { outcome: 'success', alreadyDeleted: true })
  })
  test('a refusal is a failure with a readable message', async () => {
    const r = await deleteOwnPaymentRequest(clientReturning({ error: { message: 'PAYMENT_APPROVED: x' } }) as never, 'pay-1')
    assert.equal(r.outcome, 'failure')
    assert.match((r as { message: string }).message, /approved/i)
  })
  test('a thrown network error is a failure, not an exception', async () => {
    const boom = { rpc: async () => { throw new Error('offline') } }
    const r = await deleteOwnPaymentRequest(boom as never, 'pay-1')
    assert.equal(r.outcome, 'failure')
  })
})

describe('the confirmation dialog', () => {
  const markup = renderToStaticMarkup(
    <DeleteOwnPaymentRequestModal
      payment={{ id: 'p1', human_payment_id: 'P-AA-0042', client_name: 'Sharma Furnishings', amount: 125000 }}
      formatAmount={n => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
      onDelete={async () => ({ outcome: 'success', alreadyDeleted: false })}
      onClose={() => {}}
      onDeleted={() => {}}
    />)

  test('title, message and both buttons are exactly as specified', () => {
    assert.equal(OWN_DELETE_TITLE, 'Delete payment request?')
    assert.equal(OWN_DELETE_MESSAGE, 'This request will be removed from the payment request list.')
    assert.equal(OWN_DELETE_CANCEL_LABEL, 'Cancel')
    assert.equal(OWN_DELETE_CONFIRM_LABEL, 'Delete request')
    for (const text of [OWN_DELETE_TITLE, OWN_DELETE_MESSAGE, OWN_DELETE_CANCEL_LABEL, OWN_DELETE_CONFIRM_LABEL]) {
      assert.ok(markup.includes(text), text)
    }
  })
  test('it shows the payment ID, the client and the requested amount', () => {
    assert.ok(markup.includes('P-AA-0042'))
    assert.ok(markup.includes('Sharma Furnishings'))
    assert.ok(markup.includes('₹1,25,000.00'))
  })
  test('it asks for no reason and no typed confirmation (that is the admin dialog)', () => {
    assert.equal(/<textarea|<input/.test(markup), false)
  })

  const SRC = read('src/components/finance/DeleteOwnPaymentRequestModal.tsx')
  test('a duplicate click is ignored by a ref, and a failure re-arms the button', () => {
    assert.ok(SRC.includes('if (inFlight.current) return'))
    assert.ok(/inFlight\.current = true[\s\S]*await onDelete[\s\S]*inFlight\.current = false/.test(SRC))
    assert.ok(SRC.includes('disabled={busy}'))
  })
  test('on failure the message is shown and the dialog stays; success alone calls onDeleted', () => {
    assert.ok(SRC.includes("if (result.outcome === 'success') {\n      onDeleted(payment.id)\n      return\n    }"))
    assert.ok(SRC.includes('setMessage(result.message)'))
  })
})

describe('the migration is the authority, not the button', () => {
  const SQL = read('supabase/migrations/20270226000000_payment_request_owner_soft_delete.sql')

  test('the RPC locks the row, then checks owner, status and approval history under the lock', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function public.delete_own_payment_request'))
    const lock = fn.indexOf('for update')
    assert.ok(lock > 0)
    for (const needle of ['submitted_by is distinct from v_actor', "status not in ('pending_approval', 'needs_clarification', 'rejected')",
                          'approved_at is not null', "l.payload ->> 'to_status' like 'approved%'"]) {
      assert.ok(fn.indexOf(needle) > lock, `${needle} must come after the lock`)
    }
  })
  test('deleted rows are hidden by a RESTRICTIVE select policy and frozen by a trigger', () => {
    assert.ok(/create policy finance_payment_requests_hide_deleted[\s\S]*as restrictive[\s\S]*for select[\s\S]*deleted_at is null/.test(SQL))
    assert.ok(SQL.includes('before update on public.finance_payment_requests'))
    assert.ok(SQL.includes("raise exception 'PAYMENT_REQUEST_DELETED"))
  })
  test('nothing but the RPC can set deleted_at, and a hard delete is not what it does', () => {
    assert.ok(SQL.includes("current_setting('boe.payment_request_soft_delete', true)"))
    const fn = SQL.slice(SQL.indexOf('create or replace function public.delete_own_payment_request'))
    assert.equal(/delete\s+from\s+public\.finance_payment/i.test(fn), false, 'it must never DELETE')
  })
  test('history is kept: allocations are reversed, intents cancelled, the trail gets an event', () => {
    assert.ok(SQL.includes("set status = 'reversed'"))
    assert.ok(SQL.includes("set status = 'cancelled'"))
    assert.ok(SQL.includes("'request_deleted'"))
  })
  test('only signed-in users may call it', () => {
    assert.ok(SQL.includes('revoke all on function public.delete_own_payment_request(uuid) from public, anon;'))
    assert.ok(SQL.includes('grant execute on function public.delete_own_payment_request(uuid) to authenticated;'))
  })
})
