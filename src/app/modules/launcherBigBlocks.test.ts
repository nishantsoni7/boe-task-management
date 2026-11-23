/**
 * The launcher's big blocks and the count on every tile (owner, 2026-11-23).
 *
 * Two halves. The first EXECUTES the pure rules (src/lib/modules/moduleOrder.ts):
 * what a stored choice is, how the cards split into big and rest, the cap of four,
 * and how edit mode carries the choice beside the order. The second reads the
 * page and the migration as text, because the repository has no DOM harness for a
 * client page of this size (the same reason moduleCardSurface.test.ts reads it).
 *
 * Run:
 *   npx tsx --test src/app/modules/launcherBigBlocks.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_BIG_MODULE_KEYS,
  IDLE_MODULE_ORDER_EDIT,
  MAX_BIG_MODULES,
  moduleOrderEditReducer,
  moduleOrderKeys,
  NO_MODULE_PREFERENCE,
  normalizeStoredBigModules,
  sameBigModules,
  splitBigModules,
  toggleBigModuleKey,
  toModulePreference,
} from '@/lib/modules/moduleOrder'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const PAGE = read('src/app/modules/page.tsx')
const HOOK = read('src/hooks/queries/useModuleOrder.ts')
const MIGRATION = read('supabase/migrations/20270821000000_launcher_big_module_keys.sql')

const card = (key: string) => ({ key })
const CARDS = ['tasks', 'orders', 'samples', 'finance', 'sales', 'meetings', 'seo'].map(card)

describe('the stored choice', () => {
  test('four is the cap, and the default is Task, Order, Finance, Sales', () => {
    assert.equal(MAX_BIG_MODULES, 4)
    assert.deepEqual([...DEFAULT_BIG_MODULE_KEYS], ['tasks', 'orders', 'finance', 'sales'])
  })

  test('null, a non-list or rubbish is "never chosen"; an empty list is a real choice', () => {
    for (const nothing of [null, undefined, 'tasks', 7, {}]) assert.equal(normalizeStoredBigModules(nothing), null)
    assert.deepEqual(normalizeStoredBigModules([]), [], 'no big blocks at all is an answer')
    assert.equal(normalizeStoredBigModules([7, null, 'Tasks', '']), null, 'a non-empty list with nothing usable is rubbish')
  })

  test('duplicates collapse, bad entries drop, and it stops at four', () => {
    assert.deepEqual(normalizeStoredBigModules(['sales', 7, 'sales', 'Bad Key', 'tasks']), ['sales', 'tasks'])
    assert.deepEqual(normalizeStoredBigModules(['a', 'b', 'c', 'd', 'e', 'f']), ['a', 'b', 'c', 'd'])
  })

  test('a copy saved on the device before the big blocks existed is a bare list, and is still read', () => {
    assert.deepEqual(toModulePreference(['finance', 'tasks']), { order: ['finance', 'tasks'], big: null })
    assert.deepEqual(toModulePreference({ order: ['tasks'], big: ['tasks', 'sales'] }), { order: ['tasks'], big: ['tasks', 'sales'] })
    assert.deepEqual(toModulePreference({ order: null, big: [] }), { order: null, big: [] })
    for (const nothing of [null, undefined, 'x', 3]) assert.deepEqual(toModulePreference(nothing), NO_MODULE_PREFERENCE)
  })
})

describe('splitting the cards into big blocks and the rest', () => {
  test('every card lands in exactly one section, in the order given', () => {
    const { big, rest } = splitBigModules(CARDS, DEFAULT_BIG_MODULE_KEYS)
    assert.deepEqual(moduleOrderKeys(big), ['tasks', 'orders', 'finance', 'sales'])
    assert.deepEqual(moduleOrderKeys(rest), ['samples', 'meetings', 'seo'])
    assert.deepEqual([...moduleOrderKeys(big), ...moduleOrderKeys(rest)].sort(), moduleOrderKeys(CARDS).sort())
  })

  test('a chosen key with no card selects nothing: somebody without Sales has three', () => {
    const noSales = CARDS.filter(c => c.key !== 'sales')
    const { big, rest } = splitBigModules(noSales, DEFAULT_BIG_MODULE_KEYS)
    assert.deepEqual(moduleOrderKeys(big), ['tasks', 'orders', 'finance'])
    assert.equal(rest.length, noSales.length - 3)
  })

  test('a choice naming more than four loses no card: the fifth stays among the rest', () => {
    const { big, rest } = splitBigModules(CARDS, ['tasks', 'orders', 'samples', 'finance', 'sales'])
    assert.equal(big.length, MAX_BIG_MODULES)
    assert.ok(moduleOrderKeys(rest).includes('sales'))
    assert.equal(big.length + rest.length, CARDS.length)
  })

  test('the choice picks from the cards given and never reorders or mutates them', () => {
    const before = moduleOrderKeys(CARDS)
    const { big } = splitBigModules(CARDS, ['sales', 'tasks'])
    assert.deepEqual(moduleOrderKeys(big), ['tasks', 'sales'], 'the card order decides the sequence, not the order they were picked in')
    assert.deepEqual(moduleOrderKeys(CARDS), before)
  })

  test('no big blocks at all leaves every card in the rest', () => {
    const { big, rest } = splitBigModules(CARDS, [])
    assert.equal(big.length, 0)
    assert.equal(rest.length, CARDS.length)
  })
})

describe('choosing', () => {
  test('a key switches on and off', () => {
    assert.deepEqual(toggleBigModuleKey(['tasks'], 'sales'), ['tasks', 'sales'])
    assert.deepEqual(toggleBigModuleKey(['tasks', 'sales'], 'tasks'), ['sales'])
  })

  test('a fifth is refused, not swapped in: the list comes back unchanged', () => {
    const four = ['tasks', 'orders', 'finance', 'sales']
    assert.deepEqual(toggleBigModuleKey(four, 'seo'), four)
    assert.deepEqual(toggleBigModuleKey(four, 'sales'), ['tasks', 'orders', 'finance'], 'but taking one off always works')
  })

  test('the same set in a different order is the same choice', () => {
    assert.equal(sameBigModules(['tasks', 'sales'], ['sales', 'tasks']), true)
    assert.equal(sameBigModules(['tasks'], ['tasks', 'sales']), false)
    assert.equal(sameBigModules([], []), true)
  })
})

describe('edit mode carries the choice beside the order', () => {
  const open = () => moduleOrderEditReducer(IDLE_MODULE_ORDER_EDIT, {
    type: 'open', order: ['tasks', 'orders', 'finance', 'sales', 'seo'], big: ['tasks', 'sales'],
  })

  test('opening holds the current big blocks; cancel drops both', () => {
    const state = open()
    assert.deepEqual(state.workingBig, ['tasks', 'sales'])
    assert.deepEqual(moduleOrderEditReducer(state, { type: 'cancel' }), IDLE_MODULE_ORDER_EDIT)
  })

  test('toggling follows the cap, and does nothing when not editing', () => {
    assert.equal(moduleOrderEditReducer(IDLE_MODULE_ORDER_EDIT, { type: 'toggleBig', key: 'seo' }).workingBig, null)
    let state = open()
    state = moduleOrderEditReducer(state, { type: 'toggleBig', key: 'orders' })
    state = moduleOrderEditReducer(state, { type: 'toggleBig', key: 'finance' })
    assert.deepEqual(state.workingBig, ['tasks', 'sales', 'orders', 'finance'])
    assert.deepEqual(moduleOrderEditReducer(state, { type: 'toggleBig', key: 'seo' }).workingBig, state.workingBig, 'the fifth is refused')
  })

  test('a toggle during a save is ignored, like a move', () => {
    const saving = moduleOrderEditReducer(open(), { type: 'saveStart' })
    assert.equal(moduleOrderEditReducer(saving, { type: 'toggleBig', key: 'orders' }), saving)
  })

  test('a failed save keeps the choice; reset puts the default four back, still unsaved', () => {
    const failed = moduleOrderEditReducer(
      moduleOrderEditReducer(open(), { type: 'toggleBig', key: 'orders' }),
      { type: 'saveFailed', message: 'nope' },
    )
    assert.deepEqual(failed.workingBig, ['tasks', 'sales', 'orders'])
    const reset = moduleOrderEditReducer(failed, { type: 'reset', canonical: ['tasks', 'orders', 'finance', 'sales', 'seo'], big: ['tasks', 'orders', 'finance', 'sales'] })
    assert.deepEqual(reset.workingBig, ['tasks', 'orders', 'finance', 'sales'])
    assert.equal(reset.error, null)
    assert.deepEqual(moduleOrderEditReducer(failed, { type: 'reset', canonical: ['tasks'] }).workingBig, failed.workingBig,
      'a reset that names no big blocks leaves the choice as it was')
  })
})

describe('the page: a count on every tile that has one', () => {
  test('each module with a feed reads the SAME category its own sidebar reads', () => {
    for (const category of ['sales', 'asset', 'inventory', 'review', 'attendance_payroll']) {
      assert.ok(PAGE.includes(`useUnreadCountState('${category}'`), `the launcher reads the ${category} count`)
    }
  })

  test('a module this person cannot open issues no request', () => {
    assert.match(PAGE, /useUnreadCountState\('sales', mayOpenSales\)/)
    assert.match(PAGE, /useUnreadCountState\('asset', mayOpenAssets\)/)
    assert.match(PAGE, /useUnreadCountState\('inventory', mayOpenInventory\)/)
    assert.match(PAGE, /useUnreadCountState\('attendance_payroll', permsReady && \(canSeeAttendance \|\| canSeePayroll\)\)/)
    assert.match(PAGE, /const mayOpenSales\s+= permsReady && canOpenModule\('sales'\)/)
  })

  test('Review Workflow asks only for a verifier, whose feed it is; anybody else is told "No alerts"', () => {
    assert.match(PAGE, /const mayVerifyReviews = permsReady && deriveCustomerReviewCapabilities\([\s\S]*?\)\.canVerify/)
    assert.match(PAGE, /useUnreadCountState\('review', mayVerifyReviews\)/)
    assert.ok(PAGE.includes('notificationCount: mayVerifyReviews ? reviewCount.count : null'))
  })

  test('Quotations counts requests WAITING for the person, from the cache entry its own sidebar uses', () => {
    const api = read('src/lib/quotations/api.ts')
    assert.ok(api.includes("count: ['quotations', 'requests-count'] as const"), 'askKeys.count is the key the launcher repeats')
    assert.ok(PAGE.includes("const QUOTATION_WAITING_KEY = ['quotations', 'requests-count'] as const"))
    assert.ok(PAGE.includes("supabase.rpc('quotation_requests_count')"))
    assert.ok(PAGE.includes('notificationCount: quotationWaiting.data'))
    assert.ok(PAGE.includes("countLabel: 'waiting' as const"))
  })

  test('the Quotations count is the signed-in person\'s, so it is not asked while previewing somebody else', () => {
    assert.match(PAGE, /enabled: mayOpenQuotations && !viewMode/)
  })

  test('a failed Sample Tracking count is "not known", never "No alerts"', () => {
    assert.ok(PAGE.includes('notificationCount: counts.sample ?? undefined'))
  })

  test('only a module with no notifications at all passes null', () => {
    // One entry per `key: '<name>',` up to the next one, so a null in a later card cannot be read as this one's.
    const entries = PAGE.split(/\n\s+key: '/).slice(1)
      .map(text => ({ name: text.slice(0, text.indexOf("'")), text }))
    const names = entries.map(e => e.name)
    for (const withFeed of ['tasks', 'orders', 'finance', 'samples', 'sales', 'assets', 'inventory', 'quotations', 'attendance_payroll']) {
      const entry = entries.find(e => e.name === withFeed)
      assert.ok(entry, `${withFeed} has a card`)
      assert.equal(/notificationCount: null/.test(entry.text.slice(0, entry.text.indexOf("\n    }]"))), false,
        `${withFeed} has a count and must not say "No alerts"`)
    }
    for (const noFeed of ['showroom', 'members', 'meetings', 'image_editor', 'exhibition_leads', 'vendors', 'marketing', 'pricing', 'seo', 'control_center']) {
      assert.ok(names.includes(noFeed), `${noFeed} has a card`)
    }
  })

  test('the big blocks are chosen in Edit order, and Reset puts back the default four', () => {
    assert.ok(PAGE.includes("dispatchOrderEdit({ type: 'toggleBig', key: mod.key })"))
    assert.ok(PAGE.includes('big: moduleOrderKeys(essentialModules) })'), 'edit mode opens on the cards that are big right now')
    assert.ok(PAGE.includes('big: moduleOrderKeys(splitBigModules(canonicalModules, DEFAULT_BIG_MODULE_KEYS).big),'))
  })

  test('choosing different big blocks makes Save available even if no card moved', () => {
    assert.match(PAGE, /const bigIsDirty =\s*editingOrder &&\s*!sameBigModules\(/)
    assert.match(PAGE, /\(bigIsDirty \|\| !moduleOrderEquals\(/)
  })
})

describe('the hook: one row, one read, and a deploy that cannot lose the order', () => {
  test('it reads both columns, and falls back to the order alone if the new column is not there yet', () => {
    assert.ok(HOOK.includes("row('module_keys, big_module_keys')"))
    assert.ok(HOOK.includes("await row('module_keys')"))
    assert.ok(HOOK.includes('select: toModulePreference'), 'an older saved copy (a bare list) is still read')
  })

  test('the big blocks are written ONLY when they changed', () => {
    assert.ok(HOOK.includes('...(big === undefined ? {} : { big_module_keys: [...big] })'))
  })

  test('the save puts the order into the cache and keeps the cached big blocks when none were sent', () => {
    assert.ok(HOOK.includes('big: big === undefined ? toModulePreference(previous).big : [...big]'))
  })
})

describe('the migration', () => {
  const sql = MIGRATION.replace(/--.*$/gm, '')

  test('adds one nullable text[] column, with no default (null = never chosen)', () => {
    assert.match(sql, /add column if not exists big_module_keys text\[\];/)
    assert.equal(/big_module_keys text\[\]\s*(not null|default)/i.test(sql), false)
  })

  test('caps the list at four and reuses the shared shape validator', () => {
    assert.match(sql, /add constraint user_module_order_big_keys_valid\s*check \(\s*big_module_keys is null\s*or \(\s*public\.user_module_order_keys_valid\(big_module_keys\)\s*and coalesce\(array_length\(big_module_keys, 1\), 0\) <= 4\s*\)\s*\);/)
  })

  test('touches no policy, grant, trigger or function, and writes no row', () => {
    for (const forbidden of [/create policy/i, /drop policy/i, /^\s*grant\b/im, /^\s*revoke\b/im, /create (or replace )?function/i, /create trigger/i, /\binsert into\b/i, /\bupdate public\./i, /\bdelete from\b/i, /\bdrop table\b/i]) {
      assert.equal(forbidden.test(sql), false, `the migration must not contain ${forbidden}`)
    }
  })

  test('asserts, and the assertions run read-only', () => {
    assert.match(sql, /do \$\$/)
    assert.ok(sql.includes("has_column_privilege('anon'"))
    assert.ok(sql.includes("has_table_privilege('authenticated', 'public.user_module_order', 'DELETE')"))
  })
})
