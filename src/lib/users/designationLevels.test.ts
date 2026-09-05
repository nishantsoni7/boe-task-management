/**
 * The organisational hierarchy, and the promise that it is ONLY that.
 *
 * Two halves. The first is ordinary unit testing of the vocabulary helpers. The
 * second is a repository check, and it is the one that matters: it fails the
 * build if `designation_level` ever appears in code that decides access. The
 * whole design rests on that separation — a level describes where somebody sits
 * in the company, and `users.role` plus the permission engine decide what the
 * software lets them do. A future edit that quietly wires the two together
 * would be a privilege-escalation change, and this is what makes it loud.
 *
 * Run:
 *   npx tsx --test src/lib/users/designationLevels.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  DESIGNATION_LEVELS, DESIGNATION_LEVEL_LABELS, RESTRICTED_DESIGNATION_LEVELS,
  isDesignationLevel, isRestrictedDesignationLevel,
  designationLevelLabel, departmentLabel, employeeSubtitle,
} from './designationLevels'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = 'supabase/migrations/20261106000000_employee_designation_level.sql'

// ── 1. The six rungs ────────────────────────────────────────────────────────

describe('the hierarchy', () => {
  test('is exactly the six rungs BOE asked for, most senior first', () => {
    assert.deepEqual([...DESIGNATION_LEVELS], [
      'super_admin', 'administrator', 'manager', 'executive', 'assistant', 'trainee',
    ])
    assert.deepEqual(DESIGNATION_LEVELS.map(l => DESIGNATION_LEVEL_LABELS[l]), [
      'Super Admin', 'Administrator', 'Manager', 'Executive', 'Assistant', 'Trainee',
    ])
  })

  test('the two administrative rungs are the restricted ones', () => {
    assert.deepEqual([...RESTRICTED_DESIGNATION_LEVELS], ['super_admin', 'administrator'])
    assert.equal(isRestrictedDesignationLevel('administrator'), true)
    assert.equal(isRestrictedDesignationLevel('manager'), false)
    assert.equal(isRestrictedDesignationLevel('nonsense'), false)
  })

  test('the stored keys are never the authorization role values', () => {
    // 'admin' | 'manager' | 'member' are users.role. 'manager' is the one word
    // both vocabularies use, and it is a coincidence of English, not a link:
    // storing 'manager' as a level writes designation_level, never role.
    for (const roleValue of ['admin', 'member']) {
      assert.equal(isDesignationLevel(roleValue), false, `${roleValue} is a system role, not a level`)
    }
  })

  test('an unset or unrecognised level has no label, rather than a made-up one', () => {
    assert.equal(designationLevelLabel(null), null)
    assert.equal(designationLevelLabel(undefined), null)
    assert.equal(designationLevelLabel(''), null)
    assert.equal(designationLevelLabel('vice_president'), null)
    assert.equal(designationLevelLabel('executive'), 'Executive')
  })
})

// ── 2. What an employee is shown ────────────────────────────────────────────

describe('the line under an employee’s name', () => {
  test('leads with their job title, qualified by department', () => {
    assert.equal(
      employeeSubtitle({ position: 'Sales Executive', designation_level: 'executive', team: 'sales' }),
      'Sales Executive · Sales',
    )
    assert.equal(
      employeeSubtitle({ position: 'Design Manager', designation_level: 'manager', team: 'design' }),
      'Design Manager · Design',
    )
  })

  test('falls back to the rung when no job title is recorded', () => {
    assert.equal(employeeSubtitle({ position: null, designation_level: 'trainee', team: 'production' }), 'Trainee · Production')
    assert.equal(employeeSubtitle({ position: '   ', designation_level: 'assistant', team: 'finance' }), 'Assistant · Finance')
  })

  test('with nothing recorded it is empty, so the caller renders no second line', () => {
    assert.equal(employeeSubtitle({ position: null, designation_level: null, team: null }), '')
    assert.equal(employeeSubtitle({ position: null, designation_level: null, team: 'sales' }), 'Sales')
  })

  test('IT CANNOT SHOW "member" — the technical role is not one of its inputs', () => {
    // The signature is the safeguard: there is no `role` to leak. Passing one
    // anyway changes nothing about the output.
    const withRole = { position: null, designation_level: null, team: 'sales', role: 'member' }
    assert.equal(employeeSubtitle(withRole), 'Sales')
    assert.equal(employeeSubtitle(withRole).includes('member'), false)
  })

  test('department keys read as words', () => {
    assert.equal(departmentLabel('sales'), 'Sales')
    assert.equal(departmentLabel('order_management'), 'Order Management')
    assert.equal(departmentLabel(null), null)
  })
})

// ── 3. The migration ────────────────────────────────────────────────────────

describe('the migration', () => {
  const sql = read(MIGRATION)

  test('adds one nullable column and constrains it to the six rungs', () => {
    assert.ok(/ADD COLUMN IF NOT EXISTS designation_level text/.test(sql))
    assert.equal(/NOT NULL/.test(sql), false, 'the column must be nullable — nothing was backfilled')
    for (const level of DESIGNATION_LEVELS) {
      assert.ok(sql.includes(`'${level}'`), `${level} must be allowed by the CHECK`)
    }
  })

  test('BACKFILLS NOTHING — no existing employee is assigned a rung by guesswork', () => {
    assert.equal(/^\s*UPDATE\s/im.test(sql), false, 'no UPDATE')
    assert.equal(/^\s*INSERT\s/im.test(sql), false, 'no INSERT')
  })

  test('grants the column to authenticated, or nobody could read their own level', () => {
    // 20260813000000 revoked table-level SELECT and hands back a named list, so
    // a new column is invisible until granted. Without this line every browser
    // query that names designation_level would fail with 42501.
    assert.ok(/GRANT SELECT \(designation_level\) ON public\.users TO authenticated/.test(sql))
    assert.equal(/GRANT (INSERT|UPDATE)/.test(sql), false, 'writes stay on the service role')
    assert.ok(read('src/lib/users/safeColumns.ts').includes("'designation_level'"))
  })

  test('touches public.users and nothing else — no policy, function or other table', () => {
    const altered = [...new Set([...sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map(m => m[1]))]
    assert.deepEqual(altered, ['users'])
    assert.equal(/CREATE POLICY|DROP POLICY|CREATE OR REPLACE FUNCTION|DROP TABLE|TRUNCATE/i.test(sql), false)
  })
})

// ── 4. THE SEPARATION, as a repository check ────────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
    }
  }
  walk(dir)
  return out
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

describe('a designation level grants nothing', () => {
  test('no authorization code reads the column', () => {
    // The files that decide access. If `designation_level` turns up in any of
    // them, somebody has made the organisational chart into a permission
    // system, which is exactly what this work was asked not to do.
    const AUTHORIZATION_SOURCES = [
      'src/lib/permissions',
      'src/lib/moduleAccess.ts',
      'src/lib/security',
      'src/components/layout/ModuleGuard.tsx',
      'src/hooks/queries/usePermissionContext.ts',
    ]
    const offenders: string[] = []
    for (const target of AUTHORIZATION_SOURCES) {
      const full = join(ROOT, target)
      const files = statSync(full).isDirectory() ? sourceFiles(full) : [full]
      for (const file of files) {
        if (/designation_level|designationLevel/.test(readFileSync(file, 'utf8'))) offenders.push(rel(file))
      }
    }
    assert.deepEqual(offenders, [], 'authorization must not read the organisational level')
  })

  test('no SQL migration lets a policy or resolver read it', () => {
    const dir = join(ROOT, 'supabase/migrations')
    const offenders = readdirSync(dir)
      .filter(f => f.endsWith('.sql') && !f.startsWith('20261106000000'))
      .filter(f => /designation_level/.test(readFileSync(join(dir, f), 'utf8')))
    assert.deepEqual(offenders, [], 'only the migration that creates the column may mention it')
  })

  test('users.role is still what the app checks for an administrator', () => {
    // A blunt liveness check on the thing this work promised not to disturb:
    // the role-based admin test is still all over the codebase, unchanged.
    const hits = sourceFiles(join(ROOT, 'src'))
      .filter(f => readFileSync(f, 'utf8').includes("role === 'admin'"))
    assert.ok(hits.length > 50, `expected the role check to remain widespread, saw ${hits.length}`)
  })
})
