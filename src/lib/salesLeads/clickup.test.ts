/**
 * Sales: reading a ClickUp export. Every name and number here is made up: real exports stay out of the repository.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/clickup.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEAD_REASONS } from './board'
import {
  buildPlan, deadReasonFor, guessHolder, mapTask, parseClickupDate, parseCsv, readExport, ruleFor, sourceFor, spreadFollowUps,
  statusFamily, toSave, workingDay, type ClickupTask, type PlannedLead,
} from './clickup'

const MIGRATION = readFileSync(join(process.cwd(), 'supabase/migrations/20270526000100_sales_go_live.sql'), 'utf8')
const TODAY = '2026-11-03' // a Tuesday

const task = (over: Partial<ClickupTask> = {}): ClickupTask => ({
  'Task ID': 'abc1', 'Task Name': 'Hotel Sunrise', Status: 'under process (ak)', 'Task Content': '', Priority: 'none', tags: '',
  'Latest Comment': 'Called, will revert', 'Comment Count': '3', 'Due Date': 'Monday, November 9th 2026',
  'Date Created': 'Wednesday, July 30th 2025, 4:55:41 pm +05:30', 'Date Updated': 'Monday, September 15th 2025, 5:56:45 pm +05:30',
  Folder: 'Ashok', List: 'Ashok Leads', 'Phone (phone)': '+91 90000 00001', 'Lead Source (drop down)': 'Insta Promotion',
  'Reasons (drop down)': '', 'Customer Type (drop down)': '', 'Email (email)': 'a@sunrise.test', 'Location (short text)': 'Goa', 'Requirement (text)': 'Chairs',
  ...over,
})
const lead = (over: Partial<ClickupTask> = {}) => mapTask(task(over)) as PlannedLead

describe('reading the file', () => {
  test('quoted commas, doubled quotes and line breaks stay inside their field', () => {
    assert.deepEqual(parseCsv('a,b\n"one, two","say ""hi""\nthere"\n'), [['a', 'b'], ['one, two', 'say "hi"\nthere']])
    assert.deepEqual(parseCsv('﻿a\r\n1\r\n'), [['a'], ['1']])
  })
  test('columns are read by name, whatever order this list has them in', () => {
    const tasks = readExport('"Status","Task Name","Task ID"\n"new leads (ak)","Hotel","t1"\n')
    assert.deepEqual(tasks, [{ Status: 'new leads (ak)', 'Task Name': 'Hotel', 'Task ID': 't1' }])
  })
  test('a file that is not a task export is refused', () => {
    assert.equal(readExport('Name,Amount\nx,1\n'), null)
  })
  test('both of ClickUp\'s date forms are understood', () => {
    assert.deepEqual(parseClickupDate('Wednesday, July 30th 2025, 4:55:41 pm +05:30'), { day: '2025-07-30', iso: '2025-07-30T16:55:41+05:30' })
    assert.equal(parseClickupDate('Tuesday, September 2nd 2025')?.day, '2025-09-02')
    assert.equal(parseClickupDate('Monday, March 1st 2026, 12:05:00 am +05:30')?.iso, '2026-03-01T00:05:00+05:30')
    assert.equal(parseClickupDate('Monday, March 1st 2026, 12:05:00 pm +05:30')?.iso, '2026-03-01T12:05:00+05:30')
    assert.equal(parseClickupDate(''), null)
  })
})

describe('what each status becomes', () => {
  test('every salesperson\'s copy of a status is one status', () => {
    assert.equal(statusFamily('important bulk (moh)'), 'important bulk')
    assert.equal(statusFamily('potential customers'), 'potential customers')
  })
  test('the kind of lead stops being a stage', () => {
    assert.deepEqual(ruleFor(task({ Status: 'important bulk (ak)' })), { stage: 'under_process', segment: 'bulk' })
    assert.deepEqual(ruleFor(task({ Status: 'bulk (ak)' })), { stage: 'under_process', segment: 'bulk', temperature: 'cold' })
    assert.equal(ruleFor(task({ Status: 'overseas (moh)' }))?.stage, 'under_process')
    assert.equal(ruleFor(task({ Status: 'follow up later on (ak)' }))?.stage, 'follow_up_later')
    assert.equal(ruleFor(task({ Status: 'planned visit (nam)' }))?.step, 'Meeting')
  })
  test('anything in a Dead list is dead, whatever its status says', () => {
    for (const Status of ['leads', 'live again', 'reference']) {
      assert.equal(ruleFor(task({ Status, List: 'Prerna All Dead Leads' }))?.stage, 'dead', Status)
    }
    assert.equal(ruleFor(task({ Status: 'dead leads (mn)', List: 'Shravi Dead Leads' }))?.stage, 'dead')
  })
  test('a status nobody has decided about is refused, not guessed', () => {
    assert.equal(ruleFor(task({ Status: 'leads', List: 'Ashok Leads' })), null)
    assert.match((mapTask(task({ Status: 'something new' })) as { why: string }).why, /Status not known/)
  })
})

describe('what a task keeps', () => {
  test('a number standing in for a name is not a name', () => {
    assert.equal(lead({ 'Task Name': '80930 09165' }).name, null)
    assert.equal(lead().name, 'Hotel Sunrise')
  })
  test('the number can come from the name when the phone field is empty', () => {
    assert.equal(lead({ 'Phone (phone)': '', 'Task Name': '98765 43210' }).phone, '+919876543210')
  })
  test('no valid number at all cannot come across', () => {
    assert.equal((mapTask(task({ 'Phone (phone)': '', 'Task Name': 'Hotel' })) as { why: string }).why, 'No valid number')
  })
  test('marked urgent or important is Hot, and plain Bulk is Cold', () => {
    assert.equal(lead({ Priority: 'URGENT' }).temperature, 'hot')
    assert.equal(lead({ tags: '[imp, track]' }).temperature, 'hot')
    assert.equal(lead({ Status: 'bulk (ak)' }).temperature, 'cold')
    assert.equal(lead({ Status: 'important bulk (ak)' }).temperature, 'warm')
  })
  test('Customer Type is the segment when it was filled in', () => {
    assert.equal(lead({ 'Customer Type (drop down)': 'Reseller', Status: 'bulk (ak)' }).segment, 'reseller')
    assert.equal(lead({ 'Customer Type (drop down)': 'Architect' }).client_type, 'other')
  })
  test('a bad email is dropped from the lead, and stays in the original', () => {
    const l = lead({ 'Email (email)': 'not an email' })
    assert.equal(l.email, null)
    assert.equal(l.raw['Email (email)'], 'not an email')
  })
  test('the requirement and the task description are both kept, once each', () => {
    assert.equal(lead({ 'Task Content': 'Tables too' }).requirement, 'Chairs\nTables too')
    assert.equal(lead({ 'Task Content': 'Chairs' }).requirement, 'Chairs')
  })
  test('sources map to the Lead Master\'s list, and an unknown one to Others', () => {
    assert.equal(sourceFor('Insta Promotion'), 'insta_promo')
    assert.equal(sourceFor('Fair Invitation'), 'campaign')
    assert.equal(sourceFor('Cold Calling'), 'others')
    assert.equal(sourceFor(''), 'others')
  })
  test('the original keeps what it says and leaves out what is empty', () => {
    const raw = lead({ 'Date Closed': '', Assignee: '[]', 'Time In Status': '11047 hours' }).raw
    assert.equal(raw.Status, 'under process (ak)')
    assert.equal('Date Closed' in raw, false)
    assert.equal('Assignee' in raw, false)
    assert.equal('Time In Status' in raw, false)
  })
})

describe('why a lead died', () => {
  test('ClickUp\'s reasons land on the agreed list', () => {
    assert.equal(deadReasonFor('No Response').reason, 'not_responding')
    assert.equal(deadReasonFor('No Requirement ').reason, 'no_requirement')
    assert.equal(deadReasonFor('NOT RELEVANT ').reason, 'not_relevant')
    assert.equal(deadReasonFor('Residential ').reason, 'retail_enquiry')
    assert.equal(deadReasonFor('Ordered via Competitor').reason, 'chose_another_supplier')
    assert.deepEqual(deadReasonFor('LANGUAGE PROBLEM '), { reason: 'other', note: 'Language problem' })
  })
  test('no reason is said out loud, and an unknown one is kept in its own words', () => {
    assert.deepEqual(deadReasonFor(''), { reason: 'other', note: 'No reason recorded in ClickUp' })
    assert.deepEqual(deadReasonFor('Moved abroad'), { reason: 'other', note: 'Moved abroad' })
  })
  test('every reason the screen offers is one the database accepts', () => {
    for (const r of DEAD_REASONS) assert.ok(MIGRATION.includes(`'${r.value}'`), r.value)
  })
})

describe('catching up', () => {
  const open = (id: string, over: Partial<ClickupTask> = {}) => lead({ 'Task ID': id, 'Phone (phone)': `+91 90000 0${id.padStart(4, '0')}`, 'Due Date': 'Monday, June 1st 2026', ...over })
  test('Sunday is not a working day', () => {
    assert.equal(workingDay('2026-11-08'), '2026-11-09')
    assert.equal(workingDay('2026-11-07'), '2026-11-07')
  })
  test('a follow-up still ahead keeps its date', () => {
    const [l] = spreadFollowUps([open('1', { 'Due Date': 'Monday, November 9th 2026' })], 2, TODAY)
    assert.equal(l.next_due_on, '2026-11-09')
  })
  test('overdue ones are shared out, no more than the limit a day, and never on a Sunday', () => {
    const out = spreadFollowUps(['1', '2', '3', '4', '5', '6', '7'].map(id => open(id)), 2, '2026-11-06')
    const days = out.map(l => l.next_due_on).sort()
    assert.deepEqual(days, ['2026-11-06', '2026-11-06', '2026-11-07', '2026-11-07', '2026-11-09', '2026-11-09', '2026-11-10'])
  })
  test('a day already full of planned follow-ups is skipped', () => {
    const planned = open('1', { 'Due Date': 'Tuesday, November 3rd 2026' })
    const out = spreadFollowUps([planned, open('2')], 1, TODAY)
    assert.equal(out[1].next_due_on, '2026-11-04')
  })
  test('nobody called them first, then Hot, then furthest along', () => {
    const out = spreadFollowUps([
      open('1', { Status: 'under process (ak)' }),
      open('2', { Status: 'potential clients' }),
      open('3', { Priority: 'URGENT' }),
      open('4', { 'Comment Count': '0', Status: 'new leads (ak)' }),
    ], 1, TODAY)
    const order = [...out].sort((a, b) => (a.next_due_on ?? '').localeCompare(b.next_due_on ?? '')).map(l => l.task_id)
    assert.deepEqual(order, ['4', '3', '2', '1'])
  })
  test('each person has their own days', () => {
    const out = spreadFollowUps([open('1'), open('2', { Folder: 'Mohit Sharma' })], 1, TODAY)
    assert.deepEqual(out.map(l => l.next_due_on), [TODAY, TODAY])
  })
  test('a dead lead gets no date', () => {
    const [l] = spreadFollowUps([open('1', { Status: 'dead leads (ak)' })], 5, TODAY)
    assert.equal(l.next_due_on, null)
  })
})

describe('the plan', () => {
  const t = (id: string, phone: string, over: Partial<ClickupTask> = {}) => task({ 'Task ID': id, 'Phone (phone)': phone, ...over })
  test('a task in two files counts once, and the later version wins', () => {
    const plan = buildPlan([
      [t('1', '+91 90000 00001', { Status: 'under process (ak)' })],
      [t('1', '+91 90000 00001', { Status: 'potential clients', 'Date Updated': 'Tuesday, October 20th 2026, 1:00:00 pm +05:30' })],
    ], 20, TODAY)
    assert.equal(plan.tasks, 1)
    assert.equal(plan.repeats, 1)
    assert.equal(plan.rows[0].stage, 'potential')
  })
  test('on a shared number the open lead survives, and the other goes on it as a note', () => {
    const plan = buildPlan([[
      t('1', '+91 90000 00001', { Status: 'dead leads (ak)', 'Date Updated': 'Tuesday, October 20th 2026, 1:00:00 pm +05:30' }),
      t('2', '+91 90000 00001', { Status: 'under process (ak)' }),
    ]], 20, TODAY)
    assert.deepEqual(plan.rows.map(r => r.task_id), ['2', '1'])
    assert.deepEqual([plan.open, plan.dead, plan.samePhone], [1, 0, 1])
  })
  test('the counts add up to the tasks', () => {
    const plan = buildPlan([[
      t('1', '+91 90000 00001'), t('2', '+91 90000 00002', { Status: 'dead leads (ak)' }), t('3', '+91 90000 00001'), t('4', ''),
    ]], 20, TODAY)
    assert.equal(plan.open + plan.dead + plan.samePhone + plan.refused.length, plan.tasks)
  })
  test('a folder is matched to the one person with that first name', () => {
    const people = [{ id: 'd', full_name: 'Dhruv Rajpurohit' }, { id: 'a', full_name: 'Ashok kumar' }, { id: 'm1', full_name: 'Mohit Sharma' }, { id: 'm2', full_name: 'Mohit Jain' }]
    assert.equal(guessHolder('Dhruv Raj', people), 'd')
    assert.equal(guessHolder('Ashok', people), 'a')
    assert.equal(guessHolder('Mohit Sharma', people), null, 'two people could be Mohit: the owner chooses')
    assert.equal(guessHolder('Saket', people), null)
  })
  test('what is saved has a holder and a date, or neither', () => {
    const plan = buildPlan([[t('1', '+91 90000 00001'), t('2', '+91 90000 00002', { Folder: 'Mohit Sharma' })]], 20, TODAY)
    const rows = toSave(plan, { Ashok: 'user-1', 'Mohit Sharma': null })
    const held = rows.find(r => r.task_id === '1')!
    const free = rows.find(r => r.task_id === '2')!
    assert.equal(held.holder_id, 'user-1')
    assert.ok(held.next_due_on)
    assert.deepEqual([free.holder_id, free.next_step, free.next_due_on], [null, null, null])
    assert.equal('folder' in held, false, 'only what the database takes is sent')
  })
})
