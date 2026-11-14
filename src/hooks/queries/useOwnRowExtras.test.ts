// ONE READ OF THE SIGNED-IN ROW'S FOUR EXTRA COLUMNS (2026-11-14, page speed part 6): the Modules page's
// attendance rule (payroll_active, is_deleted) and the account menu's designation line (position,
// designation_level) were two requests for the same row, one in each step of the page. They share one
// cache entry now. Run with: npx tsx --test src/hooks/queries/useOwnRowExtras.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OWN_ROW_EXTRA_COLUMNS, ownRowExtrasKey } from './useOwnRowExtras'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

const root = join(__dirname, '..', '..', '..')
// Line comments first, so a comment that mentions a path ending in "/*" cannot open a block comment.
const src = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('the four columns', () => {
  test('are all columns `authenticated` may select (a private one would be a 42501 on every page)', () => {
    const selectable = USER_PROFILE_COLUMNS.split(',').map(c => c.trim())
    for (const column of OWN_ROW_EXTRA_COLUMNS.split(',').map(c => c.trim())) {
      assert.ok(selectable.includes(column), `${column} is in USER_PROFILE_COLUMNS`)
    }
    assert.equal(OWN_ROW_EXTRA_COLUMNS.split(',').length, 4)
  })

  test('the cache entry is per person', () => {
    assert.deepEqual(ownRowExtrasKey('u1'), ['own-row-extras', 'u1'])
    assert.notDeepEqual(ownRowExtrasKey('u1'), ownRowExtrasKey('u2'))
  })

  test('the SHARED profile still does not carry them: the permission code never reads designation_level', () => {
    for (const file of ['src/hooks/queries/usePermissionContext.ts', 'src/hooks/queries/useProfile.ts']) {
      const columns = src(file).match(/const PROFILE_COLUMNS = '([^']*)'/)?.[1] ?? ''
      assert.ok(columns.length > 0, file)
      for (const forbidden of ['designation_level', 'position', 'payroll_active']) {
        assert.equal(columns.includes(forbidden), false, `${file} must not select ${forbidden}`)
      }
    }
  })
})

describe('who asks', () => {
  test('the Modules page and the account menu read it through the hook, with no users read of their own', () => {
    const page = src('src/app/modules/page.tsx')
    assert.match(page, /useOwnRowExtras\(userId, \{ enabled: !!userId && !viewMode \}\)/)
    assert.equal(/payroll-participation/.test(page), false)

    const menu = src('src/components/layout/AdminViewModeControls.tsx')
    assert.match(menu, /useOwnRowExtras\(profile\.id, \{ staleTime: 5 \* 60 \* 1000 \}\)/)
    assert.equal(/from\('users'\)/.test(menu), false, 'the account menu makes no request of its own')
    assert.equal(/sidebar-designation/.test(menu), false)
  })

  test('each caller keeps its own freshness: 30 s for the attendance rule, 5 minutes for the menu', () => {
    const hook = src('src/hooks/queries/useOwnRowExtras.ts')
    assert.match(hook, /staleTime = PERMISSION_STALE_MS/, 'the default is the launcher\'s 30 s')
    assert.match(hook, /^\s*staleTime,$/m, 'the caller\'s value is what the query uses')
  })
})
