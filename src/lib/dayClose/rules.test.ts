// Day Close rules (owner, 2026-11-12): pure, so every rule is pinned exactly.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOSE_OPENS_MINUTES, PLAN_DUE_MINUTES, clock, countItems, dayPrompt, effectiveStatus, hasPendingWork,
  isLockedLeaveType, isOwnPhotoPath, isSunday, isTaskDueForPlan, isTaskOverdue, judgeDay, pendingWorkWords,
  planDueMinutes, validateItemClose, validateNewItem, type PlanItem,
} from './rules'

const ME = '00000000-0000-0000-0000-0000000000b2'
const PHOTO = `${ME}/11111111-2222-4333-8444-555555555555.jpg`
// 13 Nov 2026 is a Friday; 15 Nov a Sunday; 14 Nov a Saturday (a working day).
const FRI = '2026-11-13'
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString()

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: 'i1', source: 'own', task_id: null, title: 'Post 1 reel', expected_output: null, status: 'open',
  proof_url: null, proof_photo_path: null, proof_note: null, reason: null, next_date: null, closed_at: null,
  created_at: ist(FRI, '10:05'), ...over,
})

describe('times', () => {
  test('office times: plan by 10:30, closing opens 18:00', () => {
    assert.equal(clock(PLAN_DUE_MINUTES), '10:30 am')
    assert.equal(clock(CLOSE_OPENS_MINUTES), '6:00 pm')
  })

  test('Sunday is off, Saturday is a working day', () => {
    assert.equal(isSunday('2026-11-15'), true)
    assert.equal(isSunday('2026-11-14'), false)
  })

  test('a late arrival gets 30 minutes after punching in', () => {
    assert.equal(planDueMinutes(null, FRI), 630)
    assert.equal(planDueMinutes(ist(FRI, '09:58'), FRI), 630)
    assert.equal(planDueMinutes(ist(FRI, '10:20'), FRI), 650)
    assert.equal(planDueMinutes(ist(FRI, '12:00'), FRI), 750)
  })
})

describe('the night’s judgement', () => {
  const base = {
    date: FRI, holiday: false, fullDayLeave: false,
    checkInAt: ist(FRI, '10:02'), checkOutAt: ist(FRI, '18:40'), openItems: 0,
  }
  const kinds = (input: Parameters<typeof judgeDay>[0]) => judgeDay(input).map(s => s.kind)

  test('a good day: filed on time, closed before the punch-out', () => {
    assert.deepEqual(kinds({ ...base, plan: { submitted_at: ist(FRI, '10:20'), closed_at: ist(FRI, '18:35') } }), [])
  })

  test('came in, never filed, never closed: two strikes', () => {
    assert.deepEqual(kinds({ ...base, plan: null }), ['no_plan', 'day_not_closed'])
  })

  test('filed after the due time', () => {
    assert.deepEqual(kinds({ ...base, plan: { submitted_at: ist(FRI, '11:15'), closed_at: ist(FRI, '18:30') } }), ['plan_late'])
  })

  test('a late arrival who files within 30 minutes is not late', () => {
    assert.deepEqual(kinds({ ...base, checkInAt: ist(FRI, '11:00'), plan: { submitted_at: ist(FRI, '11:25'), closed_at: ist(FRI, '18:30') } }), [])
  })

  test('closed from home after the last punch', () => {
    assert.deepEqual(kinds({ ...base, plan: { submitted_at: ist(FRI, '10:10'), closed_at: ist(FRI, '20:15') } }), ['closed_after_leaving'])
  })

  test('closing a few minutes after the tap still counts (clock drift)', () => {
    assert.deepEqual(kinds({ ...base, plan: { submitted_at: ist(FRI, '10:10'), closed_at: ist(FRI, '18:44') } }), [])
  })

  test('never a strike on a Sunday, a holiday, approved leave, or a day with no punch', () => {
    const plan = null
    assert.deepEqual(kinds({ ...base, date: '2026-11-15', checkInAt: ist('2026-11-15', '10:00'), checkOutAt: null, plan }), [])
    assert.deepEqual(kinds({ ...base, holiday: true, plan }), [])
    assert.deepEqual(kinds({ ...base, fullDayLeave: true, plan }), [])
    assert.deepEqual(kinds({ ...base, checkInAt: null, checkOutAt: null, plan }), [])
  })

  test('the detail tells the reviewer the times', () => {
    const [s] = judgeDay({ ...base, checkInAt: ist(FRI, '09:55'), plan: { submitted_at: ist(FRI, '11:15'), closed_at: ist(FRI, '18:30') } })
    assert.equal(s.detail.due, '10:30 am')
    assert.equal(s.detail.filed_at, ist(FRI, '11:15'))
  })
})

describe('what to do now', () => {
  const p = (hhmm: string, plan: { submitted_at: string | null; closed_at: string | null } | null, open = 0) =>
    dayPrompt({ now: new Date(ist(FRI, hhmm)), date: FRI, workingDay: true, plan, openItems: open, checkInAt: ist(FRI, '10:00') })

  test('file the plan, then late', () => {
    assert.deepEqual(p('10:10', null), { kind: 'file_plan', late: false, due: '10:30 am' })
    assert.deepEqual(p('10:31', null), { kind: 'file_plan', late: true, due: '10:30 am' })
  })

  test('quiet through the day, then close from 18:00, then closed', () => {
    const filed = { submitted_at: ist(FRI, '10:15'), closed_at: null }
    assert.deepEqual(p('15:00', filed), { kind: 'none' })
    assert.deepEqual(p('18:00', filed, 2), { kind: 'close_day', open: 2 })
    assert.deepEqual(p('18:20', { ...filed, closed_at: ist(FRI, '18:10') }), { kind: 'closed' })
  })

  test('nothing on a day off', () => {
    assert.deepEqual(dayPrompt({ now: new Date(ist(FRI, '11:00')), date: FRI, workingDay: false, plan: null, openItems: 0, checkInAt: null }), { kind: 'none' })
  })
})

describe('items', () => {
  test('a new item needs words', () => {
    assert.equal(validateNewItem({ title: ' ' }).ok, false)
    assert.deepEqual(validateNewItem({ title: ' Post 1 reel ', expected_output: '' }), { ok: true, value: { title: 'Post 1 reel', expected_output: null } })
  })

  test('an own item is Done only with proof', () => {
    assert.equal(validateItemClose({ status: 'done' }, item(), ME, FRI).ok, false)
    assert.equal(validateItemClose({ status: 'done', proof_url: 'javascript:alert(1)' }, item(), ME, FRI).ok, false)
    assert.equal(validateItemClose({ status: 'done', proof_url: 'https://www.instagram.com/p/abc' }, item(), ME, FRI).ok, true)
    assert.equal(validateItemClose({ status: 'done', proof_photo_path: PHOTO }, item(), ME, FRI).ok, true)
  })

  test('a photo must be the caller’s own', () => {
    const other = '00000000-0000-0000-0000-0000000000c3'
    assert.equal(isOwnPhotoPath(PHOTO, ME), true)
    assert.equal(isOwnPhotoPath(PHOTO, other), false)
    assert.equal(validateItemClose({ status: 'done', proof_photo_path: PHOTO }, item(), other, FRI).ok, false)
  })

  test('an assigned task is Done only once it is submitted in Task Management', () => {
    const assigned = item({ source: 'assigned', task_id: 't1', task_status: 'working' })
    assert.equal(validateItemClose({ status: 'done' }, assigned, ME, FRI).ok, false)
    assert.equal(validateItemClose({ status: 'done' }, { ...assigned, task_status: 'pending_approval' }, ME, FRI).ok, true)
    assert.equal(effectiveStatus({ ...assigned, task_status: 'completed' }), 'done')
    assert.equal(effectiveStatus(assigned), 'open')
  })

  test('Not done needs a reason and a later date', () => {
    assert.equal(validateItemClose({ status: 'not_done', reason: 'x', next_date: '2026-11-14' }, item(), ME, FRI).ok, false)
    assert.equal(validateItemClose({ status: 'not_done', reason: 'Waiting for photos', next_date: FRI }, item(), ME, FRI).ok, false)
    assert.equal(validateItemClose({ status: 'not_done', reason: 'Waiting for photos', next_date: '2026-11-14' }, item(), ME, FRI).ok, true)
  })

  test('counts use the effective status', () => {
    const c = countItems([
      item({ status: 'done' }),
      item({ status: 'not_done' }),
      item(),
      item({ source: 'assigned', task_id: 't', task_status: 'pending_approval' }),
    ])
    assert.deepEqual(c, { total: 4, done: 2, notDone: 1, open: 1 })
  })
})

describe('leave while work is pending', () => {
  test('only full-day and half-day leave are locked', () => {
    assert.equal(isLockedLeaveType('full_day_leave'), true)
    assert.equal(isLockedLeaveType('half_day'), true)
    assert.equal(isLockedLeaveType('late_arrival'), false)
  })

  test('overdue: due before today, not handed in or closed', () => {
    assert.equal(isTaskOverdue({ status: 'working', due_date: '2026-11-12' }, FRI), true)
    assert.equal(isTaskOverdue({ status: 'pending_approval', due_date: '2026-11-12' }, FRI), false)
    assert.equal(isTaskOverdue({ status: 'completed', due_date: '2026-11-12' }, FRI), false)
    assert.equal(isTaskOverdue({ status: 'working', due_date: FRI }, FRI), false)
    assert.equal(isTaskOverdue({ status: 'working', due_date: null }, FRI), false)
  })

  test('a task is in today’s plan when due today or before and still open', () => {
    assert.equal(isTaskDueForPlan({ status: 'pending', due_date: FRI }, FRI), true)
    assert.equal(isTaskDueForPlan({ status: 'pending', due_date: '2026-11-20' }, FRI), false)
    assert.equal(isTaskDueForPlan({ status: 'cancelled', due_date: FRI }, FRI), false)
  })

  test('words', () => {
    assert.equal(hasPendingWork({ overdueTasks: 0, unclosedDays: 0 }), false)
    assert.equal(pendingWorkWords({ overdueTasks: 2, unclosedDays: 1 }), '2 overdue tasks, 1 day not closed')
  })
})
