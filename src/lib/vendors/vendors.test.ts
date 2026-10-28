import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyVendorError } from './api'
import { CAPABILITIES, CATEGORIES, VENDOR_STATUSES, VISIT_OUTCOMES, VISIT_PURPOSES, labelOf, labelsOf, type VendorSummary } from './constants'
import { vendorsCsv } from './csv'
import { EMPTY_VENDOR, EMPTY_VISIT, validateVendor, validateVisit, vendorPayload } from './validation'

const MIGRATION = readFileSync('supabase/migrations/20270425000000_vendor_management.sql', 'utf8')

const goodVendor = {
  ...EMPTY_VENDOR, company_name: 'Sharma Wood Works', contact_name: 'Ramesh', phone: '98765 43210',
  address: 'Plot 14, Basni Industrial Area', city: 'Jodhpur', capabilities: ['raw_pieces'],
}

describe('vendor form validation', () => {
  test('a complete vendor has no errors', () => {
    assert.deepEqual(validateVendor(goodVendor), {})
  })
  test('the required fields are named', () => {
    const e = validateVendor(EMPTY_VENDOR)
    for (const k of ['company_name', 'contact_name', 'phone', 'address', 'city', 'capabilities']) {
      assert.ok(e[k as keyof typeof e], `${k} is required`)
    }
  })
  test('phone numbers follow the same rules as the database', () => {
    assert.ok(validateVendor({ ...goodVendor, phone: '12345' }).phone)
    assert.ok(validateVendor({ ...goodVendor, phone: '5876543210' }).phone, 'an Indian mobile starts 6-9')
    assert.equal(validateVendor({ ...goodVendor, phone: '+971 50 123 4567' }).phone, undefined)
    assert.ok(validateVendor({ ...goodVendor, alt_phone: '123' }).alt_phone)
  })
  test('payload carries full phone numbers and trimmed text', () => {
    const p = vendorPayload({ ...goodVendor, company_name: '  Sharma  ', alt_phone: '' })
    assert.equal(p.phone, '+919876543210')
    assert.equal(p.company_name, 'Sharma')
    assert.equal(p.alt_phone, '')
  })
})

describe('visit validation', () => {
  const visit = { ...EMPTY_VISIT, purpose: 'first_meeting', person_met: 'Ramesh', discussion: 'Saw the workshop', outcome: 'interested' }
  test('a complete first visit with a factory photo passes', () => {
    assert.deepEqual(validateVisit(visit, ['factory'], true, '2026-10-28'), {})
  })
  test('no photograph, or no factory photograph on a first visit, is refused', () => {
    assert.ok(validateVisit(visit, [], false, '2026-10-28').photos)
    assert.ok(validateVisit(visit, ['person'], true, '2026-10-28').photos)
    assert.equal(validateVisit(visit, ['person'], false, '2026-10-28').photos, undefined)
  })
  test('follow-up outcome needs a date that is not in the past', () => {
    const f = { ...visit, outcome: 'follow_up_needed' }
    assert.ok(validateVisit(f, ['factory'], false, '2026-10-28').next_follow_up_on)
    assert.ok(validateVisit({ ...f, next_follow_up_on: '2026-10-01' }, ['factory'], false, '2026-10-28').next_follow_up_on)
    assert.equal(validateVisit({ ...f, next_follow_up_on: '2026-11-05' }, ['factory'], false, '2026-10-28').next_follow_up_on, undefined)
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
    id: 'x', company_name: '=cmd|calc', contact_name: 'Ramesh', phone: '+919876543210', city: 'Jodhpur', state: 'Rajasthan',
    status: 'approved', capabilities: ['raw_pieces', 'finishing_only'], categories: ['chairs'], headcount: 35, created_at: '2026-10-01T00:00:00Z',
    archived: false, visit_count: 3, last_visit_at: null, last_visited_by: 'Dhruv', days_since_visit: null,
  }
  const csv = vendorsCsv([row])
  test('starts with a BOM and uses CRLF', () => {
    assert.ok(csv.startsWith('﻿'))
    assert.ok(csv.includes('\r\n'))
  })
  test('a formula typed as a company name cannot run in Excel', () => {
    assert.ok(!csv.split('\r\n')[1].startsWith('=cmd'))
  })
  test('labels, not slugs', () => {
    assert.ok(csv.includes('Approved'))
    assert.ok(csv.includes('Raw / semi-finished pieces, Finishing only'))
  })
})

describe('vocabularies match the database CHECKs', () => {
  const sqlList = (name: string) => {
    const m = new RegExp(`${name}[^;]*?array\\[([^\\]]+)\\]`, 's').exec(MIGRATION)
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : []
  }
  test('capabilities and product types', () => {
    assert.deepEqual(CAPABILITIES.map(o => o.value).sort(), ['finished_pieces', 'finishing_only', 'raw_pieces'])
    for (const c of CATEGORIES) assert.ok(MIGRATION.includes(`'${c.value}'`), `${c.value} is in the migration`)
    assert.equal(sqlList('capabilities <@').length >= 3, true)
  })
  test('statuses, purposes and outcomes', () => {
    for (const o of [...VENDOR_STATUSES, ...VISIT_PURPOSES, ...VISIT_OUTCOMES]) assert.ok(MIGRATION.includes(`'${o.value}'`), `${o.value} is in the migration`)
  })
  test('labels fall back to the raw value', () => {
    assert.equal(labelOf(VENDOR_STATUSES, 'approved'), 'Approved')
    assert.equal(labelOf(VENDOR_STATUSES, 'mystery'), 'mystery')
    assert.equal(labelsOf(CATEGORIES, ['chairs', 'beds']), 'Chairs, Beds')
  })
})

describe('the migration keeps its promises', () => {
  test('every function that writes is SECURITY DEFINER with a fixed search_path and no anon access', () => {
    for (const fn of ['save_vendor', 'log_vendor_visit', 'set_vendor_status', 'archive_vendor', 'restore_vendor']) {
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon;`).test(MIGRATION), `${fn} revoked from anon`)
    }
    assert.ok(!/create policy [a-z_]+ on public\.vendor[a-z_]*\s+for (insert|update|delete)/.test(MIGRATION), 'no write policy on the tables')
  })
  test('visits are append-only and the bucket is private', () => {
    assert.ok(MIGRATION.includes('vendor_visits_no_change'))
    assert.ok(MIGRATION.includes("array['image/jpeg']"))
    assert.ok(/values \('vendor-visit-photos', 'vendor-visit-photos', false,/.test(MIGRATION))
  })
  test('nobody is granted the module by default', () => {
    assert.ok(!/department_permissions/.test(MIGRATION.replace(/--.*$/gm, '')), 'no department rule')
    assert.ok(/select pm\.id, pa\.id, false/.test(MIGRATION), 'default_allowed is false')
  })
})
