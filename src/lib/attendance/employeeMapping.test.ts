/**
 * Manual employee matching for attendance imports.
 *
 *   npx tsx --test src/lib/attendance/employeeMapping.test.ts
 *
 * The whole reason this logic is a module rather than two inline blocks is that
 * the preview and the import must resolve every code the same way. The cases
 * below therefore split into two groups: what a valid selection resolves to, and
 * which selections are refused outright. A refusal matters more than it looks —
 * every one of them is a way that one upload could write a person's attendance
 * onto somebody else, or onto the same person twice.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseManualMappings,
  resolveEmployeeMapping,
  type MappableBlock,
  type SelectableUser,
} from './employeeMapping'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const block = (empcode: string, name: string, days = 3): MappableBlock => ({
  empcode,
  name,
  days: Array<number>(days).fill(0),
})

const USERS: SelectableUser[] = [
  { id: 'u-asha',    full_name: 'Asha Rao' },
  { id: 'u-santosh', full_name: 'Santosh Kumar' },
  { id: 'u-ravi',    full_name: 'Ravi Nair' },
]

/** '0014' is Asha's device code; the others are not on any device. */
const FINGERPRINTS = new Map([['0014', { id: 'u-asha', name: 'Asha Rao' }]])

function resolve(blocks: MappableBlock[], manual: { excel_code: string; user_id: string }[] = []) {
  return resolveEmployeeMapping({
    blocks,
    fingerprintToUser: FINGERPRINTS,
    manualMappings: manual,
    selectableUsers: USERS,
  })
}

// ─── Automatic matching, unchanged ────────────────────────────────────────────

describe('automatic matching still decides everything it used to', () => {
  test('a device code that matches resolves without any manual input', () => {
    const r = resolve([block('0014', 'ASHA')])
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.mapping.resolved.get('0014'), { id: 'u-asha', name: 'Asha Rao', manual: false })
    assert.deepEqual(r.mapping.unmatched, [])
    assert.deepEqual(r.mapping.applied, [])
  })

  test('a code with no device match is reported unmatched, with its day count', () => {
    const r = resolve([block('S-1', 'SANTOSH', 24)])
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.mapping.resolved.size, 0)
    assert.deepEqual(r.mapping.unmatched, [{ excel_code: 'S-1', excel_name: 'SANTOSH', days: 24 }])
  })
})

// ─── Manual matching ──────────────────────────────────────────────────────────

describe('an admin naming the employee for an unmatched code', () => {
  test('the code resolves to the chosen employee and leaves the unmatched list', () => {
    const r = resolve(
      [block('0014', 'ASHA'), block('S-1', 'SANTOSH', 24)],
      [{ excel_code: 'S-1', user_id: 'u-santosh' }],
    )
    assert.equal(r.ok, true)
    if (!r.ok) return

    assert.deepEqual(r.mapping.resolved.get('S-1'), {
      id: 'u-santosh', name: 'Santosh Kumar', manual: true,
    })
    // The automatic match is untouched by the manual one.
    assert.deepEqual(r.mapping.resolved.get('0014'), { id: 'u-asha', name: 'Asha Rao', manual: false })
    assert.deepEqual(r.mapping.unmatched, [])
  })

  test('the applied list carries what the confirmation prompt has to state', () => {
    const r = resolve([block('S-1', 'SANTOSH', 24)], [{ excel_code: 'S-1', user_id: 'u-santosh' }])
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.mapping.applied, [{
      excel_code:    'S-1',
      excel_name:    'SANTOSH',
      user_id:       'u-santosh',
      employee_name: 'Santosh Kumar',
      days:          24,
    }])
  })

  test('two different unmatched codes may name two different employees', () => {
    const r = resolve(
      [block('S-1', 'SANTOSH'), block('S-2', 'RAVI')],
      [{ excel_code: 'S-1', user_id: 'u-santosh' }, { excel_code: 'S-2', user_id: 'u-ravi' }],
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.mapping.resolved.get('S-1')?.id, 'u-santosh')
    assert.equal(r.mapping.resolved.get('S-2')?.id, 'u-ravi')
    assert.deepEqual(r.mapping.unmatched, [])
  })

  test('resolving twice from the same inputs gives the same answer', () => {
    // This is the preview/import guarantee stated as a test: the routes differ in
    // what they do with the result, never in what the result is.
    const blocks = [block('0014', 'ASHA'), block('S-1', 'SANTOSH', 24)]
    const manual = [{ excel_code: 'S-1', user_id: 'u-santosh' }]

    const a = resolve(blocks, manual)
    const b = resolve(blocks, manual)
    assert.equal(a.ok && b.ok, true)
    if (!a.ok || !b.ok) return
    assert.deepEqual([...a.mapping.resolved.entries()], [...b.mapping.resolved.entries()])
    assert.deepEqual(a.mapping.unmatched, b.mapping.unmatched)
    assert.deepEqual(a.mapping.applied, b.mapping.applied)
  })
})

// ─── Refusals ─────────────────────────────────────────────────────────────────

describe('selections that are refused rather than partly honoured', () => {
  test('a code that is not in the file', () => {
    const r = resolve([block('S-1', 'SANTOSH')], [{ excel_code: 'S-9', user_id: 'u-santosh' }])
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /not in this file/)
  })

  test('overriding a code that already matched by fingerprint', () => {
    // Redirecting a matched employee's attendance onto a colleague is an
    // Employee Master edit, where it stays visible, not an upload-time choice.
    const r = resolve([block('0014', 'ASHA')], [{ excel_code: '0014', user_id: 'u-ravi' }])
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /already matches Asha Rao/)
  })

  test('an employee who does not exist', () => {
    const r = resolve([block('S-1', 'SANTOSH')], [{ excel_code: 'S-1', user_id: 'u-ghost' }])
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /was not found/)
  })

  test('the same code assigned twice', () => {
    const r = resolve(
      [block('S-1', 'SANTOSH')],
      [{ excel_code: 'S-1', user_id: 'u-santosh' }, { excel_code: 'S-1', user_id: 'u-ravi' }],
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /more than one employee/)
  })

  test('two codes pointing at one employee', () => {
    // Both blocks carry days for the same dates. They would be written and then
    // overwritten in an order nothing defines, and the report would claim both.
    const r = resolve(
      [block('S-1', 'SANTOSH'), block('S-2', 'S KUMAR')],
      [{ excel_code: 'S-1', user_id: 'u-santosh' }, { excel_code: 'S-2', user_id: 'u-santosh' }],
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /cannot receive two codes/)
  })

  test('a manual choice landing on someone a device code already matched', () => {
    const r = resolve(
      [block('0014', 'ASHA'), block('S-1', 'SANTOSH')],
      [{ excel_code: 'S-1', user_id: 'u-asha' }],
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /already being imported from code "0014"/)
  })
})

// ─── The wire format ──────────────────────────────────────────────────────────

describe('parseManualMappings — the optional form field', () => {
  test('absent means no manual matching, not a bad request', () => {
    for (const raw of [null, undefined, '']) {
      const r = parseManualMappings(raw)
      assert.equal(r.ok, true, String(raw))
      if (!r.ok) return
      assert.deepEqual(r.mappings, [])
    }
  })

  test('a well-formed list is trimmed and kept in order', () => {
    const r = parseManualMappings(JSON.stringify([
      { excel_code: ' S-1 ', user_id: ' u-santosh ' },
      { excel_code: 'S-2', user_id: 'u-ravi' },
    ]))
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.mappings, [
      { excel_code: 'S-1', user_id: 'u-santosh' },
      { excel_code: 'S-2', user_id: 'u-ravi' },
    ])
  })

  test('malformed input is refused outright, never partly honoured', () => {
    const bad: unknown[] = [
      '{not json',
      JSON.stringify({ excel_code: 'S-1', user_id: 'u-santosh' }),   // not a list
      JSON.stringify(['S-1']),                                        // not objects
      JSON.stringify([{ excel_code: 'S-1' }]),                        // no employee
      JSON.stringify([{ user_id: 'u-santosh' }]),                     // no code
      JSON.stringify([{ excel_code: '', user_id: 'u-santosh' }]),     // empty code
      JSON.stringify([{ excel_code: 'S-1', user_id: '' }]),           // empty employee
      JSON.stringify([{ excel_code: 'S-1', user_id: 42 }]),           // wrong type
      123,                                                            // not text
    ]
    for (const raw of bad) {
      assert.equal(parseManualMappings(raw).ok, false, String(raw))
    }
  })
})

// ─── Both routes must go through this module ──────────────────────────────────

describe('import and preview resolve employees through the shared module', () => {
  test('neither route matches employees by hand any more', async () => {
    const fs = await import('node:fs/promises')
    const sources = await Promise.all([
      fs.readFile('src/app/api/attendance/import/route.ts', 'utf8'),
      fs.readFile('src/app/api/attendance/preview/route.ts', 'utf8'),
    ])

    for (const [i, src] of sources.entries()) {
      const which = i === 0 ? 'import' : 'preview'
      assert.match(src, /from '@\/lib\/attendance\/employeeMapping'/, `${which} must import the shared resolver`)
      assert.match(src, /resolveEmployeeMapping\(/,                   `${which} must call the shared resolver`)
      assert.match(src, /parseManualMappings\(/,                      `${which} must validate the manual mappings field`)
      assert.match(src, /form\.get\('manualMappings'\)/,              `${which} must read the manual mappings field`)
    }
  })
})
