// The Lead card's rules (20270811000000), without a screen: which one button a quotation offers on its lead, the follow-up it proposes,
// and the words it writes. Run: npm run test:file -- src/lib/quotations/leadLink.test.ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { QuotationEvent, QuotationStatus } from './api'
import { FOLLOW_UP_DAYS, followUpDefault, leadAction, logNote, lostNote } from './leadLink'

describe('which button a quotation offers on its lead', () => {
  test('Sent and Negotiating log it; Confirmed converts; Lost kills; a draft or archived quotation offers nothing', () => {
    const open = 'potential'
    const by = (['draft', 'sent', 'negotiating', 'confirmed', 'lost', 'archived'] as QuotationStatus[]).map(s => [s, leadAction(s, open)])
    assert.deepEqual(by, [['draft', null], ['sent', 'log'], ['negotiating', 'log'], ['confirmed', 'convert'], ['lost', 'dead'], ['archived', null]])
  })
  test('a lead that is already Converted or Dead is never offered another move, whatever the quotation says', () => {
    for (const stage of ['converted', 'dead']) for (const s of ['sent', 'negotiating', 'confirmed', 'lost'] as QuotationStatus[]) assert.equal(leadAction(s, stage), null, `${s} on ${stage}`)
  })
  test('every open stage, Follow up later included, can be logged on', () => {
    for (const stage of ['new', 'under_process', 'visit_meeting', 'potential', 'negotiation', 'follow_up_later']) assert.equal(leadAction('sent', stage), 'log', stage)
  })
})

describe('the follow-up the card proposes', () => {
  test(`${FOLLOW_UP_DAYS} days after today`, () => {
    assert.equal(followUpDefault('2026-11-21'), '2026-11-24') // Saturday to Tuesday
    assert.equal(followUpDefault('2026-11-23'), '2026-11-26')
  })
  test('a Sunday becomes the Monday after it (the lead board skips Sundays too)', () => {
    assert.equal(followUpDefault('2026-11-19'), '2026-11-23') // Thursday + 3 = Sunday 22
  })
  test('month and year ends carry over', () => {
    assert.equal(followUpDefault('2026-12-30'), '2027-01-02')
    assert.equal(followUpDefault('2026-11-29', 1), '2026-11-30')
  })
})

describe('what is written on the lead', () => {
  test('the quotation number comes first (that is how "logged" is recognised), then the version and the value in Indian digit grouping', () => {
    assert.equal(logNote('QT-NS-01001', 2, 450000), 'QT-NS-01001 v2 sent to the client, ₹4,50,000 before GST')
  })
  test('with no version yet there is no "v"; the value is rounded to whole rupees', () => {
    assert.equal(logNote('QT-NS-01001', null, 1234.6), 'QT-NS-01001 sent to the client, ₹1,235 before GST')
  })
})

describe('the lost note carried to the lead', () => {
  const ev = (to: string, note: unknown): QuotationEvent => ({ kind: 'status', detail: { from: 'sent', to, note }, at: '2026-11-19T10:00:00Z', actor_name: null })
  test('the newest status entry that went to lost (the list is newest first)', () => {
    assert.equal(lostNote([ev('negotiating', null), ev('lost', 'Chose another vendor'), ev('lost', 'older reason'), ev('sent', null)]), 'Chose another vendor')
  })
  test('empty when nothing was lost, or the note is not text', () => {
    assert.equal(lostNote([ev('sent', 'x'), { kind: 'saved', detail: {}, at: '', actor_name: null }]), '')
    assert.equal(lostNote([ev('lost', null)]), '')
    assert.equal(lostNote([]), '')
  })
})
