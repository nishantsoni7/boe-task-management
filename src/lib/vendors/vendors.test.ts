import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyVendorError } from './api'
import {
  CAPABILITIES, PRE_VISIT_STATUSES, PRODUCT_FOCUS, TEAM_SIZES, VENDOR_STATUSES, VISIT_KINDS, VISIT_OUTCOMES,
  labelOf, labelsOf, type VendorSummary,
} from './constants'
import { vendorsCsv } from './csv'
import { EMPTY_VENDOR, EMPTY_VISIT, isLiveSiteVisit, validateVendor, validateVisit, vendorPayload, type VisitContext } from './validation'

const MIGRATION = readFileSync('supabase/migrations/20270426000000_vendor_management.sql', 'utf8')

const goodVendor = {
  ...EMPTY_VENDOR, company_name: 'Sharma Wood Works', contact_name: 'Ramesh', phone: '98765 43210',
  address: 'Plot 14, Basni Industrial Area', capabilities: ['raw_pieces'],
}

describe('vendor form validation', () => {
  test('a complete vendor has no errors', () => {
    assert.deepEqual(validateVendor(goodVendor), {})
  })
  test('the required fields are named', () => {
    const e = validateVendor(EMPTY_VENDOR)
    for (const k of ['company_name', 'contact_name', 'phone', 'address', 'capabilities']) {
      assert.ok(e[k as keyof typeof e], `${k} is required`)
    }
  })
  test('a potential vendor (relaxed) needs only a name, but whatever is typed must still be valid', () => {
    assert.deepEqual(validateVendor({ ...EMPTY_VENDOR, company_name: 'Rathore Furniture' }, true), {})
    const e = validateVendor({ ...EMPTY_VENDOR, phone: '123', address: 'abc' }, true)
    assert.ok(e.company_name); assert.ok(e.phone); assert.ok(e.address)
    assert.equal(e.contact_name, undefined); assert.equal(e.capabilities, undefined)
  })
  test('phone numbers follow the same rules as the database', () => {
    assert.ok(validateVendor({ ...goodVendor, phone: '12345' }).phone)
    assert.ok(validateVendor({ ...goodVendor, phone: '5876543210' }).phone, 'an Indian mobile starts 6-9')
    assert.equal(validateVendor({ ...goodVendor, phone: '+971 50 123 4567' }).phone, undefined)
  })
  test('payload carries full phone numbers and trimmed text; no number stays empty', () => {
    const p = vendorPayload({ ...goodVendor, company_name: '  Sharma  ' })
    assert.equal(p.phone, '+919876543210')
    assert.equal(p.company_name, 'Sharma')
    assert.equal(vendorPayload({ ...EMPTY_VENDOR, company_name: 'X' }).phone, '')
  })
})

describe('visit validation', () => {
  const visit = { ...EMPTY_VISIT, person_met: 'Ramesh', discussion: 'Saw the workshop', outcome: 'interested' }
  const ctx = (over: Partial<VisitContext> = {}): VisitContext => ({
    kind: 'site_visit', enteredLater: false, photoKinds: ['factory'], needsFactoryPhoto: true, today: '2026-10-28', ...over,
  })
  test('a complete live first site visit with a factory photo passes', () => {
    assert.deepEqual(validateVisit(visit, ctx()), {})
  })
  test('a live site visit needs a photograph, and a factory one the first time', () => {
    assert.ok(validateVisit(visit, ctx({ photoKinds: [] })).photos)
    assert.ok(validateVisit(visit, ctx({ photoKinds: ['person'] })).photos)
    assert.equal(validateVisit(visit, ctx({ photoKinds: ['person'], needsFactoryPhoto: false })).photos, undefined)
  })
  test('a meeting at our factory needs no photographs', () => {
    assert.deepEqual(validateVisit(visit, ctx({ kind: 'vendor_at_our_factory', photoKinds: [] })), {})
  })
  test('a visit that already happened needs a day, not in the future, and no photographs', () => {
    const later = ctx({ enteredLater: true, photoKinds: [] })
    assert.ok(validateVisit(visit, later).visited_on)
    assert.ok(validateVisit({ ...visit, visited_on: '2026-10-30' }, later).visited_on)
    assert.deepEqual(validateVisit({ ...visit, visited_on: '2026-10-25' }, later), {})
  })
  test('only a live site visit counts as the proof event', () => {
    assert.equal(isLiveSiteVisit('site_visit', false), true)
    assert.equal(isLiveSiteVisit('site_visit', true), false)
    assert.equal(isLiveSiteVisit('vendor_at_our_factory', false), false)
  })
  test('follow-up outcome needs a date that is not in the past', () => {
    const f = { ...visit, outcome: 'follow_up_needed' }
    assert.ok(validateVisit(f, ctx({ needsFactoryPhoto: false })).next_follow_up_on)
    assert.ok(validateVisit({ ...f, next_follow_up_on: '2026-10-01' }, ctx({ needsFactoryPhoto: false })).next_follow_up_on)
    assert.equal(validateVisit({ ...f, next_follow_up_on: '2026-11-05' }, ctx({ needsFactoryPhoto: false })).next_follow_up_on, undefined)
  })
})

describe('error messages', () => {
  test('database errors become sentences', () => {
    assert.equal(classifyVendorError({ message: 'VENDOR_INVALID: Address is required' }).message, 'Address is required')
    assert.equal(classifyVendorError({ message: 'VENDORS_FORBIDDEN: x' }).kind, 'forbidden')
    assert.equal(classifyVendorError({ message: 'VENDOR_DUPLICATE_PHONE: x' }).kind, 'duplicate_phone')
    assert.equal(classifyVendorError({ message: 'Failed to fetch' }).kind, 'uncertain')
    assert.equal(classifyVendorError({ message: 'JWT expired' }).kind, 'auth')
    assert.equal(classifyVendorError({ message: 'boom' }).kind, 'unknown')
  })
})

describe('CSV export', () => {
  const row: VendorSummary = {
    id: 'x', company_name: '=cmd|calc', contact_name: 'Ramesh', phone: '+919876543210',
    status: 'approved', capabilities: ['raw_pieces', 'finishing_only'], product_focus: 'chairs_and_other', team_size: '21+', area: 'Basni',
    created_at: '2026-10-01T00:00:00Z', archived: false, visit_count: 3, site_visit_count: 3, inbound_count: 0,
    awaiting_site_visit: false, last_visit_at: null, last_visited_by: 'Dhruv', days_since_visit: null,
  }
  const csv = vendorsCsv([row])
  test('starts with a BOM and uses CRLF', () => {
    assert.ok(csv.startsWith('﻿'))
    assert.ok(csv.includes('\r\n'))
  })
  test('a formula typed as a company name cannot run in Excel', () => {
    assert.ok(!csv.split('\r\n')[1].startsWith('=cmd'))
  })
  test('the area is a column of its own', () => {
    assert.ok(csv.split('\r\n')[0].includes('Area'))
    assert.ok(csv.includes('Basni'))
  })
  test('labels, not slugs', () => {
    assert.ok(csv.includes('Approved'))
    assert.ok(csv.includes('Raw manufacturing, Only finishing'))
  })
  test('a potential vendor with no number exports an empty cell, not a crash', () => {
    const out = vendorsCsv([{ ...row, phone: null, contact_name: null, status: 'potential', product_focus: null, team_size: null, area: null }])
    assert.ok(out.includes('Potential'))
  })
})

describe('vocabularies match the database CHECKs', () => {
  test('capabilities and product types', () => {
    assert.deepEqual(CAPABILITIES.map(o => o.value).sort(), ['finished_pieces', 'finishing_only', 'raw_pieces'])
    for (const c of [...PRODUCT_FOCUS, ...TEAM_SIZES]) assert.ok(MIGRATION.includes(`'${c.value}'`), `${c.value} is in the migration`)
  })
  test('stages, kinds, purposes and outcomes', () => {
    for (const o of [...VENDOR_STATUSES, ...VISIT_KINDS, ...VISIT_OUTCOMES]) {
      assert.ok(MIGRATION.includes(`'${o.value}'`), `${o.value} is in the migration`)
    }
  })
  test('the pre-visit stages are exactly the two the database relaxes', () => {
    assert.deepEqual([...PRE_VISIT_STATUSES], ['potential', 'contacted'])
    assert.ok(/status in \('potential', 'contacted'\)\s+or \(contact_name is not null/.test(MIGRATION))
  })
  test('labels fall back to the raw value', () => {
    assert.equal(labelOf(VENDOR_STATUSES, 'approved'), 'Approved')
    assert.equal(labelOf(VENDOR_STATUSES, 'mystery'), 'mystery')
    assert.equal(labelsOf(CAPABILITIES, ['raw_pieces', 'finishing_only']), 'Raw manufacturing, Only finishing')
  })
})

describe('the migration keeps its promises', () => {
  test('every function that writes is revoked from anon', () => {
    for (const fn of ['save_vendor', 'log_vendor_visit', 'set_vendor_status', 'set_vendor_past_entries_until', 'archive_vendor', 'restore_vendor']) {
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon;`).test(MIGRATION), `${fn} revoked from anon`)
    }
    assert.ok(!/create policy [a-z_]+ on public\.vendor[a-z_]*\s+for (insert|update|delete)/.test(MIGRATION), 'no write policy on the tables')
  })
  test('the browser roles cannot write the tables or read the settings', () => {
    assert.ok(/revoke all on public\.vendors, public\.vendor_visits, public\.vendor_visit_photos from anon, authenticated, public;/.test(MIGRATION))
    assert.ok(/revoke all on public\.vendor_settings from anon, authenticated, public;/.test(MIGRATION))
  })
  test('visits are append-only and the bucket is private', () => {
    assert.ok(MIGRATION.includes('vendor_visits_no_change'))
    assert.ok(MIGRATION.includes("array['image/jpeg']"))
    assert.ok(/values \('vendor-visit-photos', 'vendor-visit-photos', false,/.test(MIGRATION))
  })
  test('only a live site visit can carry a location; everything else is "not applicable"', () => {
    assert.ok(/vendor_visits_proof_rules/.test(MIGRATION))
    assert.ok(/location_source = 'not_applicable'/.test(MIGRATION))
  })
  test('nobody is granted the module by default', () => {
    assert.ok(!/department_permissions/.test(MIGRATION.replace(/--.*$/gm, '')), 'no department rule')
    assert.ok(/select pm\.id, pa\.id, false/.test(MIGRATION), 'default_allowed is false')
  })
})

describe('the access-levels migration (20270429000000)', () => {
  const LEVELS = readFileSync('supabase/migrations/20270429000000_vendor_access_levels.sql', 'utf8')
  const code = LEVELS.replace(/--.*$/gm, '')

  test('registers exactly the five new actions, deny-by-default, and Admin holds them', () => {
    assert.ok(/pa\.action_key in \('create','edit','approve','export','view_all'\)/.test(code))
    assert.ok(/select pm\.id, pa\.id, false/.test(code), 'default_allowed is false')
    assert.ok(/select 'admin', mpa\.module_id, mpa\.action_id, true/.test(code))
  })
  test('nobody loses what they do today: explicit view holders also get create and edit, and nothing stronger', () => {
    assert.ok(/pa\.action_key in \('create', 'edit'\)/.test(code))
    assert.ok(/pv\.action_key = 'view'/.test(code))
    assert.ok(/this migration must not hand out approve, export or view_all/.test(code))
  })
  test('every write function checks the level; the helpers are not callable from the browser', () => {
    assert.ok(/perform public\.vendors_require\(case when p_vendor_id is null then 'create' else 'edit' end\)/.test(code), 'save_vendor')
    assert.ok(/perform public\.vendors_require\('create'\)/.test(code), 'log_vendor_visit')
    assert.ok(/perform public\.vendors_require\('edit'\)/.test(code), 'set_vendor_status')
    assert.ok(/revoke all on function public\.vendors_can\(text\) from public, anon, authenticated;/.test(code))
    assert.ok(/revoke all on function public\.vendors_require\(text\) from public, anon, authenticated;/.test(code))
  })
  test('Visit Activity opens to Admin, approve or view_all; deciding follows approve', () => {
    assert.ok(/not \(v_admin or public\.vendors_can\('view_all'\)\)/.test(code))
    assert.ok(/p_is_admin := public\.vendors_can\('approve'\)/.test(code))
  })
  test('the screens learn what they may show from vendors_my_access, with a grant for signed-in users only', () => {
    for (const k of ['can_create', 'can_edit', 'can_export', 'can_see_activity']) assert.ok(code.includes("'" + k + "'"), k)
    assert.ok(/grant execute on function public\.vendors_my_access\(\) to authenticated;/.test(code))
  })
})

describe('the area-and-filters migration (20270427000000)', () => {
  const AREA = readFileSync('supabase/migrations/20270427000000_vendor_area_and_filters.sql', 'utf8')
  const code = AREA.replace(/--.*$/gm, '')
  test('adds the area column and nothing else to the table', () => {
    assert.ok(/alter table public\.vendors\s+add column if not exists area text check/.test(code))
    assert.ok(!/drop /.test(code), 'it removes nothing')
  })
  test('re-issues exactly the three functions it changes, each with its grant and no anon access', () => {
    for (const fn of ['save_vendor', 'vendor_list', 'get_vendor']) {
      assert.ok(code.includes(`create or replace function public.${fn}(`), `${fn} is re-issued`)
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon;`).test(code), `${fn} revoked from anon`)
      assert.ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`).test(code), `${fn} granted`)
    }
    assert.equal((code.match(/create or replace function/g) ?? []).length, 3)
  })
  test('filters on team size and area, and returns the areas in use', () => {
    assert.ok(code.includes("p_filter -> 'team_sizes'") && code.includes("p_filter -> 'areas'"))
    assert.ok(code.includes("'areas', coalesce("))
  })
  test('an area keeps one spelling (an existing one is reused, ignoring case)', () => {
    assert.ok(/lower\(x\.area\) = lower\(v_area\)/.test(code))
  })
})
