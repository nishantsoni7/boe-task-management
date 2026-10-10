/**
 * Exhibition Leads — the pure logic, pinned.
 *
 * The database is authoritative (supabase/tests/exhibition_leads_assertions.sql
 * proves that, against Postgres). What lives here is the browser's copy of the
 * rules — phone normalisation, validation, filter serialisation, ranking
 * leaders, CSV safety, error mapping — and that it agrees with the SQL.
 *
 * Run: npx tsx --test src/lib/exhibitionLeads/exhibitionLeads.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeLeadPhone, joinPhone, phoneError, formatPhone, telHref, whatsappHref } from './phone'
import {
  emptyLeadForm, toCreateArgs, toggleRequirement, validateLeadForm, type LeadFormValues,
} from './validation'
import {
  ALL_LIST_PARAMS, MY_LIST_PARAMS, activeFilterCount, dateWindow, toRpcFilter, toggleIn,
  uuidListParam, textListParam, type ListFilterState,
} from './filters'
import { parseListState, buildListSearch } from '@/lib/listState'
import { joinNames, leadersOf, summariseRanking, type RankingData } from './ranking'
import { buildLeadsCsv, phoneCell, LEAD_CSV_COLUMNS, type ExportLead } from './csv'
import { classifyLeadError } from './errors'
import { exhibitionDates, istDateTime, pickDefaultExhibition, shortDate } from './format'
import { newSubmissionId } from './draft'
import { CLIENT_TYPES, LEAD_TYPES, REQUIREMENTS, STATUSES, optionValues } from './constants'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

// ── Phone ────────────────────────────────────────────────────────────────────

describe('phone normalisation', () => {
  const same = '+919876543210'
  test('every Indian spelling of one number collapses to one key', () => {
    for (const v of ['9876543210', '98765 43210', '098765 43210', '919876543210', '+91 98765-43210',
      '0091 98765 43210', '(+91) 98765 43210', '+91 0 98765 43210', '+919876543210']) {
      assert.equal(normalizeLeadPhone(v), same, v)
    }
  })
  test('international numbers keep any valid length — no ten-digit rule', () => {
    assert.equal(normalizeLeadPhone('+44 20 7946 0958'), '+442079460958')
    assert.equal(normalizeLeadPhone('+1 (202) 555-0143'), '+12025550143')
    assert.equal(normalizeLeadPhone('0044 20 7946 0958'), '+442079460958')
    assert.equal(normalizeLeadPhone('+971 50 123 4567'), '+971501234567')
    assert.equal(normalizeLeadPhone('+49 30 12345678'), '+493012345678')
  })
  test('rejects what cannot be a number', () => {
    for (const v of ['', '   ', '12345', '5876543210', '98765 4321', '+', '+0123456789', '+91 12345 67890',
      'abc', '9876543210x', '+1234567', '+1234567890123456', '++919876543210']) {
      assert.equal(normalizeLeadPhone(v), null, v)
    }
    assert.equal(normalizeLeadPhone(null), null)
    assert.equal(normalizeLeadPhone(undefined), null)
  })
  test('the form joins a country code and a national number', () => {
    assert.equal(joinPhone('91', '98765 43210'), '+919876543210')
    assert.equal(joinPhone('+44', '20 7946 0958'), '+442079460958')
    assert.equal(joinPhone('91', '+44 20 7946 0958'), '+442079460958', 'a pasted full number wins, separators stripped')
    assert.equal(phoneError('91', ''), 'Enter the mobile number')
    assert.equal(phoneError('91', '12ab'), 'Use digits only')
    assert.equal(phoneError('91', '12345'), 'Enter a valid mobile number')
    assert.equal(phoneError('91', '98765 43210'), null)
    assert.equal(phoneError('44', '20 7946 0958'), null)
  })
  test('display and links', () => {
    assert.equal(formatPhone('+919876543210'), '+91 98765 43210')
    assert.equal(formatPhone('+442079460958'), '+442079460958')
    assert.equal(telHref('+919876543210'), 'tel:+919876543210')
    assert.equal(whatsappHref('+919876543210'), 'https://wa.me/919876543210')
  })
  test('the SQL twin states the same rules (same vectors in its self-check)', () => {
    const sql = read('supabase/migrations/20270305000000_exhibition_leads.sql')
    for (const v of ["'98765 43210'", "'+91 98765-43210'", "'09876543210'", "'919876543210'", "'0091 98765 43210'", "'+44 20 7946 0958'"]) {
      assert.ok(sql.includes(v), `SQL self-check covers ${v}`)
    }
    for (const rx of ["'^[0-9]{10}$'", "'^0[0-9]{10}$'", "'^91[0-9]{10}$'", "'^91[6-9][0-9]{9}$'", "'^[1-9][0-9]{7,14}$'"]) {
      assert.ok(sql.includes(rx), `SQL uses ${rx}`)
    }
  })
})

// ── Validation ───────────────────────────────────────────────────────────────

describe('lead form validation', () => {
  const ok = (): LeadFormValues => ({
    ...emptyLeadForm(), contactName: ' Asha Rao ', mobile: '98765 43210',
    clientType: 'architect_designer', requirements: ['restaurant_cafe'], leadType: 'warm',
  })
  test('five required fields, nothing else', () => {
    assert.deepEqual(validateLeadForm(ok()), {})
    assert.deepEqual(Object.keys(validateLeadForm(emptyLeadForm())).sort(), ['clientType', 'contactName', 'leadType', 'mobile', 'requirements'])
  })
  test('Lead type is mandatory, has no default, and only the four values pass', () => {
    assert.equal(emptyLeadForm().leadType, '')
    assert.equal(validateLeadForm({ ...ok(), leadType: '' }).leadType, 'Choose a lead type')
    assert.equal(validateLeadForm({ ...ok(), leadType: 'urgent' as never }).leadType, 'Choose a lead type')
    for (const v of ['hot', 'warm', 'long_term', 'mismatched_retail'] as const) assert.deepEqual(validateLeadForm({ ...ok(), leadType: v }), {})
  })
  test('name is trimmed and non-empty', () => {
    assert.ok(validateLeadForm({ ...ok(), contactName: '   ' }).contactName)
    assert.equal(toCreateArgs(ok()).p_contact_name, 'Asha Rao')
  })
  test('requirement is multiple, client type single', () => {
    assert.ok(validateLeadForm({ ...ok(), requirements: [] }).requirements)
    assert.deepEqual(validateLeadForm({ ...ok(), requirements: ['restaurant_cafe', 'hotel'] }), {})
    assert.ok(validateLeadForm({ ...ok(), clientType: '' }).clientType)
  })
  test('the vocabularies are exactly the ones asked for', () => {
    assert.deepEqual(CLIENT_TYPES.map(o => o.label), ['Architect / Interior Designer', 'Property Owner', 'Consultant', 'Other'])
    assert.deepEqual(REQUIREMENTS.map(o => o.label), ['Restaurant / Cafe', 'Hotel', 'Residential'])
    // The visible label is the short name; the bracketed explanation is a hint behind the "i".
    assert.deepEqual(LEAD_TYPES.map(o => o.label), ['Hot', 'Warm', 'Long Term', 'Mismatched / Retail Inquiries'])
    assert.deepEqual(LEAD_TYPES.map(o => o.hint), [
      'Immediate RFQs / Active Site Plan',
      'Sourcing for Pipeline Projects',
      'General Networking & Future Roster',
      'Low Priority',
    ])
    for (const o of LEAD_TYPES) assert.ok(!o.label.includes('('), 'no bracket text in the visible label')
  })
  test('requirements toggle independently', () => {
    assert.deepEqual(toggleRequirement(['hotel'], 'restaurant_cafe'), ['hotel', 'restaurant_cafe'])
    assert.deepEqual(toggleRequirement(['hotel', 'restaurant_cafe'], 'hotel'), ['restaurant_cafe'])
    assert.deepEqual(toggleRequirement([], 'hotel'), ['hotel'])
  })
  test('"Other" needs a message, and only "Other" sends one', () => {
    assert.equal(validateLeadForm({ ...ok(), clientType: 'other' }).clientTypeOther, 'Say what kind of client this is')
    assert.equal(validateLeadForm({ ...ok(), clientType: 'other', clientTypeOther: '   ' }).clientTypeOther, 'Say what kind of client this is')
    assert.deepEqual(validateLeadForm({ ...ok(), clientType: 'other', clientTypeOther: 'Furniture retailer' }), {})
    assert.ok(validateLeadForm({ ...ok(), clientType: 'other', clientTypeOther: 'x'.repeat(201) }).clientTypeOther)
    assert.equal(toCreateArgs({ ...ok(), clientType: 'other', clientTypeOther: ' Furniture retailer ' }).p_client_type_other, 'Furniture retailer')
    // a message typed before switching away from Other is not sent
    assert.equal(toCreateArgs({ ...ok(), clientType: 'consultant', clientTypeOther: 'leftover' }).p_client_type_other, null)
    assert.deepEqual(validateLeadForm({ ...ok(), clientType: 'consultant', clientTypeOther: '' }), {}, 'no message needed for other types')
  })
  test('optional fields default sensibly and are sent only when filled', () => {
    const a = toCreateArgs(ok())
    assert.equal(a.p_lead_type, 'warm')
    assert.equal(toCreateArgs({ ...ok(), leadType: 'long_term' }).p_lead_type, 'long_term')
    assert.equal(a.p_company_name, null)
    assert.equal(a.p_project_city, null)
    assert.equal(a.p_buying_timeline, null)
    assert.equal(a.p_note, null)
    assert.equal(a.p_phone, '+919876543210')
  })
  test('the form asks for nothing it should not', () => {
    const keys = Object.keys(toCreateArgs(ok())).join(' ')
    for (const banned of ['email', 'address', 'gst', 'budget', 'salesperson', 'source']) {
      assert.ok(!keys.includes(banned), banned)
    }
  })
  test('the vocabularies are the ones the database checks', () => {
    // The original CHECK, widened for Residential by 20270310000000.
    const sql = read('supabase/migrations/20270305000000_exhibition_leads.sql')
      + read('supabase/migrations/20270310000000_exhibition_lead_requirement_residential.sql')
    for (const v of [...optionValues(CLIENT_TYPES), ...optionValues(REQUIREMENTS), ...optionValues(STATUSES)]) {
      assert.ok(sql.includes(`'${v}'`), `${v} is in the migration`)
    }
  })
})

// ── Filters ──────────────────────────────────────────────────────────────────

describe('list filters', () => {
  const parse = (qs: string, specs = MY_LIST_PARAMS) => parseListState(specs, new URLSearchParams(qs)) as ListFilterState
  const ctx = { scope: 'mine' as const, exhibitionId: 'e1', today: '2026-10-10', isAdmin: false }

  test('My Leads opens on Today, the admin list on the whole exhibition', () => {
    assert.equal(parse('').when, 'today')
    assert.equal(parse('', ALL_LIST_PARAMS).when, 'all')
  })
  test('date windows', () => {
    assert.deepEqual(dateWindow(parse(''), '2026-10-10'), { from: '2026-10-10', to: '2026-10-10' })
    assert.deepEqual(dateWindow(parse('when=date&day=2026-10-09'), '2026-10-10'), { from: '2026-10-09', to: '2026-10-09' })
    assert.deepEqual(dateWindow(parse('when=range&from=2026-10-11&to=2026-10-09'), '2026-10-10'), { from: '2026-10-09', to: '2026-10-11' }, 'a reversed range is put right')
    assert.deepEqual(dateWindow(parse('when=range&from=2026-10-09'), '2026-10-10'), { from: '2026-10-09', to: '2026-10-09' })
    assert.equal(dateWindow(parse('when=all'), '2026-10-10'), null)
    assert.equal(dateWindow(parse('when=range'), '2026-10-10'), null)
    assert.deepEqual(dateWindow(parse('when=date&day=2026-02-30'), '2026-10-10'), { from: '2026-10-10', to: '2026-10-10' }, 'an impossible date falls back to today')
  })
  test('categories and values map to the database filter', () => {
    const f = toRpcFilter(parse('type=consultant,other&ltype=hot,long_term&status=follow_up&follow=overdue,due_today&q=zed&city=Mysuru|Chennai&req=hotel'), ctx)
    assert.deepEqual(f.client_types, ['consultant', 'other'])
    assert.deepEqual(f.lead_types, ['hot', 'long_term'])
    assert.deepEqual(f.statuses, ['follow_up'])
    assert.deepEqual(f.follow_ups, ['overdue', 'due_today'])
    assert.equal(f.search, 'zed')
    assert.deepEqual(f.cities, ['Mysuru', 'Chennai'])
    assert.deepEqual(f.requirements, ['hotel'])
    assert.equal(f.scope, 'mine')
    assert.equal(f.exhibition_id, 'e1')
    assert.equal(f.date_from, '2026-10-10')
  })
  test('unknown values are dropped, never sent', () => {
    const f = toRpcFilter(parse('type=wizard,consultant&ltype=urgent,not_set&status=bogus&follow=never'), ctx)
    assert.deepEqual(f.client_types, ['consultant'])
    assert.equal(f.lead_types, undefined)
    assert.equal(f.statuses, undefined)
    assert.equal(f.follow_ups, undefined)
  })
  test('admin-only filters are sent only for an admin', () => {
    const id = 'a1b00000-0000-4000-8000-000000000003'
    const st = parse(`collector=${id}&owner=${id}&archived=archived`, ALL_LIST_PARAMS)
    const asSales = toRpcFilter(st, ctx)
    assert.equal(asSales.collector_ids, undefined)
    assert.equal(asSales.owner_ids, undefined)
    assert.equal(asSales.archived, undefined)
    const asAdmin = toRpcFilter(st, { ...ctx, scope: 'all', isAdmin: true })
    assert.deepEqual(asAdmin.collector_ids, [id])
    assert.deepEqual(asAdmin.owner_ids, [id])
    assert.equal(asAdmin.archived, 'archived')
  })
  test('filter count and toggling', () => {
    assert.equal(activeFilterCount(parse(''), false), 0)
    assert.equal(activeFilterCount(parse('type=consultant&q=x&status=new'), false), 3)
    assert.equal(activeFilterCount(parse('archived=archived', ALL_LIST_PARAMS), true), 1)
    assert.equal(activeFilterCount(parse('archived=archived', ALL_LIST_PARAMS), false), 0)
    assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b'])
    assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b'])
  })
  test('URL round trip: the state survives, and a filter change drops back to page 1', () => {
    const next = buildListSearch(MY_LIST_PARAMS, 'page=3&type=consultant', { page: 1, status: ['new'] })
    assert.equal(new URLSearchParams(next).get('page'), null)
    assert.equal(new URLSearchParams(next).get('status'), 'new')
    assert.equal(new URLSearchParams(next).get('type'), 'consultant')
  })
  test('id and text list codecs are strict', () => {
    assert.deepEqual(uuidListParam().parse('nope,a1b00000-0000-4000-8000-000000000003'), ['a1b00000-0000-4000-8000-000000000003'])
    assert.deepEqual(textListParam().parse('A | B'), ['A', 'B'])
    assert.equal(textListParam().serialize([]), null)
  })
})

// ── Ranking ──────────────────────────────────────────────────────────────────

describe('ranking leaders', () => {
  const rows = (...r: [string, Record<string, number>][]) => r.map(([name, per_day], i) => ({
    user_id: String(i), name, per_day, total: Object.values(per_day).reduce((a, b) => a + b, 0),
  }))
  const data = (r: ReturnType<typeof rows>, is_final = false): RankingData => ({
    exhibition: { id: 'e', name: 'Fair', starts_on: '2026-10-09', ends_on: '2026-10-11' },
    today: '2026-10-10', is_final, days: ['2026-10-09', '2026-10-10', '2026-10-11'], rows: r,
  })
  test('a single leader per day and overall', () => {
    const d = data(rows(['A', { '2026-10-09': 3, '2026-10-10': 1 }], ['B', { '2026-10-09': 1, '2026-10-10': 4 }]))
    const sum = summariseRanking(d)
    assert.deepEqual(sum.perDay['2026-10-09'], { names: ['A'], count: 3 })
    assert.deepEqual(sum.perDay['2026-10-10'], { names: ['B'], count: 4 })
    assert.deepEqual(sum.overall, { names: ['B'], count: 5 })
  })
  test('ties are joint leaders', () => {
    const d = data(rows(['A', { '2026-10-09': 2 }], ['B', { '2026-10-09': 2 }], ['C', { '2026-10-09': 1 }]))
    assert.deepEqual(summariseRanking(d).perDay['2026-10-09'], { names: ['A', 'B'], count: 2 })
    assert.equal(joinNames(['A', 'B']), 'A & B')
    assert.equal(joinNames(['A', 'B', 'C']), 'A, B & C')
  })
  test('all zero means no leader — not an arbitrary one', () => {
    const d = data(rows(['A', {}], ['B', {}]))
    const sum = summariseRanking(d)
    assert.equal(sum.overall, null)
    assert.equal(sum.perDay['2026-10-11'], null)
    assert.equal(leadersOf([], () => 0), null)
  })
  test('"Leader so far" until the last day has ended in India time, then the final leader', () => {
    assert.equal(summariseRanking(data(rows(['A', { '2026-10-09': 1 }]), false)).overallLabel, 'Leader so far')
    assert.equal(summariseRanking(data(rows(['A', { '2026-10-09': 1 }]), true)).overallLabel, 'Fair leader')
  })
  test('a salesperson with zero is a row, and never a leader', () => {
    const d = data(rows(['A', { '2026-10-10': 1 }], ['Zero', {}]))
    assert.deepEqual(summariseRanking(d).overall, { names: ['A'], count: 1 })
  })
  test('the ranking function takes no list filter (it cannot depend on one)', () => {
    const sql = read('supabase/migrations/20270305000000_exhibition_leads.sql')
    assert.match(sql, /function public\.exhibition_lead_ranking\(p_exhibition_id uuid\)/)
    const block = sql.slice(sql.indexOf('function public.exhibition_lead_ranking'), sql.indexOf('function public.export_exhibition_leads'))
    assert.ok(!block.includes('exhibition_leads_filtered'), 'ranking does not read the filtered set')
    assert.ok(block.includes("l.created_at at time zone 'Asia/Kolkata'"), 'IST days')
    assert.ok(block.includes('l.archived_at is null'), 'archived excluded')
    assert.ok(block.includes('l.collected_by'), 'credit is the original collector')
    assert.ok(!block.includes('owner_id'), 'ownership does not move credit')
  })
})

// ── CSV ──────────────────────────────────────────────────────────────────────

describe('CSV export', () => {
  const lead = (over: Partial<ExportLead> = {}): ExportLead => ({
    id: '1', exhibition_id: 'e', exhibition_name: 'Acetech Bangalore 2026', contact_name: 'Asha Rao', phone: '+919876543210', email: 'asha@raostudio.in', card_photo_path: null,
    client_type: 'architect_designer', client_type_other: null, requirements: ['restaurant_cafe', 'hotel'], company_name: null, project_city: 'Bengaluru',
    buying_timeline: 'within_1_month', lead_type: 'hot', status: 'follow_up', next_follow_up_on: '2026-10-12',
    initial_note: 'Needs 40 chairs', collected_by: 'c', collected_by_name: 'S One', owner_id: 'o', owner_name: 'S Two',
    created_at: '2026-10-09T18:30:00Z', updated_at: '2026-10-09T18:30:00Z', archived_at: null, archive_reason: null,
    latest_note: 'Sent catalogue', latest_note_at: null, ...over,
  })
  test('carries every requested column', () => {
    assert.deepEqual(LEAD_CSV_COLUMNS.map(c => c.header), [
      'Exhibition', 'Added (IST)', 'Original collector', 'Current owner', 'Contact name', 'Mobile', 'Email', 'Company / project', 'City',
      'Client type', 'Requirements', 'Buying timeline', 'Lead type', 'Status', 'Next follow-up', 'Initial discussion note',
      'Latest follow-up note', 'Card photo on file', 'Archived', 'Archive reason'])
  })
  test('BOM, CRLF, readable labels, India time', () => {
    const csv = buildLeadsCsv([lead()])
    assert.ok(csv.startsWith('﻿Exhibition,'))
    const lines = csv.trimEnd().split('\r\n')
    assert.equal(lines.length, 2)
    assert.ok(lines[1].includes('Architect / Interior Designer'))
    assert.ok(lines[1].includes('"Restaurant / Cafe, Hotel"'))
    assert.ok(lines[1].includes('2026-10-10 00:00:00'), 'the 18:30Z instant is midnight IST on the 10th')
    assert.ok(lines[1].includes('Hot') && lines[1].includes('Follow-up'))
  })
  test('"Other" carries its message into the export; lead type is the plain label, never the hint', () => {
    const csv = buildLeadsCsv([lead({ client_type: 'other', client_type_other: 'Furniture retailer', lead_type: 'mismatched_retail' }), lead({ lead_type: 'long_term' })])
    const rows = csv.trimEnd().split('\r\n')
    assert.ok(rows[1].includes('Other: Furniture retailer'))
    assert.ok(rows[1].includes('Mismatched / Retail Inquiries') && !rows[1].includes('Low Priority'))
    assert.ok(rows[2].includes(',Long Term,') && !rows[2].includes('Networking'))
  })
  test('commas, quotes and line breaks are escaped', () => {
    const csv = buildLeadsCsv([lead({ contact_name: 'Rao, "Asha"', initial_note: 'line one\nline two' })])
    assert.ok(csv.includes('"Rao, ""Asha"""'))
    assert.ok(csv.includes('"line one\nline two"'))
  })
  test('spreadsheet formulas are neutralised', () => {
    const csv = buildLeadsCsv([lead({ contact_name: '=HYPERLINK("http://x","y")', company_name: '+SUM(A1)', project_city: '-1+1', initial_note: '@cmd', latest_note: '\tx' })])
    for (const bad of ['"=HYPERLINK', ',=HYP', ',+SUM', ',-1+1', ',@cmd']) assert.ok(!csv.includes(bad), `no raw ${bad}`)
    assert.ok(csv.includes("'=HYPERLINK") && csv.includes("'+SUM(A1)") && csv.includes("'-1+1") && csv.includes("'@cmd"))
  })
  test('a phone number stays a phone number (plus kept, no number coercion)', () => {
    assert.equal(phoneCell('+919876543210'), '"=""+919876543210"""')
    assert.equal(phoneCell('=1+1'), "'=1+1")
  })
  test('archived state and reason', () => {
    const csv = buildLeadsCsv([lead({ archived_at: '2026-10-10T00:00:00Z', archive_reason: 'Test, entry' })])
    assert.ok(csv.includes(',Yes,"Test, entry"'))
  })
})

// ── Errors, format, ids ──────────────────────────────────────────────────────

describe('error mapping', () => {
  test('database sentences become actions', () => {
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_FORBIDDEN: nope' }).kind, 'forbidden')
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_NOT_FOUND: x' }).kind, 'not_found')
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_ARCHIVED: x' }).kind, 'archived')
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_DUPLICATE_PHONE: x' }).kind, 'duplicate_phone')
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_RESTORE_CONFLICT: x' }).kind, 'restore_conflict')
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_FOLLOW_UP_DATE_REQUIRED: x' }).kind, 'follow_up_date')
    assert.equal(classifyLeadError({ message: 'EXHIBITION_LEADS_SUBMISSION_CONFLICT: x' }).kind, 'conflict')
    assert.deepEqual(classifyLeadError({ message: 'EXHIBITION_LEADS_INVALID: Choose a client type' }), { kind: 'invalid', message: 'Choose a client type' })
  })
  test('an expired session and a lost connection are told apart', () => {
    assert.equal(classifyLeadError({ message: 'JWT expired', code: 'PGRST301' }).kind, 'auth')
    assert.equal(classifyLeadError({ message: 'x', status: 401 }).kind, 'auth')
    const lost = classifyLeadError({ message: 'Failed to fetch', status: 0 })
    assert.equal(lost.kind, 'uncertain')
    assert.match(lost.message, /Save again/)
    assert.equal(classifyLeadError({ message: 'weird' }).kind, 'unknown')
    assert.doesNotMatch(classifyLeadError({ message: 'weird' }).message, /saved\.$/)
  })
})

describe('format and ids', () => {
  test('dates are India dates', () => {
    assert.equal(shortDate('2026-10-09'), '9 Oct')
    assert.equal(istDateTime('2026-10-09T18:30:00Z'), '10 Oct, 12:00 am')
    assert.equal(exhibitionDates({ starts_on: '2026-10-09', ends_on: '2026-10-11' }), '9–11 Oct 2026')
  })
  test('the exhibition preselected', () => {
    const list = [
      { id: 'old', starts_on: '2026-03-01', ends_on: '2026-03-03' },
      { id: 'acetech', starts_on: '2026-10-09', ends_on: '2026-10-11' },
      { id: 'later', starts_on: '2027-02-01', ends_on: '2027-02-03' },
    ]
    assert.equal(pickDefaultExhibition(list, '2026-10-10')?.id, 'acetech')
    assert.equal(pickDefaultExhibition(list, '2026-10-07')?.id, 'acetech', 'next one to start')
    assert.equal(pickDefaultExhibition(list, '2026-10-12')?.id, 'later')
    assert.equal(pickDefaultExhibition(list.slice(0, 1), '2026-10-12')?.id, 'old')
    assert.equal(pickDefaultExhibition([], '2026-10-12'), null)
  })
  test('submission ids are v4 UUIDs and differ', () => {
    const a = newSubmissionId(), b = newSubmissionId()
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notEqual(a, b)
  })
})
