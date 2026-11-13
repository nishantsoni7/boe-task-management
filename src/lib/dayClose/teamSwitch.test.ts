// The Day Close / Scoreboard team switch (20270704000000): PAUSED unless the database says live. While paused
// the team is not shown, struck, scored, asked for proof or locked out of leave. The real handlers run over the
// in-memory database; the proof rule in the database is executed by supabase/tests/day_close_team_switch_pglite.mjs.

import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import { submitRequest } from '../attendance/requestHandlers'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { changeMembers, evaluateDay, loadMembers, loadMyPrompt, readSettings } from './server'
import { dayCloseSince } from './rules'
import { castVote, loadMyScore, loadVote, snapshotDay } from '../scoreboard/server'
import { loadStarSeller } from '../scoreboard/starSeller'

const OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a'
const DHRUV = 'eeeeeeee-0000-0000-0000-00000000000e' // switched on, with an overdue task
const NOW = '2026-11-13T06:00:00.000Z'               // Friday 13 Nov, 11:30 IST: the plan is late

let db: MemorySupabase
const svc = () => db as unknown as Caller['svc']
const caller = (id: string, role: string): Caller => ({ svc: svc(), id, role, team: null, isAdmin: role === 'admin' })
const settings = () => db.rows('day_close_settings')[0]
const setLive = (live: boolean | undefined) => { if (live === undefined) delete settings().team_live; else settings().team_live = live }

beforeEach(() => {
  const user = (id: string, name: string, role: string) => ({
    id, full_name: name, role, is_active: true, is_deleted: false, employee_code: name.slice(0, 3).toUpperCase(), minop_user_id: null,
  })
  db = new MemorySupabase({
    users: [user(OWNER, 'Nishant', 'admin'), user(DHRUV, 'Dhruv', 'member')],
    day_close_settings: [{ singleton: true, reviewer_id: OWNER, plan_due_minutes: 630, close_opens_minutes: 1080, team_live: false, live_since: null }],
    day_close_members: [{ employee_id: DHRUV, active: true, added_at: '2026-11-12T04:00:00Z' }],
    tasks: [{ id: 't1', title: 'Vendor report', status: 'working', due_date: '2026-11-11', assigned_to: DHRUV, created_by: OWNER }],
  })
})

describe('the switch reads as paused unless the database says live', () => {
  test('only a stored true is live', async () => {
    setLive(true); assert.equal((await readSettings(svc())).team_live, true)
    setLive(false); assert.equal((await readSettings(svc())).team_live, false)
    setLive(undefined); assert.equal((await readSettings(svc())).team_live, false)
  })

  test('a database without the switch columns still gives the times and the reviewer, paused', async () => {
    // The first read (with the switch columns) fails as it would before the migration is applied.
    const real = db.from.bind(db)
    let failedOnce = false
    ;(db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const q = real(table) as { select: (cols?: string) => unknown }
      if (table !== 'day_close_settings') return q
      return { ...q, select: (cols?: string) => {
        if (!failedOnce && cols?.includes('team_live')) {
          failedOnce = true
          return { eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column day_close_settings.team_live does not exist' } }) }) }
        }
        return q.select(cols)
      } }
    }
    const s = await readSettings(svc())
    assert.equal(s.team_live, false)
    assert.equal(s.reviewer_id, OWNER)
    assert.equal(s.plan_due_minutes, 630)
  })
})

describe('while paused', () => {
  test('the strip is silent for a member whose plan is overdue', async () => {
    const prompt = await loadMyPrompt(caller(DHRUV, 'member'), new Date(NOW))
    assert.deepEqual(prompt.body, { today: '2026-11-13', prompt: { kind: 'none' } })
  })

  test('the nightly check writes no strike, even for somebody who came in and did nothing', async () => {
    db.rows('users').find(u => u.id === DHRUV)!.minop_user_id = '17'
    db.tables.minop_punches = [
      { minop_user_id: '17', punch_at: '2026-11-13T04:32:00.000Z', punch_local: '2026-11-13 10:02:00', first_seen_at: '2026-11-13T04:32:30.000Z' },
      { minop_user_id: '17', punch_at: '2026-11-13T13:05:00.000Z', punch_local: '2026-11-13 18:35:00', first_seen_at: '2026-11-13T13:05:30.000Z' },
    ]
    assert.deepEqual(await evaluateDay(svc(), '2026-11-13'), { date: '2026-11-13', judged: 0, written: 0 })
    assert.equal(db.rows('day_strikes').length, 0)
    setLive(true)
    assert.equal((await evaluateDay(svc(), '2026-11-13')).written, 2)
  })

  test('leave sent with work pending is not locked', async () => {
    const r = await submitRequest(caller(DHRUV, 'member'), { request_type: 'full_day_leave', start_date: '2026-11-16', reason_code: 'personal' }, NOW)
    assert.equal(r.status, 201)
    assert.equal(r.body.work_pending, undefined)
    assert.equal(db.rows('day_close_leave_locks').length, 0)
    setLive(true)
    const again = await submitRequest(caller(DHRUV, 'member'), { request_type: 'full_day_leave', start_date: '2026-11-17', reason_code: 'personal' }, NOW)
    assert.equal(again.body.work_pending, '1 overdue task')
  })

  test('the Scoreboard card, the vote and the Star Seller card draw nothing, and no score record is written', async () => {
    const score = await loadMyScore(caller(DHRUV, 'member'), new Date(NOW))
    assert.deepEqual(score.body, { today: '2026-11-13', month: '2026-11-01', scored: false, top5: [], mostImproved: null, paused: true })

    const vote = await loadVote(caller(DHRUV, 'member'), new Date('2026-11-29T06:00:00Z')) // inside the vote window
    assert.equal(vote.body.open, false)
    assert.equal(vote.body.canVote, false)
    const cast = await castVote(caller(DHRUV, 'member'), { nominees: [] }, new Date('2026-11-29T06:00:00Z'))
    assert.equal(cast.status, 409)

    const star = await loadStarSeller(caller(DHRUV, 'member'), new Date(NOW))
    assert.equal(star.body.seller, null)

    assert.deepEqual(await snapshotDay(svc(), '2026-11-13'), { date: '2026-11-13', written: 0 })
    assert.equal((db.tables.scoreboard_daily ?? []).length, 0)
  })

  test('once live, the vote card is offered inside its window', async () => {
    setLive(true)
    const vote = await loadVote(caller(DHRUV, 'member'), new Date('2026-11-29T06:00:00Z'))
    assert.equal(vote.body.open, true)
    assert.equal(vote.body.canVote, true)
  })
})

describe('the switch itself', () => {
  test('an administrator turns it on, and the count starts from that moment', async () => {
    const r = await changeMembers(caller(OWNER, 'admin'), { action: 'set_live', live: true }, new Date(NOW))
    assert.equal(r.status, 200)
    assert.equal(settings().team_live, true)
    assert.equal(settings().live_since, NOW)
    const members = await loadMembers(caller(OWNER, 'admin'))
    assert.equal(members.body.live, true)
    assert.equal(members.body.live_since, NOW)
  })

  test('turning it off keeps when it was last turned on', async () => {
    await changeMembers(caller(OWNER, 'admin'), { action: 'set_live', live: true }, new Date(NOW))
    await changeMembers(caller(OWNER, 'admin'), { action: 'set_live', live: false }, new Date('2026-11-14T06:00:00Z'))
    assert.equal(settings().team_live, false)
    assert.equal(settings().live_since, NOW)
  })

  test('nobody but an administrator can change it, and the choice must be on or off', async () => {
    assert.equal((await changeMembers(caller(DHRUV, 'member'), { action: 'set_live', live: true })).status, 403)
    assert.equal(settings().team_live, false)
    // The reviewer seat alone is not enough: it is an administrator's switch.
    const reviewer = { ...caller(OWNER, 'member'), isAdmin: false }
    assert.equal((await changeMembers(reviewer, { action: 'set_live', live: true })).status, 403)
    assert.equal((await changeMembers(caller(OWNER, 'admin'), { action: 'set_live', live: 'yes' })).status, 400)
    assert.equal(settings().team_live, false)
  })
})

describe('days count from the day the switch was turned on', () => {
  const base = { active: true, addedAt: '2026-11-12T04:00:00Z', month: '2026-11-01', teamLive: true, liveSince: null as string | null }
  test('paused, or not switched on: nothing is judged', () => {
    assert.equal(dayCloseSince({ ...base, teamLive: false }), null)
    assert.equal(dayCloseSince({ ...base, active: false }), null)
  })
  test('live: from the day they were added, until the switch was turned on later', () => {
    assert.equal(dayCloseSince(base), '2026-11-12')
    assert.equal(dayCloseSince({ ...base, liveSince: '2026-11-20T05:00:00Z' }), '2026-11-20')
    assert.equal(dayCloseSince({ ...base, liveSince: '2026-11-05T05:00:00Z' }), '2026-11-12')
  })
  test('the day is the India day: 00:30 IST on the 21st is still the 21st', () => {
    assert.equal(dayCloseSince({ ...base, liveSince: '2026-11-20T19:00:00Z' }), '2026-11-21')
  })
})

describe('the screens and the database rule are wired to the switch', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
  test('the Today card drops every due / strike / proof message unless live is true', () => {
    assert.match(read('src/components/dayClose/DayCard.tsx'), /if \(day\.live !== true\) return null/)
  })
  test('the proof rule asks for the switch, and the migration starts paused', () => {
    const sql = read('supabase/migrations/20270704000000_day_close_team_switch.sql')
    assert.match(sql, /team_live\s+boolean not null default false/)
    assert.match(sql, /if not exists \(select 1 from public\.day_close_settings s where s\.singleton and s\.team_live\) then/)
    assert.doesNotMatch(sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n'), /grant\s+(select|insert|update|delete|all)[^;]*day_close_settings/i)
  })
})
