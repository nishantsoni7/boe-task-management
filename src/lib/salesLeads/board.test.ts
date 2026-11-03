/**
 * Sales, Lead Board: the rules My day, the board and the lead panel share.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/board.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checklistFor, countryOf, DEAD_REASONS, dueOf, flagOf, lastLabel, marketLabel, parseValue, quickMessages, rankMyDay, STAGES, valueLabel, whatsAppLink, whyFirst,
} from './board'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const MIGRATION = read('supabase/migrations/20270525000000_sales_lead_board.sql') + read('supabase/migrations/20270526000100_sales_go_live.sql')

const TODAY = '2026-11-03'
const NOW = Date.parse('2026-11-03T06:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const base = {
  stage: 'under_process', stuck: false, first_attempt_at: hoursAgo(100) as string | null, assigned_at: hoursAgo(200), last_activity_at: hoursAgo(100) as string | null,
  temperature: 'warm', expected_value_paise: null as number | null, next_due_on: TODAY as string | null, enquired_again_at: null as string | null,
}

describe('the words stay in step with the database', () => {
  test('every stage and every dead reason is one the database accepts', () => {
    for (const s of STAGES) assert.ok(MIGRATION.includes(`'${s.key}'`), s.key)
    for (const r of DEAD_REASONS) assert.ok(MIGRATION.includes(`'${r.value}'`), r.value)
  })
})

describe('when the next step is due', () => {
  test('past, today, tomorrow and later read in words', () => {
    assert.deepEqual(dueOf({ stage: 'new', next_due_on: '2026-10-28' }, TODAY), { label: 'Overdue 6 d', tone: 'over' })
    assert.deepEqual(dueOf({ stage: 'new', next_due_on: TODAY }, TODAY), { label: 'Today', tone: 'today' })
    assert.deepEqual(dueOf({ stage: 'new', next_due_on: '2026-11-04' }, TODAY), { label: 'Tomorrow', tone: 'plain' })
    assert.deepEqual(dueOf({ stage: 'new', next_due_on: '2026-11-10' }, TODAY), { label: '10 Nov', tone: 'plain' })
  })
  test('a parked lead has no deadline until its day comes', () => {
    assert.equal(dueOf({ stage: 'follow_up_later', next_due_on: '2026-12-01' }, TODAY).label, 'Wakes 1 Dec')
    assert.equal(dueOf({ stage: 'follow_up_later', next_due_on: TODAY }, TODAY).label, 'Today')
    assert.equal(dueOf({ stage: 'follow_up_later', next_due_on: '2026-11-01' }, TODAY).tone, 'over')
  })
  test('a closed lead says how it ended', () => {
    assert.equal(dueOf({ stage: 'converted', next_due_on: null }, TODAY).label, 'Converted')
    assert.equal(dueOf({ stage: 'dead', next_due_on: null, dead_reason: 'price_too_high' }, TODAY).label, 'Price too high')
  })
})

describe('the warning on a card', () => {
  test('a lead nobody has tried counts up from allotment', () => {
    const lead = { ...base, stage: 'new', first_attempt_at: null, last_activity_at: null }
    assert.deepEqual(flagOf({ ...lead, assigned_at: hoursAgo(0.5) }, NOW), { kind: 'waiting', label: 'Waiting 30 min', red: false })
    assert.deepEqual(flagOf({ ...lead, assigned_at: hoursAgo(5) }, NOW), { kind: 'waiting', label: 'Waiting 5 h', red: false })
    assert.deepEqual(flagOf({ ...lead, assigned_at: hoursAgo(50), stuck: true }, NOW), { kind: 'waiting', label: 'Waiting 2 d', red: true })
  })
  test('anything else speaks up only when the database says it is stuck', () => {
    assert.equal(flagOf(base, NOW), null)
    assert.deepEqual(flagOf({ ...base, stuck: true, last_activity_at: hoursAgo(240) }, NOW), { kind: 'stuck', label: 'Stuck 10 d', red: true })
  })
  test('a parked or closed lead never warns', () => {
    for (const stage of ['follow_up_later', 'converted', 'dead']) assert.equal(flagOf({ ...base, stage, stuck: true, first_attempt_at: null }, NOW), null)
  })
})

describe('the order of My day', () => {
  const lead = (id: string, over: Partial<typeof base>) => ({ ...base, id, ...over })
  test('uncalled leads first, then Hot, then the biggest value, then the longest overdue', () => {
    const rows = [
      lead('warm-small', { expected_value_paise: 100 }),
      lead('warm-old', { next_due_on: '2026-10-01' }),
      lead('hot-small', { temperature: 'hot', expected_value_paise: 100 }),
      lead('hot-big', { temperature: 'hot', expected_value_paise: 9_000 }),
      lead('cold', { temperature: 'cold' }),
      lead('uncalled-cold', { temperature: 'cold', first_attempt_at: null }),
      lead('uncalled-hot', { temperature: 'hot', first_attempt_at: null }),
    ]
    assert.deepEqual(rankMyDay(rows).map(r => r.id), ['uncalled-hot', 'uncalled-cold', 'hot-big', 'hot-small', 'warm-small', 'warm-old', 'cold'])
  })
  test('does not disturb the list it was given', () => {
    const rows = [lead('a', {}), lead('b', { temperature: 'hot' })]
    rankMyDay(rows)
    assert.equal(rows[0].id, 'a')
  })
  test('the card says why a lead is on top', () => {
    assert.equal(whyFirst({ ...base, first_attempt_at: null, last_activity_at: null }, TODAY), 'New lead, nobody has called yet')
    assert.equal(whyFirst({ ...base, enquired_again_at: hoursAgo(1), last_activity_at: null }, TODAY), 'Came back with a new enquiry')
    assert.equal(whyFirst({ ...base, temperature: 'hot', next_due_on: '2026-11-01' }, TODAY), 'Hot and overdue')
    assert.equal(whyFirst({ ...base, temperature: 'hot' }, TODAY), 'Hot, due today')
    assert.equal(whyFirst({ ...base, next_due_on: '2026-11-01' }, TODAY), 'Overdue')
    assert.equal(whyFirst(base, TODAY), 'Due today')
  })
})

describe('the stage checklist', () => {
  const lead = { stage: 'under_process', first_contact_at: null as string | null, requirement: null as string | null, quantity: null as string | null, timeline: null as string | null, expected_value_paise: null as number | null }
  test('asks for what the database asks for', () => {
    assert.deepEqual(checklistFor({ ...lead, stage: 'new' }, false)?.items.map(i => i.fact), ['contact'])
    assert.deepEqual(checklistFor(lead, false)?.items.map(i => i.fact), ['requirement', 'quantity'])
    assert.deepEqual(checklistFor({ ...lead, stage: 'potential' }, false)?.items.map(i => i.fact), ['quotation', 'value', 'timeline'])
  })
  test('counts what is left', () => {
    assert.equal(checklistFor({ ...lead, requirement: 'Chairs' }, false)?.left, 1)
    const check = checklistFor({ ...lead, stage: 'potential', expected_value_paise: 1_40_00_000, timeline: 'March' }, true)
    assert.equal(check?.left, 0)
    assert.equal(check?.items[1].value, '₹ 1.4 L')
  })
  test('the last steps have no checklist', () => {
    for (const stage of ['negotiation', 'follow_up_later', 'converted', 'dead']) assert.equal(checklistFor({ ...lead, stage }, false), null)
  })
})

describe('money', () => {
  test('reads the Indian way', () => {
    assert.equal(valueLabel(14_00_000 * 100), '₹ 14 L')
    assert.equal(valueLabel(9_50_000 * 100), '₹ 9.5 L')
    assert.equal(valueLabel(14_00_00_000 * 100), '₹ 14 Cr')
    assert.equal(valueLabel(85_000 * 100), '₹ 85,000')
  })
  test('takes what a person types', () => {
    assert.equal(parseValue('14,00,000'), 14_00_000 * 100)
    assert.equal(parseValue('14 L'), 14_00_000 * 100)
    assert.equal(parseValue('₹ 1.5 cr'), 1_50_00_000 * 100)
    assert.equal(parseValue('85000'), 85_000 * 100)
    for (const bad of ['', 'soon', '12 lakh chairs']) assert.equal(parseValue(bad), null)
  })
})

describe('Domestic and Export', () => {
  test('the country comes from the number', () => {
    assert.equal(countryOf('+971501234482'), 'UAE')
    assert.equal(countryOf('+254724000681'), 'Kenya')
    assert.equal(countryOf('+14155550132'), 'USA / Canada')
    assert.equal(countryOf('+8613800000000'), null)
    assert.equal(marketLabel({ market: 'export', phone: '+971501234482' }), 'Export · UAE')
    assert.equal(marketLabel({ market: 'export', phone: '+8613800000000' }), 'Export')
    assert.equal(marketLabel({ market: 'domestic', phone: '+919876543210' }), 'Domestic')
  })
})

describe('the last touch', () => {
  test('reads in words', () => {
    assert.equal(lastLabel({ last_activity_at: null, last_kind: null }, TODAY), 'No contact yet')
    assert.equal(lastLabel({ last_activity_at: '2026-11-03T01:00:00Z', last_kind: 'call' }, TODAY), 'Last call today')
    assert.equal(lastLabel({ last_activity_at: '2026-11-02T01:00:00Z', last_kind: 'whatsapp' }, TODAY), 'Last whatsapp yesterday')
    assert.equal(lastLabel({ last_activity_at: '2026-10-24T01:00:00Z', last_kind: 'meeting' }, TODAY), 'Last meeting 10 d ago')
  })
})

describe('WhatsApp', () => {
  test('the link fills the message in and sends nothing', () => {
    const link = whatsAppLink('+919812340917', 'Hello, this is Ashok')
    assert.equal(link, 'https://wa.me/919812340917?text=Hello%2C%20this%20is%20Ashok')
    assert.equal(whatsAppLink('+919812340917'), 'https://wa.me/919812340917')
  })
  test('the messages carry the first name of the person sending them', () => {
    assert.ok(quickMessages('Ashok Kumar')[0].text.startsWith('Hello, this is Ashok from Best of Exports'))
    assert.equal(quickMessages('Ashok').length, 3)
  })
})

describe('the rules that must not be undone', () => {
  test('an open allotted lead cannot exist without a next step', () => {
    assert.match(MIGRATION, /sales_leads_open_has_next_step check/)
  })
  test('the Lead Master follows the same visibility rule as the board', () => {
    assert.match(MIGRATION, /drop policy sales_leads_read/)
    assert.match(MIGRATION, /create or replace function public\.sales_leads_page/)
    assert.match(MIGRATION, /create or replace function public\.get_sales_lead/)
  })
  test('nothing on the board depends on dragging alone', () => {
    const board = read('src/components/salesLeads/BoardScreen.tsx')
    assert.match(board, /draggable=/)
    assert.match(board, /work\.openMove\(lead\)/)
  })
})
