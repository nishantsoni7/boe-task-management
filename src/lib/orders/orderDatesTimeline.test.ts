import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { orderDatesTimeline, uploadGapLabel, dueCountdownLabel } from './orderDatesTimeline'
import { displayOrderNumber } from '../orderNumbering'

const NOW = new Date('2026-10-26T12:00:00Z')

describe('orderDatesTimeline', () => {
  test('flags a confirm-to-upload gap over a week and counts down to the due date', () => {
    const t = orderDatesTimeline({ confirmDate: '2026-09-26', uploadedAt: '2026-10-26T12:24:00Z', dueDate: '2026-11-12', now: NOW })
    assert.equal(t.uploadGapDays, 30)
    assert.equal(t.gapFlagged, true)
    assert.equal(t.daysSinceUpload, 0)
    assert.equal(t.daysToDue, 17)
    assert.equal(t.progressPercent, 0)
  })
  test('a short gap is not flagged; a missing date gives nulls, never a guess', () => {
    assert.equal(orderDatesTimeline({ confirmDate: '2026-10-24', uploadedAt: '2026-10-26T05:00:00Z', dueDate: null, now: NOW }).gapFlagged, false)
    const none = orderDatesTimeline({ confirmDate: null, uploadedAt: null, dueDate: null, now: NOW })
    assert.deepEqual(none, { uploadGapDays: null, gapFlagged: false, daysSinceUpload: null, daysToDue: null, progressPercent: null })
  })
  test('late-evening UTC uploads count as the next IST day', () => {
    assert.equal(orderDatesTimeline({ confirmDate: '2026-10-26', uploadedAt: '2026-10-25T20:00:00Z', dueDate: null, now: NOW }).uploadGapDays, 0)
  })
  test('overdue and progress are bounded', () => {
    const t = orderDatesTimeline({ confirmDate: null, uploadedAt: '2026-10-01T00:00:00Z', dueDate: '2026-10-20', now: NOW })
    assert.equal(t.daysToDue, -6)
    assert.equal(t.progressPercent, 100)
  })
  test('labels', () => {
    assert.equal(uploadGapLabel(1), '1 day after the confirm date')
    assert.equal(dueCountdownLabel(17), '17 days left')
    assert.equal(dueCountdownLabel(0), 'Due today')
    assert.equal(dueCountdownLabel(-3), '3 days overdue')
  })
})

describe('displayOrderNumber', () => {
  test('strips leading zeros for display only', () => {
    assert.equal(displayOrderNumber('0539'), '539')
    assert.equal(displayOrderNumber('0001'), '1')
    assert.equal(displayOrderNumber('1021'), '1021')
  })
  test('leaves anything that is not a padded number alone', () => {
    assert.equal(displayOrderNumber('BOE-147'), 'BOE-147')
    assert.equal(displayOrderNumber('0'), '0')
    assert.equal(displayOrderNumber(null), '')
    assert.equal(displayOrderNumber(undefined), '')
  })
})
