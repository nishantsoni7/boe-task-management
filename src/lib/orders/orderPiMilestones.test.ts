import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { firstPiMilestones, type PiMilestoneVersion } from './orderPiMilestones'
import { orderDatesTimeline } from './orderDatesTimeline'

const v = (over: Partial<PiMilestoneVersion>): PiMilestoneVersion => ({
  version_number: 1, status: 'superseded', uploaded_at: '2026-10-19T08:00:00Z', decided_at: '2026-10-20T09:21:00Z', ...over,
})
const V1 = v({})
const V2 = v({ version_number: 2, status: 'approved', uploaded_at: '2026-10-25T08:48:00Z', decided_at: '2026-10-25T08:48:00Z' })

describe('the first PI milestones', () => {
  test('an Order revised after approval takes BOTH dates from V1, so approval never precedes upload', () => {
    const m = firstPiMilestones([V2, V1], '2026-10-20T09:21:00Z')
    assert.equal(m.uploadedAt, '2026-10-19T08:00:00Z')
    assert.equal(m.approvedAt, '2026-10-20T09:21:00Z')
    assert.ok(Date.parse(m.approvedAt!) >= Date.parse(m.uploadedAt!))
  })

  test('the upload gap and the days since upload follow V1 too', () => {
    const m = firstPiMilestones([V1, V2])
    const t = orderDatesTimeline({ confirmDate: '2026-10-18', uploadedAt: m.uploadedAt, dueDate: '2026-12-04', now: new Date('2026-10-26T12:00:00Z') })
    assert.equal(t.uploadGapDays, 1)
    assert.equal(t.gapFlagged, false)
    assert.equal(t.daysSinceUpload, 7)
  })

  test('a single approved version gives its own two dates', () => {
    const m = firstPiMilestones([v({ status: 'approved' })])
    assert.deepEqual(m, { uploadedAt: '2026-10-19T08:00:00Z', approvedAt: '2026-10-20T09:21:00Z' })
  })

  test('a first version with no decision falls back to the first approval event; no versions, to the event alone', () => {
    assert.equal(firstPiMilestones([v({ status: 'pending', decided_at: null })], '2026-10-21T00:00:00Z').approvedAt, '2026-10-21T00:00:00Z')
    assert.deepEqual(firstPiMilestones([], '2026-10-21T00:00:00Z'), { uploadedAt: null, approvedAt: '2026-10-21T00:00:00Z' })
    assert.deepEqual(firstPiMilestones([]), { uploadedAt: null, approvedAt: null })
  })

  test('a rejected first version is not an approval', () => {
    assert.equal(firstPiMilestones([v({ status: 'rejected' })]).approvedAt, null)
  })
})
