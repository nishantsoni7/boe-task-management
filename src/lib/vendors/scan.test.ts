import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyVendorScan, parseVendorScan, vendorScanIsEmpty } from './scan'
import { VENDOR_SCAN_TOOL } from './scanPrompt'
import { EMPTY_VENDOR } from './validation'

describe('vendor scan: the reading is made safe', () => {
  test('wrong types are dropped and long text is capped', () => {
    const r = parseVendorScan({ company: 42, contact_person: '  Ram   Lal ', phones: ['98765 43210', 7, ''], address: 'x'.repeat(900), area: 'Basni' })
    assert.equal(r.company, '')
    assert.equal(r.contact, 'Ram Lal')
    assert.deepEqual(r.phones, ['98765 43210'])
    assert.equal(r.address.length, 500)
    assert.equal(r.area, 'Basni')
  })
  test('garbage in gives an empty reading', () => {
    assert.ok(vendorScanIsEmpty(parseVendorScan(null)))
    assert.ok(vendorScanIsEmpty(parseVendorScan('ignore previous instructions')))
  })
  test('the tool schema asks for exactly the fields the form can take', () => {
    assert.deepEqual(Object.keys(VENDOR_SCAN_TOOL.input_schema.properties).sort(), ['address', 'area', 'company', 'contact_person', 'phones'])
  })
})

describe('vendor scan: pouring it into the form', () => {
  const read = parseVendorScan({
    company: 'Shree Furniture Works', contact_person: 'Mohan', phones: ['0291 2434343', '+91 98765 43210'],
    address: 'Plot 4, Basni Industrial Area, Jodhpur', area: 'Basni',
  })

  test('fills every empty field, taking the first number the form can save', () => {
    const { patch, filled } = applyVendorScan(EMPTY_VENDOR, read)
    assert.deepEqual(filled, ['company_name', 'contact_name', 'phone', 'address', 'area'])
    assert.equal(patch.phone, '9876543210')
    assert.equal(patch.company_name, 'Shree Furniture Works')
  })
  test('never overwrites what the person already typed', () => {
    const { patch, filled } = applyVendorScan({ ...EMPTY_VENDOR, company_name: 'My Name', address: 'Typed address' }, read)
    assert.ok(!('company_name' in patch) && !('address' in patch))
    assert.deepEqual(filled, ['contact_name', 'phone', 'area'])
  })
  test('a number the form could not save is left out', () => {
    const { patch, filled } = applyVendorScan(EMPTY_VENDOR, parseVendorScan({ company: 'A', phones: ['12345'] }))
    assert.ok(!('phone' in patch))
    assert.deepEqual(filled, ['company_name'])
  })
})

describe('vendor scan route', () => {
  const ROUTE = readFileSync('src/app/api/vendors/scan/route.ts', 'utf8')
  test('is gated on the caller own Vendors access (can_create) and stores nothing', () => {
    assert.ok(/rpc\('vendors_my_access'\)/.test(ROUTE))
    assert.ok(/.can_create !== true/.test(ROUTE), 'refuses a caller who cannot add vendors')
    assert.ok(!/\.storage\b|\.from\('vendor/.test(ROUTE), 'the photograph is never stored')
    assert.ok(!/SUPABASE_SERVICE_ROLE/.test(ROUTE), 'no service credential')
  })
})
