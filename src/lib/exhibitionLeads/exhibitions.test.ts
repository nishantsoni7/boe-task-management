/**
 * Managing exhibitions — the form rules, the "all exhibitions" URL value, the
 * messages when there is nothing to capture against, and the city field.
 * (The database half is in supabase/tests/exhibition_leads_assertions.sql,
 * section 9b, and the SQL source audit in migration.test.ts.)
 *
 * Run: npx tsx --test src/lib/exhibitionLeads/exhibitions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { daysBetween, validateExhibitionForm, type ExhibitionFormValues } from './exhibitions'
import { exParam, MY_LIST_PARAMS } from './filters'
import { exhibitionLabel, pickDefaultExhibition } from './format'
import { parseListState } from '@/lib/listState'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')

const ok = (): ExhibitionFormValues => ({ name: 'Acetech Bangalore 2026', city: 'Bengaluru', startsOn: '2026-10-09', endsOn: '2026-10-11', isActive: true })

describe('the exhibition form', () => {
  test('a name and two dates are required; the city is optional', () => {
    assert.deepEqual(validateExhibitionForm(ok()), {})
    assert.deepEqual(validateExhibitionForm({ ...ok(), city: '' }), {})
    assert.deepEqual(Object.keys(validateExhibitionForm({ name: '', city: '', startsOn: '', endsOn: '', isActive: true })).sort(), ['endsOn', 'name', 'startsOn'])
    assert.equal(validateExhibitionForm({ ...ok(), name: '   ' }).name, 'Enter the exhibition name')
  })
  test('the last day cannot precede the first; a fair runs at most 31 days', () => {
    assert.equal(validateExhibitionForm({ ...ok(), startsOn: '2026-10-11', endsOn: '2026-10-09' }).endsOn, 'The last day cannot be before the first day')
    assert.deepEqual(validateExhibitionForm({ ...ok(), startsOn: '2026-10-09', endsOn: '2026-10-09' }), {}, 'one day is fine')
    assert.deepEqual(validateExhibitionForm({ ...ok(), startsOn: '2026-10-01', endsOn: '2026-10-31' }), {}, '31 days is fine')
    assert.match(validateExhibitionForm({ ...ok(), startsOn: '2026-10-01', endsOn: '2026-11-01' }).endsOn ?? '', /at most 31 days/)
  })
  test('an impossible date is rejected, not guessed', () => {
    assert.equal(validateExhibitionForm({ ...ok(), startsOn: '2026-02-30' }).startsOn, 'Choose the first day')
    assert.equal(validateExhibitionForm({ ...ok(), endsOn: 'soon' }).endsOn, 'Choose the last day')
  })
  test('the day arithmetic is calendar days (no daylight-saving drift)', () => {
    assert.equal(daysBetween('2026-10-09', '2026-10-11'), 2)
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2)
    assert.equal(daysBetween('2026-10-11', '2026-10-09'), -2)
  })
  test('the same limits are written in the database function', () => {
    const sql = read('supabase/migrations/20270306000000_exhibition_management.sql')
    assert.ok(sql.includes('p_ends_on - p_starts_on > 30'))
    assert.ok(sql.includes('length(v_name) > 120') && sql.includes('length(coalesce(v_city, \'\')) > 80'))
  })
})

describe('"all exhibitions" and closed exhibitions', () => {
  test('?ex= accepts an exhibition id or the word all, and nothing else', () => {
    const id = 'a1b00000-0000-4000-8000-000000000003'
    assert.equal(exParam().parse('all'), 'all')
    assert.equal(exParam().parse(id.toUpperCase()), id)
    assert.equal(exParam().parse('everything'), '')
    assert.equal(exParam().parse('../etc'), '')
    assert.equal(exParam().serialize('all'), 'all')
    assert.equal(exParam().serialize('nope'), null)
    assert.equal((parseListState(MY_LIST_PARAMS, new URLSearchParams('ex=all')) as { ex: string }).ex, 'all')
  })
  test('closed exhibitions are labelled in pickers', () => {
    assert.equal(exhibitionLabel({ name: 'Acetech', is_active: true }), 'Acetech')
    assert.equal(exhibitionLabel({ name: 'Acetech', is_active: false }), 'Acetech (closed)')
  })
  test('the form opens on an open exhibition, preferring the one running today', () => {
    const open = [
      { starts_on: '2026-10-09', ends_on: '2026-10-11' },
      { starts_on: '2027-02-01', ends_on: '2027-02-03' },
    ]
    assert.equal(pickDefaultExhibition(open, '2026-10-10')?.starts_on, '2026-10-09')
    assert.equal(pickDefaultExhibition(open, '2026-12-01')?.starts_on, '2027-02-01', 'the next one to start')
    assert.equal(pickDefaultExhibition([], '2026-10-10'), null, 'nothing open → no default, the form says so')
  })
})

describe('when there is nothing to capture against', () => {
  const bits = read('src/components/exhibitionLeads/LeadBits.tsx')
  const add = read('src/components/exhibitionLeads/AddLeadScreen.tsx')
  const list = read('src/components/exhibitionLeads/LeadsListScreen.tsx')
  const ranking = read('src/components/exhibitionLeads/RankingScreen.tsx')

  test('an Admin is pointed at the screen that fixes it; everyone else is told to ask the Admin', () => {
    assert.ok(bits.includes('No exhibition has been added yet. Add one to start capturing leads.'))
    assert.ok(bits.includes('No exhibition has been added yet. Please ask your Admin to add it.'))
    assert.ok(bits.includes('Every exhibition is closed for new leads. Open one, or add a new exhibition.'))
    assert.ok(bits.includes('No exhibition is open for new leads right now. Please ask your Admin to open or add one.'))
    assert.match(bits, /\{isAdmin && \(\s*<div className=\{s\.noticeActions\}>\s*<Link[^>]*href="\/exhibition-leads\/exhibitions"/)
  })
  test('the form, the lists and the ranking all use it', () => {
    for (const src of [add, list, ranking]) assert.match(src, /<NoExhibitionNotice isAdmin=\{isAdmin\}/)
    assert.match(add, /closedOnly=\{exhibitions\.length > 0\}/)
    assert.doesNotMatch(add, /No active exhibition is set up yet/)
  })
  test('saving is impossible without an open exhibition', () => {
    assert.match(add, /disabled=\{!exhibitionId\}/)
    assert.match(add, /if \(!exhibitionId\) return/, 'submit itself refuses too')
    assert.match(add, /openExhibitions\.find\(e => e\.id === exhibitionId\)/, 'only open exhibitions can be chosen')
  })
})

describe('the exhibitions screen', () => {
  const screen = read('src/components/exhibitionLeads/ExhibitionsScreen.tsx')
  const layout = read('src/components/layout/ExhibitionLeadsLayout.tsx')
  test('it is for Admin: others are sent to their own leads, and the nav entry is admin-only', () => {
    assert.match(screen, /if \(!loading && !isAdmin\) router\.replace\('\/exhibition-leads\/my'\)/)
    assert.match(layout, /label: 'Exhibitions', icon: CalendarDays, adminOnly: true/)
  })
  test('it adds and edits through the database functions, and offers no delete', () => {
    assert.ok(screen.includes('createExhibition(supabase, values)') && screen.includes('updateExhibition(supabase, editing.id, values)'))
    assert.doesNotMatch(screen, /deleteExhibition|delete_exhibition|>s*Deletes*</, 'no delete action')
    assert.ok(screen.includes('Open for new leads'))
  })
  test('each exhibition links to its own leads and ranking', () => {
    assert.ok(screen.includes('/exhibition-leads/all?ex=${x.id}&when=all') && screen.includes('/exhibition-leads/ranking?ex=${x.id}'))
  })
  test('lists can span exhibitions and then name each lead\'s exhibition', () => {
    const list = read('src/components/exhibitionLeads/LeadsListScreen.tsx')
    assert.ok(list.includes('<option value="all">All exhibitions</option>'))
    assert.ok(list.includes('allExhibitions && l.exhibition_name'))
  })
})

describe('the city is typed, never picked', () => {
  const add = read('src/components/exhibitionLeads/AddLeadScreen.tsx')
  test('Advanced has a plain text box for the city: no list, no suggestions, no select', () => {
    const block = /<label className=\{s\.label\} htmlFor="lead-city">City<\/label>[\s\S]*?\/>/.exec(add)![0]
    assert.ok(block.includes('<input') && block.includes('placeholder="Type the city"'))
    assert.ok(block.includes('autoComplete="off"') && block.includes('autoCapitalize="words"'))
    assert.doesNotMatch(add.slice(add.indexOf('<summary>Advanced</summary>')), /<select|<datalist|list=/, 'nothing in Advanced offers choices for the city')
  })
})
