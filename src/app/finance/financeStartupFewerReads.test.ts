// THE FINANCE LIST'S FIRST BURST OF READS (2026-10-22).
//
// Measured on the live site: a request that waits beside others finishes about 70 ms later for each
// one of them (three at once end near 370 ms, eleven near 1,000 ms). The Finance list opened with
// eight reads at once (profile, two permission reads, the rows, four badge counts). It now opens with
// three: the profile, ONE permissions read for every module, and the rows. The four head-only badge
// counts follow once the page has drawn. None of this touches who may do what: capabilities are still
// resolved by the database on every load and still fail closed to none.
//
// Run with: npx tsx --test "src/app/finance/financeStartupFewerReads.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE = readFileSync(join(__dirname, 'page.tsx'), 'utf8').replace(/\r/g, '')
const INIT = PAGE.slice(PAGE.indexOf('const cutoffIso = archiveCutoffIso(Date.now())\n      setCutoffMs'), PAGE.indexOf('void loadCounts(cutoffIso)') + 40)

describe('the first group of reads', () => {
  test('is the profile, one permissions read for all modules, and the rows: nothing else', () => {
    assert.ok(INIT.length > 400, 'the startup block was found')
    assert.equal((INIT.match(/getEffectivePermissionsForUser\(/g) ?? []).length, 1)
    assert.equal(/getEffectivePermissions\(/.test(INIT), false, 'no per-module permission read is left in the group')
    assert.equal((INIT.match(/loadRequests\(cutoffIso\)/g) ?? []).length, 1)
    assert.equal(/reload\(\)|loadCounts\(cutoffIso\),/.test(INIT.slice(0, INIT.indexOf('setPageLoading(false)'))), false, 'the badge counts are not in the group')
  })

  test('the badge counts are read after the page has drawn, against the same cutoff', () => {
    assert.ok(INIT.indexOf('setPageLoading(false)') < INIT.indexOf('void loadCounts(cutoffIso)'))
    assert.match(INIT, /setCutoffMs\(Date\.parse\(cutoffIso\)\)/)
  })

  test('both modules are still taken from the database\'s answer and fail closed', () => {
    assert.match(INIT, /\.catch\(\(\) => new Map<string, EffectivePermission\[\]>\(\)\)/)
    assert.match(INIT, /permsByModule\.get\('finance'\) \?\? \[\]/)
    assert.match(INIT, /permsByModule\.get\('orders'\) \?\? \[\]/)
    assert.match(INIT, /deriveFinanceCapabilities\(me\?\.role, financePerms\)/)
  })

  test('a search or tab change still reloads rows and counts together', () => {
    assert.match(PAGE, /const reload = async \(\) => \{[\s\S]*?await Promise\.all\(\[loadRequests\(cutoffIso\), loadCounts\(cutoffIso\)\]\)/)
  })
})
