import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { PersistedActivity } from '@/lib/orders/submissionActivity'
import { changesSinceReturn, resubmissionEditLine, RESUBMISSION_NO_CHANGES } from './resubmissionChanges'

let n = 0
const row = (action: string, at: string, metadata: Record<string, unknown> | null = null): PersistedActivity =>
  ({ id: `a${n++}`, action, actor_id: 'x', note: null, created_at: `2026-09-27T${at}:00Z`, metadata }) as PersistedActivity
const figs = (grand: number, due = '2026-11-20') => ({ grand_total: grand, total_before_gst: grand - 1000, gst_amount: 1000, discount_amount: null, discount_label: null, order_confirmation_date: '2026-09-25', due_date: due })

describe('changesSinceReturn', () => {
  test('a first submission has nothing to compare against', () => {
    assert.equal(changesSinceReturn([row('submission_created', '06:00'), row('submitted', '06:05')]), null)
  })

  test('the first "before" after the return against the last "after" before the resubmission', () => {
    const c = changesSinceReturn([
      row('submission_created', '06:00'),
      row('parse_replaced', '06:02', { before: figs(1000000), after: figs(1678550) }), // before the first submission: ignored
      row('submitted', '06:05'),
      row('changes_requested', '06:09'),
      row('parse_replaced', '06:10', { before: figs(1678550), after: figs(1600000) }),
      row('internal_details_updated', '06:11'),
      row('parse_replaced', '06:12', { before: figs(1600000), after: figs(1591230, '2026-11-30') }),
      row('submitted', '06:14'),
    ])
    assert.ok(c)
    assert.equal(c.editCount, 2)
    assert.equal(resubmissionEditLine(c), 'The PI was edited 2 times before it was resubmitted.')
    assert.deepEqual(c.figures.map(f => f.key), ['grand_total', 'total_before_gst', 'due_date'])
    const grand = c.figures.find(f => f.key === 'grand_total')!
    assert.match(grand.before, /16,78,550/)
    assert.match(grand.after, /15,91,230/)
    assert.deepEqual(c.otherChanges, ['Internal details updated'])
    assert.equal(c.lineDetailRecorded, false, 'never claims the product lines were compared')
  })

  test('resubmitted without an edit says so', () => {
    const c = changesSinceReturn([row('submitted', '06:05'), row('changes_requested', '06:09'), row('submitted', '06:14')])
    assert.ok(c)
    assert.equal(c.editCount, 0)
    assert.equal(resubmissionEditLine(c), RESUBMISSION_NO_CHANGES)
    assert.deepEqual(c.figures, [])
  })

  test('only the latest return counts; order of the rows does not matter', () => {
    const rows = [
      row('submitted', '06:01'), row('changes_requested', '06:02'),
      row('parse_replaced', '06:03', { before: figs(1), after: figs(2) }), row('submitted', '06:04'),
      row('changes_requested', '06:05'), row('submitted', '06:06'),
    ].reverse()
    const c = changesSinceReturn(rows)
    assert.ok(c)
    assert.equal(c.editCount, 0)
    assert.equal(c.returnedAt, '2026-09-27T06:05:00Z')
  })

  test('malformed metadata is survivable', () => {
    const c = changesSinceReturn([row('submitted', '06:01'), row('changes_requested', '06:02'), row('parse_replaced', '06:03', { before: 'x' }), row('submitted', '06:04')])
    assert.ok(c)
    assert.equal(c.editCount, 1)
    assert.deepEqual(c.figures, [])
  })
})
