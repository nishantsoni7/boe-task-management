import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lockWarningText } from './lockWarning'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('the lock confirmation names unresolved attendance salary items', () => {
  test('nothing open → nothing added; the existing confirmation is unchanged', () => {
    assert.equal(lockWarningText({ totals: { unresolved: 0, conflicts: 0 }, employees: [] }, false), '')
  })

  test('open items and draft conflicts are counted, named and must be accepted', () => {
    const text = lockWarningText({
      totals: { unresolved: 3, conflicts: 1 },
      employees: [{ full_name: 'Asha', unresolved: 2, conflicts: 1 }, { full_name: 'Bala', unresolved: 1, conflicts: 0 }],
    }, false)
    assert.match(text, /3 unresolved salary items, of which 1 disagree with this draft/)
    assert.match(text, /Asha: 2 unresolved, 1 disagree with the draft/)
    assert.match(text, /Press OK only if you accept locking with these open/)
  })

  test('a failed check is said out loud, never read as "nothing open"', () => {
    assert.match(lockWarningText(null, true), /could not be checked/)
  })

  test('both lock buttons prepend it; the lock API itself is unchanged', () => {
    for (const p of ['src/app/payroll/page.tsx', 'src/app/payroll/results/[periodId]/page.tsx']) {
      const src = read(p)
      assert.ok(src.includes('fetchLockWarning('), p)
      assert.ok(/confirm\(\s*(attendanceWarning \+|`\$\{attendanceWarning\})/.test(src), `${p} puts the warning in the confirmation`)
    }
    assert.equal(/attendance_requests|attendance_day_reviews|lockWarning/.test(read('src/app/api/payroll/lock/route.ts')), false)
  })
})
