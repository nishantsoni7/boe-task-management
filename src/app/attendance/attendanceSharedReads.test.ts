// THE ATTENDANCE PAGES REUSE THE GUARD'S PROFILE ROW (2026-11-15, page speed part 10). The guard reads the shared
// profile (it carries id, role and team) through callerProfile, and each page under it takes the same row from the
// cache instead of a 20-column users read of its own. Run with: npx tsx --test src/app/attendance/attendanceSharedReads.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const DIR = join(ROOT, 'src', 'app', 'attendance')
const code = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

function pages(dir = DIR, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) pages(p, out)
    else if (n === 'page.tsx') out.push(p)
  }
  return out
}

describe('the Attendance guard and pages share one profile read', () => {
  test('the guard reads the shared profile, and still decides on the same three fields', () => {
    const guard = code(join(DIR, 'layout.tsx'))
    assert.match(guard, /callerProfile\(qc, session\.user\.id\)/)
    assert.equal(/from\('users'\)/.test(guard), false, 'no users read of its own')
    assert.match(guard, /resolveManagementAccess\('attendance', mod, profile, false\)/)
  })

  test('no Attendance page reads the full profile row itself; those that need it take the shared one', () => {
    const all = pages()
    assert.ok(all.length >= 13, `found ${all.length} pages`)
    for (const p of all) {
      const src = code(p)
      const name = relative(ROOT, p).split(sep).join('/')
      assert.equal(/USER_PROFILE_COLUMNS/.test(src), false, `${name} reads the 20-column row itself`)
    }
    const sharing = all.filter(p => /callerProfile\(qc, session\.user\.id\)/.test(code(p)))
    assert.ok(sharing.length >= 13, `${sharing.length} pages take the shared row`)
  })
})
