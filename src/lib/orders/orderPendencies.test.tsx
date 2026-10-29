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
  splitPendencies,
} from './orderPendencies'
import { PiApproveOrderModal } from '@/components/orders/piReviewModals'

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

describe('the convert dialog (owner, 2026-10-30)', () => {
  test('no longer collects pendencies: they are added on the Order page', () => {
    const html = renderToStaticMarkup(
      <PiApproveOrderModal client="Rivoli" mode="approve_and_create"
        saving={false} failure={null} onCancel={() => {}} onConfirm={() => {}}
        salespeople={[]} confirmation={{ salesperson: null, confirmDate: null, dueDate: null, leadSource: null }}
        onConfirmationChange={() => {}} confirmationField={null} />)
    assert.doesNotMatch(html, /pi-approve-pendencies/)
    assert.ok(!html.includes('Pending from client'))
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(!page.includes('add_order_pendencies') && !page.includes('pendencyDrafts'),
      'and the PI page writes none after approval')
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
