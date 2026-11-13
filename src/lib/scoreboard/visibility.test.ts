// Who sees the Scoreboard's Top 5 (owner, 2026-11-13): hidden from staff by default, the owner's switch,
// administrators only, and "hidden" whenever the switch cannot be read.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { loadVisibility, saveVisibility, top5IsPublic } from './server'

const OWNER = '00000000-0000-0000-0000-0000000000a1'
const STAFF = '00000000-0000-0000-0000-0000000000b2'
const caller = (db: MemorySupabase, id: string, isAdmin: boolean): Caller =>
  ({ svc: db as unknown as Caller['svc'], id, role: isAdmin ? 'admin' : 'member', team: null, isAdmin } as Caller)
const settings = (over: Record<string, unknown> = {}) => new MemorySupabase({
  day_close_settings: [{ singleton: true, reviewer_id: OWNER, plan_due_minutes: 630, close_opens_minutes: 1080, scoreboard_top5_public: false, ...over }],
})

describe('the Top 5 switch', () => {
  test('hidden by default; hidden when the column or row is missing', async () => {
    assert.equal(await top5IsPublic(settings() as unknown as Caller['svc']), false)
    const noColumn = new MemorySupabase({ day_close_settings: [{ singleton: true }] })
    assert.equal(await top5IsPublic(noColumn as unknown as Caller['svc']), false)
    assert.equal(await top5IsPublic(new MemorySupabase({ day_close_settings: [] }) as unknown as Caller['svc']), false)
  })

  test('the owner switches it on and off; it reads back', async () => {
    const db = settings()
    assert.equal((await saveVisibility(caller(db, OWNER, true), { top5Public: true })).status, 200)
    assert.equal(await top5IsPublic(db as unknown as Caller['svc']), true)
    assert.deepEqual((await loadVisibility(caller(db, OWNER, true))).body, { top5Public: true })
    assert.equal((await saveVisibility(caller(db, OWNER, true), { top5Public: false })).status, 200)
    assert.equal(await top5IsPublic(db as unknown as Caller['svc']), false)
  })

  test('staff can neither read nor change it', async () => {
    const db = settings()
    assert.equal((await loadVisibility(caller(db, STAFF, false))).status, 403)
    assert.equal((await saveVisibility(caller(db, STAFF, false), { top5Public: true })).status, 403)
    assert.equal(await top5IsPublic(db as unknown as Caller['svc']), false)
  })

  test('a yes or no is required', async () => {
    assert.equal((await saveVisibility(caller(settings(), OWNER, true), { top5Public: 'yes' })).status, 400)
  })
})
