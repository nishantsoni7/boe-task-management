import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PENDENCY_MAX_LENGTH,
  PENDENCY_MAX_PER_CALL,
  addPendencyDraft,
  cleanPendencyLabel,
  describePendencyError,
  saveNewOrderPendencies,
  splitPendencies,
} from './orderPendencies'
import { PiApproveOrderModal } from '@/components/orders/piReviewModals'
import { buildApprovalSummary } from '@/app/orders/drafts/[submissionId]/piDetailView'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const sql = read('supabase/migrations/20270325000000_order_pendencies.sql')

describe('addPendencyDraft', () => {
  test('trims, collapses spaces and appends', () => {
    assert.deepEqual(addPendencyDraft([], '  Fabric   swatch  ').list, ['Fabric swatch'])
  })
  test('blank text adds nothing and says nothing', () => {
    assert.deepEqual(addPendencyDraft(['a'], '   '), { list: ['a'], problem: null })
  })
  test('a duplicate (any case) is refused with a sentence', () => {
    const r = addPendencyDraft(['Fabric'], 'fabric')
    assert.deepEqual(r.list, ['Fabric'])
    assert.ok(r.problem)
  })
  test('over-long and over-count are refused', () => {
    assert.ok(addPendencyDraft([], 'x'.repeat(PENDENCY_MAX_LENGTH + 1)).problem)
    const full = Array.from({ length: PENDENCY_MAX_PER_CALL }, (_, i) => `p${i}`)
    assert.ok(addPendencyDraft(full, 'one more').problem)
  })
  test('cleanPendencyLabel matches the SQL clean-up', () => {
    assert.equal(cleanPendencyLabel('\n a \t b '), 'a b')
  })
})

describe('splitPendencies / describePendencyError', () => {
  test('splits open from cleared', () => {
    const rows = [
      { id: '1', label: 'a', created_at: 't', cleared_at: null, evidence_path: null },
      { id: '2', label: 'b', created_at: 't', cleared_at: 'x', evidence_path: null },
    ]
    assert.equal(splitPendencies(rows).open.length, 1)
    assert.equal(splitPendencies(rows).cleared.length, 1)
  })
  test('names the refusals it knows, generic otherwise', () => {
    assert.match(describePendencyError('ORDER_PENDENCY_FORBIDDEN: x'), /permission/)
    assert.match(describePendencyError('boom'), /could not be saved/)
  })
})

describe('saveNewOrderPendencies', () => {
  test('nothing to save makes no call', async () => {
    let calls = 0
    const ok = await saveNewOrderPendencies({ rpc: () => { calls++; return Promise.resolve({ error: null }) } }, 'o', [])
    assert.equal(ok, true); assert.equal(calls, 0)
  })
  test('calls add_order_pendencies with the order id and labels; reports failure', async () => {
    let seen: unknown
    const client = (error: unknown) => ({ rpc: (fn: string, args: Record<string, unknown>) => { seen = { fn, args }; return Promise.resolve({ error }) } })
    assert.equal(await saveNewOrderPendencies(client(null), 'o1', ['a', 'b']), true)
    assert.deepEqual(seen, { fn: 'add_order_pendencies', args: { p_order_id: 'o1', p_labels: ['a', 'b'] } })
    assert.equal(await saveNewOrderPendencies(client({ message: 'x' }), 'o1', ['a']), false)
  })
})

describe('the convert dialog', () => {
  const render = (onPendenciesChange?: (n: string[]) => void, mode: 'approve_and_create' | 'approve_pi' = 'approve_and_create') =>
    renderToStaticMarkup(
      <PiApproveOrderModal client="Rivoli" mode={mode}
        rows={buildApprovalSummary({ client: 'Rivoli', productValue: '₹1', advanceConfirmed: '₹1' })}
        saving={false} failure={null} onCancel={() => {}} onConfirm={() => {}}
        salespeople={[]} confirmation={{ salesperson: null, confirmDate: null, dueDate: null, leadSource: null }}
        onConfirmationChange={() => {}} confirmationField={null}
        pendencies={['Fabric swatch']} onPendenciesChange={onPendenciesChange} />)
  test('lists the pendencies where an Order is created', () => {
    const html = render(() => {})
    assert.match(html, /data-testid="pi-approve-pendencies"/)
    assert.ok(html.includes('Fabric swatch') && html.includes('Pending from client'))
  })
  test('is not drawn without a handler, nor where no Order is created', () => {
    assert.doesNotMatch(render(undefined), /pi-approve-pendencies/)
    assert.doesNotMatch(render(() => {}, 'approve_pi'), /pi-approve-pendencies/)
  })
})

describe('migration 20270325000000', () => {
  test('clients can only SELECT; every write is an RPC with a pinned search path', () => {
    assert.match(sql, /grant select on table public\.order_pendencies to authenticated/)
    assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*order_pendencies/i)
    for (const fn of ['add_order_pendencies', 'clear_order_pendency', 'reopen_order_pendency', 'remove_order_pendency']) {
      const start = sql.indexOf(`create or replace function public.${fn}(`)
      assert.notEqual(start, -1, fn)
      const head = sql.slice(start, sql.indexOf('$$;', start))
      assert.match(head, /security definer/)
      assert.match(head, /set search_path = public, pg_temp/)
      assert.match(head, /can_manage_order_pendencies/)
      assert.match(head, /for update/, 'locks the Order')
    }
  })
  test('does not restate approve_order_submission', () => {
    assert.doesNotMatch(sql, /function public\.approve_order_submission/)
  })
  test('the authority is the approval recorders plus the approver permission', () => {
    assert.match(sql, /can_record_order_approval\(p_order_id\)/)
    assert.match(sql, /actor_can_approve_order\(\)/)
  })
})
