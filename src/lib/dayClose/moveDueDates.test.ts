// "Moved to a new date" really moves the task (owner, 2026-11-18): Close my day's carry-overs change the task's
// due date and write the change into the task's history, for the person's own tasks only.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { moveDueDates } from './server'
import type { DayTask } from './rules'

const DHRUV = 'eeeeeeee-0000-0000-0000-00000000000e'
const OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a'
const task = (id: string, over: Partial<DayTask> = {}): DayTask => ({
  id, title: id, status: 'working', priority: 'medium', due_date: '2026-11-13', assigned_to: DHRUV, created_by: OWNER, ...over,
})

describe('moving to a new date', () => {
  test('the due date moves and the history says why; a task already on that date is left alone', async () => {
    const all = [task('t1'), task('t2', { due_date: '2026-11-16' })]
    const db = new MemorySupabase({ tasks: all.map(t => ({ ...t })), task_activity_log: [], notifications: [], users: [{ id: DHRUV, full_name: 'Dhruv' }] })
    const caller = { svc: db as unknown as Caller['svc'], id: DHRUV, role: 'member', team: null, isAdmin: false } as Caller
    await moveDueDates(caller, all, [
      { plan_id: 'p', task_id: 't1', reason: 'Vendor sends the swatch on Monday', next_date: '2026-11-16' },
      { plan_id: 'p', task_id: 't2', reason: 'Same day', next_date: '2026-11-16' },
    ])
    assert.equal(db.rows('tasks').find(t => t.id === 't1')!.due_date, '2026-11-16')
    const log = db.rows('task_activity_log')
    assert.equal(log.length, 1)
    assert.equal(log[0].action, 'due_date_changed')
    assert.equal(log[0].old_val, '2026-11-13')
    assert.equal(log[0].new_val, '2026-11-16')
    assert.match(String(log[0].note), /Vendor sends the swatch on Monday/)
    // The person who gave the task is told the new date and why, once (t2 did not move).
    const told = db.rows('notifications')
    assert.equal(told.length, 1)
    assert.equal(told[0].user_id, OWNER)
    assert.equal(told[0].task_id, 't1')
    assert.match(String(told[0].title), /^Dhruv moved the due date to Mon, 16 Nov: Vendor sends the swatch on Monday$/)
  })

  test('a Self Task moves without telling anybody', async () => {
    const own = task('t5', { created_by: DHRUV })
    const db = new MemorySupabase({ tasks: [{ ...own }], task_activity_log: [], notifications: [], users: [{ id: DHRUV, full_name: 'Dhruv' }] })
    const caller = { svc: db as unknown as Caller['svc'], id: DHRUV, role: 'member', team: null, isAdmin: false } as Caller
    await moveDueDates(caller, [own], [{ plan_id: 'p', task_id: 't5', reason: 'Later', next_date: '2026-11-17' }])
    assert.equal(db.rows('tasks')[0].due_date, '2026-11-17')
    assert.equal(db.rows('notifications').length, 0)
  })

  test('never another person\'s task', async () => {
    const theirs = task('t9', { assigned_to: OWNER })
    const db = new MemorySupabase({ tasks: [{ ...theirs }], task_activity_log: [] })
    const caller = { svc: db as unknown as Caller['svc'], id: DHRUV, role: 'member', team: null, isAdmin: false } as Caller
    await moveDueDates(caller, [theirs], [{ plan_id: 'p', task_id: 't9', reason: 'x', next_date: '2026-11-20' }])
    assert.equal(db.rows('tasks')[0].due_date, '2026-11-13')
    assert.equal(db.rows('task_activity_log').length, 0)
  })
})
