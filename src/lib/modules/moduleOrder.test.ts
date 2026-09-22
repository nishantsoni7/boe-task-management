/**
 * PERSONAL MODULE-CARD ORDER — the ordering rules, the edit-mode transitions and
 * the two decisions a card and a handle make.
 *
 * WHAT THESE PIN, AND WHY EACH ONE MATTERS
 * ----------------------------------------
 *   1. No preference → the launcher is exactly what it was. The default is not a
 *      special case to be handled; it is what happens when nothing is stored.
 *   2. A saved order is applied.
 *   3. ROLE FILTERING SURVIVES ORDERING. The gate runs first and ordering can
 *      only permute its output — the security property of the whole feature, and
 *      the one a "sort by stored list" implementation is most likely to lose.
 *   4. A stored key that no longer names a card is ignored, whether the module
 *      was retired or the permission was revoked. Those two are the same fact
 *      here, which is why they cannot be confused.
 *   5. A module shipped after somebody last saved is APPENDED, not dropped.
 *   6. Cancel restores, and writes nothing.
 *   7. Reset restores the canonical order and still needs Save.
 *   8. A FAILED SAVE KEEPS THE ARRANGEMENT. Nobody loses a rearrangement to a
 *      failed request.
 *   9. Two people's orders are independent, and neither touches the shared
 *      canonical array. (The database half of this is proved against a real
 *      Postgres in moduleOrderStorage.test.ts.)
 *  10. A card in normal mode is still the whole-card button it always was.
 *  11. A card in edit mode is not a button at all.
 *  12. Arrow keys move a card, on both axes, and clamp at the ends.
 *
 * Run:
 *   npx tsx --test src/lib/modules/moduleOrder.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPersonalModuleOrder,
  normalizeStoredModuleOrder,
  moduleOrderKeys,
  moduleOrderEquals,
  moveModuleKey,
  moveModuleKeyToSlotOf,
  moduleCardPressProps,
  moduleReorderKeyDelta,
  moduleDragHandleLabel,
  moduleOrderEditReducer,
  visibleModuleOrder,
  IDLE_MODULE_ORDER_EDIT,
  MAX_STORED_MODULE_KEYS,
  PERSONAL_MODULE_ORDER_TABLE,
  type ModuleOrderEditState,
} from './moduleOrder'

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// Shaped like the launcher's own array: a key, and a title only so that a test
// can prove the title is never what gets stored. The keys are the real ones from
// src/app/modules/page.tsx.

type Card = { key: string; title: string }

const card = (key: string): Card => ({ key, title: key.toUpperCase() })

/** What an admin sees: the full canonical order. */
const ADMIN_CARDS: Card[] = [
  'tasks', 'samples', 'attendance_payroll', 'showroom', 'assets', 'members',
  'performance', 'finance', 'meetings', 'customer_reviews', 'orders',
  'image_editor', 'control_center',
].map(card)

/** What an employee with three grants sees — a SUBSET, in canonical order. */
const EMPLOYEE_CARDS: Card[] = ['tasks', 'attendance_payroll', 'meetings'].map(card)

// ── 1. Default order when no preference exists ───────────────────────────────

describe('1. no preference at all', () => {
  test('null gives the canonical order, card for card', () => {
    assert.deepEqual(
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, null)),
      moduleOrderKeys(ADMIN_CARDS),
    )
  })

  test('undefined and an empty list mean the same thing', () => {
    for (const nothing of [undefined, [], null]) {
      assert.deepEqual(
        moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, nothing)),
        moduleOrderKeys(ADMIN_CARDS),
        `${JSON.stringify(nothing)} must mean "canonical order"`,
      )
    }
  })

  test('an unusable stored value degrades to the default rather than breaking', () => {
    // The launcher is the screen somebody lands on after signing in. A row that
    // has somehow become nonsense costs them the default order for a visit; it
    // must not cost them the launcher.
    for (const rubbish of [
      null, undefined, 'orders', 42, {}, { 0: 'orders' },
      [1, 2, 3], [null], [{ key: 'orders' }], ['', '   '],
      ['Orders'],              // wrong case is not a key
      ['orders; drop table'],  // nor is anything with punctuation in it
    ]) {
      assert.equal(normalizeStoredModuleOrder(rubbish), null,
        `${JSON.stringify(rubbish)} must normalise to "no preference"`)
    }
  })

  test('a partly usable row keeps the usable part', () => {
    assert.deepEqual(
      normalizeStoredModuleOrder(['orders', 7, null, 'Finance', 'finance', 'orders']),
      ['orders', 'finance'],
      'well-formed keys survive, in first-seen order, deduplicated',
    )
  })

  test('the stored list is bounded', () => {
    const tooMany = Array.from({ length: MAX_STORED_MODULE_KEYS + 25 }, (_, i) => `mod_${i}`)
    assert.equal(normalizeStoredModuleOrder(tooMany)?.length, MAX_STORED_MODULE_KEYS)
  })
})

// ── 2. A saved personal order is applied ─────────────────────────────────────

describe('2. a saved order is applied', () => {
  test('the saved sequence leads, and the rest follows in canonical order', () => {
    const ordered = applyPersonalModuleOrder(ADMIN_CARDS, ['orders', 'finance', 'meetings'])
    assert.deepEqual(moduleOrderKeys(ordered).slice(0, 3), ['orders', 'finance', 'meetings'])
    assert.deepEqual(
      moduleOrderKeys(ordered).slice(3),
      moduleOrderKeys(ADMIN_CARDS).filter(k => !['orders', 'finance', 'meetings'].includes(k)),
    )
  })

  test('a full saved order is honoured exactly', () => {
    const reversed = [...moduleOrderKeys(ADMIN_CARDS)].reverse()
    assert.deepEqual(moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, reversed)), reversed)
  })

  test('every card is present exactly once, whatever was saved', () => {
    for (const saved of [
      ['orders'],
      ['control_center', 'control_center', 'tasks'],
      ['gone', 'orders', 'also_gone'],
      [...moduleOrderKeys(ADMIN_CARDS)].reverse(),
    ]) {
      const keys = moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, saved))
      assert.equal(keys.length, ADMIN_CARDS.length, `${saved} changed the number of cards`)
      assert.equal(new Set(keys).size, keys.length, `${saved} produced a duplicate card`)
      assert.deepEqual([...keys].sort(), [...moduleOrderKeys(ADMIN_CARDS)].sort(),
        `${saved} changed WHICH cards are on screen`)
    }
  })

  test('it returns the very same card objects — it sorts, it does not rebuild', () => {
    const ordered = applyPersonalModuleOrder(ADMIN_CARDS, ['orders'])
    assert.equal(ordered[0], ADMIN_CARDS.find(c => c.key === 'orders'),
      'the Orders card must be the object the launcher built, with its icon and count')
  })
})

// ── 3. Role filtering remains authoritative ──────────────────────────────────

describe('3. ordering cannot widen what somebody sees', () => {
  test("an employee's saved order cannot conjure a card they may not open", () => {
    // The worst case, stated plainly: a stored list naming every module in the
    // app, applied to the three cards an employee was actually granted.
    const greedy = [...moduleOrderKeys(ADMIN_CARDS), 'control_center', 'finance']
    const ordered = applyPersonalModuleOrder(EMPLOYEE_CARDS, greedy)

    assert.deepEqual([...moduleOrderKeys(ordered)].sort(), ['attendance_payroll', 'meetings', 'tasks'])
    for (const forbidden of ['finance', 'orders', 'control_center', 'members', 'performance']) {
      assert.equal(ordered.some(c => c.key === forbidden), false,
        `${forbidden} appeared on a screen that was never given it`)
    }
  })

  test('the result is always a permutation of the input, for every input', () => {
    // The property the security of this feature rests on: nothing comes out that
    // did not go in. Checked over the subset, the full set and the empty set.
    for (const allowed of [EMPLOYEE_CARDS, ADMIN_CARDS, [] as Card[]]) {
      for (const saved of [null, ['orders'], ['control_center', 'finance'], ['tasks']]) {
        const ordered = applyPersonalModuleOrder(allowed, saved)
        assert.equal(ordered.length, allowed.length)
        for (const c of ordered) assert.ok(allowed.includes(c), `${c.key} was not in the allowed set`)
      }
    }
  })

  test('somebody with no cards still has no cards', () => {
    assert.deepEqual(applyPersonalModuleOrder([], ['orders', 'finance']), [])
  })
})

// ── 4. Unknown and revoked keys are ignored ──────────────────────────────────

describe('4. a stored key that no longer names a card', () => {
  test('a retired module key is dropped without disturbing the rest', () => {
    const ordered = applyPersonalModuleOrder(ADMIN_CARDS, ['retired_module', 'orders', 'ghost'])
    assert.equal(moduleOrderKeys(ordered)[0], 'orders')
    assert.equal(moduleOrderKeys(ordered).length, ADMIN_CARDS.length)
  })

  test('a revoked permission is the same fact, and reads the same way', () => {
    // Yesterday this person had Finance and saved it first. The grant is gone, so
    // the launcher builds no Finance card, so there is nothing for the key to
    // select — and the order they kept for everything else survives.
    const ordered = applyPersonalModuleOrder(
      ADMIN_CARDS.filter(c => c.key !== 'finance'),
      ['finance', 'orders', 'tasks'],
    )
    assert.equal(ordered.some(c => c.key === 'finance'), false)
    assert.deepEqual(moduleOrderKeys(ordered).slice(0, 2), ['orders', 'tasks'])
  })

  test('a list of nothing but dead keys leaves the canonical order', () => {
    assert.deepEqual(
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, ['a_gone', 'b_gone'])),
      moduleOrderKeys(ADMIN_CARDS),
    )
  })
})

// ── 5. Newly permitted modules are appended ──────────────────────────────────

describe('5. a module that arrived after the last save', () => {
  test('is appended, not dropped', () => {
    // Saved before Image Editor and Review Workflow existed.
    const saved = ['orders', 'finance', 'tasks', 'samples', 'attendance_payroll',
      'showroom', 'assets', 'members', 'performance', 'meetings', 'control_center']
    const keys = moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, saved))

    assert.deepEqual(keys.slice(0, saved.length), saved, 'the saved part is untouched')
    assert.deepEqual(keys.slice(saved.length), ['customer_reviews', 'image_editor'],
      'the new cards land at the end, in the order the launcher declares them')
  })

  test('several new modules keep their canonical order relative to each other', () => {
    const keys = moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, ['orders']))
    const appended = keys.slice(1)
    const canonical = moduleOrderKeys(ADMIN_CARDS).filter(k => k !== 'orders')
    assert.deepEqual(appended, canonical)
  })
})

// ── The move arithmetic ──────────────────────────────────────────────────────

describe('moving one key', () => {
  const order = ['a', 'b', 'c', 'd']

  test('one step each way', () => {
    assert.deepEqual(moveModuleKey(order, 'c', -1), ['a', 'c', 'b', 'd'])
    assert.deepEqual(moveModuleKey(order, 'b', 1), ['a', 'c', 'b', 'd'])
  })

  test('it clamps rather than wrapping', () => {
    assert.deepEqual(moveModuleKey(order, 'a', -1), order, 'first cannot go back')
    assert.deepEqual(moveModuleKey(order, 'd', 1), order, 'last cannot go on')
    assert.deepEqual(moveModuleKey(order, 'c', -99), ['c', 'a', 'b', 'd'], 'Home lands at the front')
    assert.deepEqual(moveModuleKey(order, 'b', 99), ['a', 'c', 'd', 'b'], 'End lands at the back')
  })

  test('a key that is not there changes nothing, and never throws', () => {
    assert.deepEqual(moveModuleKey(order, 'z', 1), order)
  })

  test('the input is never mutated', () => {
    const input = [...order]
    moveModuleKey(input, 'a', 2)
    assert.deepEqual(input, order)
  })

  test('into another card\'s slot: the pointer path', () => {
    assert.deepEqual(moveModuleKeyToSlotOf(order, 'a', 'c'), ['b', 'c', 'a', 'd'],
      'dragging down lands where the pointer is, not one short of it')
    assert.deepEqual(moveModuleKeyToSlotOf(order, 'd', 'b'), ['a', 'd', 'b', 'c'],
      'dragging up takes the target slot and pushes the target back')
    assert.deepEqual(moveModuleKeyToSlotOf(order, 'b', 'b'), order, 'onto itself is a no-op')
    assert.deepEqual(moveModuleKeyToSlotOf(order, 'z', 'b'), order)
    assert.deepEqual(moveModuleKeyToSlotOf(order, 'b', 'z'), order)
  })
})

// ── 6/7/8. Edit mode ─────────────────────────────────────────────────────────

/** Open edit mode on an order, then apply a list of actions. */
const edit = (
  order: string[],
  ...actions: Parameters<typeof moduleOrderEditReducer>[1][]
): ModuleOrderEditState =>
  actions.reduce(
    moduleOrderEditReducer,
    moduleOrderEditReducer(IDLE_MODULE_ORDER_EDIT, { type: 'open', order }),
  )

const SAVED = ['orders', 'finance', 'tasks']

describe('6. Cancel', () => {
  test('leaves edit mode and restores the order that was on screen', () => {
    const state = edit(
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, SAVED)),
      { type: 'move', key: 'control_center', delta: -99 },
      { type: 'move', key: 'orders', delta: 3 },
      { type: 'cancel' },
    )

    assert.equal(state.working, null, 'edit mode is closed')
    // THE RESTORE, stated the way the screen sees it: the grid outside edit mode
    // renders `visibleModuleOrder` with a null working list, and the saved order
    // is untouched — so it is the pre-edit arrangement, card for card.
    assert.deepEqual(
      moduleOrderKeys(visibleModuleOrder(ADMIN_CARDS, SAVED, state.working)),
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, SAVED)),
    )
  })

  test('it clears a failed save too, so the next Edit order starts clean', () => {
    const state = edit(
      SAVED,
      { type: 'move', key: 'tasks', delta: -1 },
      { type: 'saveStart' },
      { type: 'saveFailed', message: 'network' },
      { type: 'cancel' },
    )
    assert.deepEqual(state, IDLE_MODULE_ORDER_EDIT)
  })

  test('it is refused mid-save, so a request in flight cannot be orphaned', () => {
    const saving = edit(SAVED, { type: 'saveStart' })
    assert.deepEqual(moduleOrderEditReducer(saving, { type: 'cancel' }), saving)
  })
})

describe('7. Reset to default', () => {
  const canonical = moduleOrderKeys(ADMIN_CARDS)

  test('puts the canonical order in the working arrangement', () => {
    const state = edit(
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, SAVED)),
      { type: 'move', key: 'meetings', delta: -99 },
      { type: 'reset', canonical },
    )
    assert.deepEqual(state.working, canonical)
  })

  test('and does NOT save: edit mode stays open and the stored order is untouched', () => {
    const state = edit(
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, SAVED)),
      { type: 'reset', canonical },
    )
    assert.notEqual(state.working, null, 'still editing — Save has not been pressed')

    // Cancelling after a Reset goes back to the SAVED order, which is the proof
    // that Reset wrote nothing.
    const cancelled = moduleOrderEditReducer(state, { type: 'cancel' })
    assert.deepEqual(
      moduleOrderKeys(visibleModuleOrder(ADMIN_CARDS, SAVED, cancelled.working)),
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, SAVED)),
    )
  })

  test('it clears a stale error', () => {
    const state = edit(
      SAVED,
      { type: 'saveStart' },
      { type: 'saveFailed', message: 'network' },
      { type: 'reset', canonical },
    )
    assert.equal(state.error, null, 'the message was about a list no longer being offered')
  })
})

describe('8. a save that fails', () => {
  const rearranged = edit(
    moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, SAVED)),
    { type: 'move', key: 'control_center', delta: -99 },
  )

  test('keeps the unsaved arrangement, exactly', () => {
    const failed = [
      { type: 'saveStart' as const },
      { type: 'saveFailed' as const, message: 'Legacy API keys are disabled' },
    ].reduce(moduleOrderEditReducer, rearranged)

    assert.deepEqual(failed.working, rearranged.working,
      'the arrangement must survive the failure — this is the whole point')
    assert.equal(failed.working?.[0], 'control_center')
  })

  test('keeps the user in edit mode, with a retryable message', () => {
    const failed = [
      { type: 'saveStart' as const },
      { type: 'saveFailed' as const, message: 'Legacy API keys are disabled' },
    ].reduce(moduleOrderEditReducer, rearranged)

    assert.notEqual(failed.working, null, 'edit mode stays open')
    assert.equal(failed.saving, false, 'Save is pressable again')
    assert.match(failed.error ?? '', /Legacy API keys/, 'the message says what went wrong')
  })

  test('and a retry that succeeds closes edit mode', () => {
    const done = [
      { type: 'saveStart' as const },
      { type: 'saveFailed' as const, message: 'network' },
      { type: 'saveStart' as const },
      { type: 'saveSucceeded' as const },
    ].reduce(moduleOrderEditReducer, rearranged)

    assert.deepEqual(done, IDLE_MODULE_ORDER_EDIT)
  })

  test('nothing rearranges while a save is in flight', () => {
    const saving = moduleOrderEditReducer(rearranged, { type: 'saveStart' })
    for (const action of [
      { type: 'move' as const, key: 'orders', delta: 1 },
      { type: 'moveToSlotOf' as const, key: 'orders', targetKey: 'tasks' },
      { type: 'reset' as const, canonical: moduleOrderKeys(ADMIN_CARDS) },
      { type: 'dragStart' as const, key: 'orders' },
    ]) {
      assert.deepEqual(moduleOrderEditReducer(saving, action), saving,
        `${action.type} must not change an arrangement that is being saved`)
    }
  })

  test('no action does anything at all outside edit mode', () => {
    for (const action of [
      { type: 'move' as const, key: 'orders', delta: 1 },
      { type: 'moveToSlotOf' as const, key: 'orders', targetKey: 'tasks' },
      { type: 'reset' as const, canonical: ['orders'] },
      { type: 'saveStart' as const },
      { type: 'saveFailed' as const, message: 'x' },
      { type: 'dragStart' as const, key: 'orders' },
      { type: 'dragEnd' as const },
    ]) {
      assert.deepEqual(moduleOrderEditReducer(IDLE_MODULE_ORDER_EDIT, action),
        IDLE_MODULE_ORDER_EDIT, `${action.type} escaped edit mode`)
    }
  })
})

describe('the drag flag', () => {
  test('marks one card, and clears', () => {
    const held = edit(SAVED, { type: 'dragStart', key: 'finance' })
    assert.equal(held.dragging, 'finance')
    assert.equal(moduleOrderEditReducer(held, { type: 'dragEnd' }).dragging, null)
  })
})

// ── 9. One person's order is their own ───────────────────────────────────────

describe("9. one person's preference does not affect another", () => {
  test('two saved orders over the same canonical array give two answers', () => {
    const alice = applyPersonalModuleOrder(ADMIN_CARDS, ['orders', 'finance'])
    const bob   = applyPersonalModuleOrder(ADMIN_CARDS, ['meetings', 'tasks'])

    assert.deepEqual(moduleOrderKeys(alice).slice(0, 2), ['orders', 'finance'])
    assert.deepEqual(moduleOrderKeys(bob).slice(0, 2), ['meetings', 'tasks'])
    assert.equal(moduleOrderEquals(moduleOrderKeys(alice), moduleOrderKeys(bob)), false)
  })

  test('THE CANONICAL ARRAY IS NEVER MUTATED — that is how one order stays one person\'s', () => {
    // A sort or a splice in place would make the first person to load the page
    // decide the order for everybody who renders afterwards, in the same tab and
    // the same module instance.
    const before = moduleOrderKeys(ADMIN_CARDS)

    applyPersonalModuleOrder(ADMIN_CARDS, [...before].reverse())
    applyPersonalModuleOrder(ADMIN_CARDS, ['control_center'])
    visibleModuleOrder(ADMIN_CARDS, ['orders'], ['finance'])

    assert.deepEqual(moduleOrderKeys(ADMIN_CARDS), before,
      'the launcher default moved — one person\'s preference has leaked into it')
  })

  test('a third person with no preference still gets the default', () => {
    applyPersonalModuleOrder(ADMIN_CARDS, ['control_center', 'image_editor'])
    assert.deepEqual(
      moduleOrderKeys(applyPersonalModuleOrder(ADMIN_CARDS, null)),
      moduleOrderKeys(ADMIN_CARDS),
    )
  })
})

// ── 10 / 11. Navigation, and the absence of it ───────────────────────────────

/** A keyboard event that records whether the default was prevented. */
const keyEvent = (key: string) => {
  let prevented = false
  return { key, preventDefault: () => { prevented = true }, get prevented() { return prevented } }
}

describe('10. a card in normal mode still navigates', () => {
  test('it is the whole-card button it has always been', () => {
    let opened = 0
    const press = moduleCardPressProps(() => { opened += 1 })

    assert.equal(press.role, 'button')
    assert.equal(press.tabIndex, 0)

    press.onClick?.()
    assert.equal(opened, 1, 'a click must open the module')

    press.onKeyDown?.(keyEvent('Enter'))
    assert.equal(opened, 2, 'Enter must open it too')
  })

  test('SPACE opens it as well, and does not also scroll the page', () => {
    // role="button" promises both keys, and Space is the browser's page-scroll
    // key — so activating a focused card must not also scroll the launcher
    // behind it. Arrived with the card-surface work on main; asserted here
    // because it now lives in moduleCardPressProps.
    let opened = 0
    const press = moduleCardPressProps(() => { opened += 1 })

    const space = keyEvent(' ')
    press.onKeyDown?.(space)
    assert.equal(opened, 1, 'Space must open the module')
    assert.equal(space.prevented, true, 'Space must not also scroll the page')

    const enter = keyEvent('Enter')
    press.onKeyDown?.(enter)
    assert.equal(enter.prevented, true, 'Enter is prevented alongside Space')
  })

  test('and only those two do: every other key is the page\'s', () => {
    let opened = 0
    const press = moduleCardPressProps(() => { opened += 1 })
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Escape', 'a', 'Spacebar']) {
      const e = keyEvent(key)
      press.onKeyDown?.(e)
      assert.equal(e.prevented, false, `${key} must not be swallowed`)
    }
    assert.equal(opened, 0)
  })
})

describe('11. a card in edit mode does not navigate', () => {
  test('there is no handler, no role, no tabIndex, no Enter and no Space', () => {
    const press = moduleCardPressProps(null)
    assert.deepEqual(press, {
      onClick: undefined,
      role: undefined,
      tabIndex: undefined,
      onKeyDown: undefined,
    })
  })

  test('so nothing a pointer or a keyboard can do reaches a route', () => {
    // Stated as the absence it is: not a handler that decides not to navigate,
    // but no handler at all. A stray tap at the end of a drag has nothing to hit,
    // and the card is not focusable, so Enter and Space never arrive either.
    const press = moduleCardPressProps(null)
    assert.equal(typeof press.onClick, 'undefined')
    assert.equal(typeof press.onKeyDown, 'undefined')
    assert.equal(press.tabIndex, undefined, 'a card in edit mode is not in the tab order')
  })
})

// ── 12. Keyboard sorting ─────────────────────────────────────────────────────

describe('12. the handle takes arrow keys', () => {
  test('both axes move a card, because the grid is columns or rows by width', () => {
    assert.equal(moduleReorderKeyDelta('ArrowLeft', 13), -1)
    assert.equal(moduleReorderKeyDelta('ArrowUp', 13), -1)
    assert.equal(moduleReorderKeyDelta('ArrowRight', 13), 1)
    assert.equal(moduleReorderKeyDelta('ArrowDown', 13), 1)
  })

  test('Home and End reach the ends', () => {
    assert.equal(moduleReorderKeyDelta('Home', 13), -13)
    assert.equal(moduleReorderKeyDelta('End', 13), 13)
  })

  test('every other key is not the handle\'s business', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'PageUp', 'Shift']) {
      assert.equal(moduleReorderKeyDelta(key, 13), 0, `${key} must pass through`)
    }
  })

  test('end to end: four presses move Orders to the front and it stays there', () => {
    let state = moduleOrderEditReducer(IDLE_MODULE_ORDER_EDIT, {
      type: 'open',
      order: moduleOrderKeys(ADMIN_CARDS),
    })
    const press = (key: string) => {
      const delta = moduleReorderKeyDelta(key, state.working!.length)
      if (delta !== 0) state = moduleOrderEditReducer(state, { type: 'move', key: 'orders', delta })
    }

    assert.equal(state.working!.indexOf('orders'), 10)
    for (let i = 0; i < 10; i++) press('ArrowUp')
    assert.equal(state.working![0], 'orders')

    // At the front, and a further press does nothing rather than wrapping to the
    // back — the one behaviour that would make keyboard sorting unusable.
    press('ArrowLeft')
    assert.equal(state.working![0], 'orders')

    press('End')
    assert.equal(state.working!.at(-1), 'orders')
  })

  test('a handle says which card it moves and where that card is', () => {
    assert.equal(
      moduleDragHandleLabel('Finance', 8, 13),
      'Reorder Finance, position 8 of 13. Use the arrow keys to move it.',
    )
    // Without the position an arrow press produces no audible change at all.
    assert.match(moduleDragHandleLabel('Orders', 1, 13), /position 1 of 13/)
  })
})

// ── The stored shape ─────────────────────────────────────────────────────────

describe('what gets stored', () => {
  test('keys, and nothing that is not a key', () => {
    const keys = moduleOrderKeys(ADMIN_CARDS)
    for (const k of keys) {
      assert.match(k, /^[a-z][a-z0-9_]*$/, `${k} is not a stable module key`)
    }
    // Titles are what the fixtures set to the uppercase key, so a title leaking
    // into the stored list would be visible here.
    for (const c of ADMIN_CARDS) {
      assert.equal(keys.includes(c.title), false, 'a title reached the stored list')
    }
  })

  test('one table name, shared by the migration, the hook and the tests', () => {
    assert.equal(PERSONAL_MODULE_ORDER_TABLE, 'user_module_order')
  })

  test('moduleOrderEquals tells apart order as well as membership', () => {
    assert.ok(moduleOrderEquals(['a', 'b'], ['a', 'b']))
    assert.equal(moduleOrderEquals(['a', 'b'], ['b', 'a']), false)
    assert.equal(moduleOrderEquals(['a'], ['a', 'b']), false)
    assert.ok(moduleOrderEquals([], []))
  })
})
