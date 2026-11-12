// Day Close rules (owner, 2026-11-12): pure, so every rule is pinned exactly.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOSE_OPENS_MINUTES, PLAN_DUE_MINUTES, clock, countDay, dayPrompt, dayTaskList, dayTaskState, hasPendingWork,
  isHandedIn, isLockedLeaveType, isSunday, isTaskDueForPlan, isTaskOverdue, judgeDay, pendingWorkWords,
  planDueMinutes, validateCarryover, validateSummary, type DayTask,
} from './rules'

const ME = '00000000-0000-0000-0000-0000000000b2'
// 13 Nov 2026 is a Friday; 15 Nov a Sunday; 14 Nov a Saturday (a working day).
const FRI = '2026-11-13'
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString()

const task = (over: Partial<DayTask> = {}): DayTask => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Post 1 reel', status: 'working', priority: 'medium',
  due_date: FRI, assigned_to: ME, created_by: ME, ...over,
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

describe('the day is the person’s own tasks', () => {
  const T = (n: number, over: Partial<DayTask> = {}) => task({ id: `aaaaaaaa-0000-0000-0000-00000000000${n}`, title: `T${n}`, ...over })

  test('before filing: open tasks due today or before, not later ones, not closed ones', () => {
    const list = dayTaskList([
      T(1), T(2, { due_date: '2026-11-10' }), T(3, { due_date: '2026-11-20' }),
      T(4, { status: 'completed' }), T(5, { status: 'cancelled' }), T(6, { due_date: null }),
    ], FRI, null)
    assert.deepEqual(list.map(t => t.title), ['T2', 'T1'])
  })

  test('after filing: the planned tasks stay, even once completed or moved; a cancelled one leaves', () => {
    const planned = [T(1).id, T(2).id, T(3).id]
    const list = dayTaskList([
      T(1, { status: 'completed' }), T(2, { due_date: '2026-11-20' }), T(3, { status: 'cancelled' }), T(4),
    ], FRI, planned)
    assert.deepEqual(list.map(t => t.title).sort(), ['T1', 'T2', 'T4'])
  })

  test('done = submitted or completed; carried = a reason was given; otherwise open', () => {
    const carried = new Set([T(2).id])
    assert.equal(isHandedIn('pending_approval'), true)
    assert.equal(isHandedIn('working'), false)
    assert.equal(dayTaskState(T(1, { status: 'pending_approval' }), carried), 'done')
    assert.equal(dayTaskState(T(2), carried), 'carried')
    assert.equal(dayTaskState(T(3), carried), 'open')
    assert.deepEqual(countDay([T(1, { status: 'completed' }), T(2), T(3)], carried), { total: 3, done: 1, carried: 1, open: 1 })
  })

  test('carrying a task over needs a reason and a later date', () => {
    const id = T(1).id
    assert.equal(validateCarryover({ task_id: id, reason: 'x', next_date: '2026-11-14' }, FRI).ok, false)
    assert.equal(validateCarryover({ task_id: id, reason: 'Waiting for photos', next_date: FRI }, FRI).ok, false)
    assert.equal(validateCarryover({ task_id: 'nope', reason: 'Waiting for photos', next_date: '2026-11-14' }, FRI).ok, false)
    assert.deepEqual(validateCarryover({ task_id: id, reason: ' Waiting for photos ', next_date: '2026-11-14' }, FRI),
      { ok: true, value: { task_id: id, reason: 'Waiting for photos', next_date: '2026-11-14' } })
  })

  test('the end-of-day summary is required (it is the EOD log)', () => {
    assert.equal(validateSummary('').ok, false)
    assert.deepEqual(validateSummary(' 3 reels posted, 1 waiting '), { ok: true, value: '3 reels posted, 1 waiting' })
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
