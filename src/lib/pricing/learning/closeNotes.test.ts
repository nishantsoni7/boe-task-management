// After a price is taught from a quotation line, the notes sent from that product about its price are answered with the case (28 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeNotesFor, type FeedbackRow } from './api'

const row = (over: Partial<FeedbackRow>): FeedbackRow => ({
  id: 'f1', created_at: '2026-11-28T10:39:00Z', source: 'quotation', kind: 'correction', comment: null, expected_price: null, line_name: 'Chair', line_size: null, line_material: null,
  line_finish: null, line_qty: null, client_type: null, suggestion: null, quotation_id: 'q-1', quote_no: 'QT-P-01024', status: 'new', handled_at: null, handled_note: null, from_name: null, ...over,
})
function client(rows: FeedbackRow[] | Error) {
  const calls: [string, Record<string, unknown>][] = []
  const c = { rpc: async (fn: string, args: Record<string, unknown>) => {
    calls.push([fn, args])
    if (fn === 'pricing_feedback_list') return rows instanceof Error ? { data: null, error: { message: 'PRICING_LEARNING_FORBIDDEN: no' } } : { data: rows, error: null }
    return { data: null, error: null }
  } }
  return { calls, c: c as never }
}

describe('closing the notes a taught price answers', () => {
  test('only the open notes from this product on this quotation about its price are marked done, with the case number', async () => {
    const { calls, c } = client([
      row({ id: 'a' }), row({ id: 'b', kind: 'too_low' }), row({ id: 'c', line_name: ' chair ' }),
      row({ id: 'other-quote', quotation_id: 'q-2' }), row({ id: 'other-line', line_name: 'Sofa' }), row({ id: 'done', status: 'done' }), row({ id: 'seen', status: 'seen' }),
      row({ id: 'quoted-differently', kind: 'differs_taught' }),
    ])
    assert.equal(await closeNotesFor(c, 'q-1', 'Chair', 3), 3)
    assert.deepEqual(calls.filter(([fn]) => fn === 'pricing_feedback_set').map(([, a]) => a), [
      { p_id: 'a', p_status: 'done', p_note: 'Taught in Training as case #3' }, { p_id: 'b', p_status: 'done', p_note: 'Taught in Training as case #3' }, { p_id: 'c', p_status: 'done', p_note: 'Taught in Training as case #3' },
    ])
  })
  test('for anyone but the pricing desk the list is refused and nothing is closed, without an error', async () => {
    const { calls, c } = client(new Error('refused'))
    assert.equal(await closeNotesFor(c, 'q-1', 'Chair', 3), 0)
    assert.equal(calls.filter(([fn]) => fn === 'pricing_feedback_set').length, 0)
  })
})
