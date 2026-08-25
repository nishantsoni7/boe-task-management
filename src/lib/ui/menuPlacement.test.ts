/**
 * Where a row's overflow menu goes, and why it is not trapped in the card.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 * -------------------------------
 * On Confirmed Payments, opening the Actions menu on the LAST visible row drew
 * a panel that was cut off at the card's bottom edge: "Allocate Funds" was
 * visible and every action under it was rendered but unreachable. Two causes,
 * both fixed:
 *
 *   1. The panel was `position: absolute` inside `.boe-card`, which carries
 *      `overflow: hidden`. An absolutely-positioned box is clipped by any
 *      ancestor whose overflow is not `visible`.
 *   2. It pinned `top: 100%`, so it never opened upward however little room was
 *      left below.
 *
 * Part 1 below is the arithmetic, tested directly. Part 2 reads the component
 * source and fails if the panel is ever put back inside the clipping container
 * or loses its collision handling. Part 3 pins that the fix moved only WHERE
 * the menu is drawn, never WHICH actions it contains.
 *
 * Reads repository files only. No DOM, no browser, no network.
 *
 * Run:
 *   npx tsx --test src/lib/ui/menuPlacement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { placeMenu, MENU_GAP, MENU_MARGIN } from './menuPlacement'

const VIEW = 'src/app/finance/received/ReceivedPaymentsView.tsx'
const view = readFileSync(join(process.cwd(), VIEW), 'utf8')

/** A 1280x800 desktop viewport, the panel 150 wide and 132 tall (four actions). */
const VIEWPORT = { viewportWidth: 1280, viewportHeight: 800 }
const PANEL = { menuWidth: 150, menuHeight: 132 }

/** A trigger at a given vertical position, in the right-hand Actions column. */
const anchorAt = (top: number, height = 21) =>
  ({ top, bottom: top + height, left: 1180, right: 1210 })

const place = (top: number, over: Partial<Parameters<typeof placeMenu>[0]> = {}) =>
  placeMenu({ anchor: anchorAt(top), ...PANEL, ...VIEWPORT, ...over })

// ══ 1. The placement arithmetic ══════════════════════════════════════════════

describe('a menu with room below opens below', () => {
  test('first row', () => {
    const first = place(120)
    assert.equal(first.placement, 'below')
    assert.equal(first.top, 120 + 21 + MENU_GAP, 'sits just under the trigger')
  })

  test('middle row', () => {
    assert.equal(place(400).placement, 'below')
  })

  test('a row with exactly enough room stays below', () => {
    // Bottom edge lands precisely on the margin — fits, so no flip.
    const exact = VIEWPORT.viewportHeight - MENU_MARGIN - PANEL.menuHeight - MENU_GAP
    const result = place(exact - 21)
    assert.equal(result.placement, 'below')
    assert.equal(result.top + PANEL.menuHeight, VIEWPORT.viewportHeight - MENU_MARGIN)
  })
})

describe('a menu with no room below opens upward', () => {
  test('LAST ROW — the reported defect', () => {
    // A trigger near the bottom of an 800px viewport. Below would need
    // 740+21+4+132 = well past 800, so it flips.
    const last = place(740)
    assert.equal(last.placement, 'above', 'must flip rather than run off the bottom')
    assert.equal(last.top, 740 - MENU_GAP - PANEL.menuHeight, 'sits just above the trigger')
    assert.ok(last.top >= MENU_MARGIN, 'and stays on screen')
  })

  test('the whole panel is on screen either way', () => {
    // The property that actually matters, swept across every row position a
    // table can produce: no action is ever off screen, top or bottom.
    for (let top = 0; top <= VIEWPORT.viewportHeight; top += 10) {
      const result = place(top)
      assert.ok(result.top >= MENU_MARGIN,
        `top ${top}: panel starts above the viewport (${result.top})`)
      assert.ok(result.top + PANEL.menuHeight <= VIEWPORT.viewportHeight - MENU_MARGIN,
        `top ${top}: panel ends below the viewport`)
    }
  })

  test('a taller menu flips sooner', () => {
    // Six actions instead of four: the same row that fitted below no longer
    // does, and the decision follows the MEASURED height rather than a guess.
    const tall = { menuWidth: 150, menuHeight: 260 }
    assert.equal(place(560).placement, 'below')
    assert.equal(place(560, tall).placement, 'above')
  })
})

describe('when neither side fits, the better side wins and the top survives', () => {
  test('a cramped viewport does not flip into an even smaller space', () => {
    // Trigger near the bottom of a very short viewport: above has more room, so
    // it flips. Trigger near the TOP of the same viewport: below has more room,
    // so it must NOT flip — flipping would push the first action off screen.
    const short = { viewportWidth: 1280, viewportHeight: 300 }
    assert.equal(place(250, short).placement, 'above')
    assert.equal(place(20, short).placement, 'below')
  })

  test('a panel taller than the viewport keeps its FIRST item on screen', () => {
    // A menu is read from the top down. When it cannot fit at all, the top edge
    // is the one that must survive clamping.
    const huge = { menuWidth: 150, menuHeight: 900 }
    const result = place(400, huge)
    assert.equal(result.top, MENU_MARGIN,
      'the panel starts at the margin, so the first action is reachable')
  })
})

describe('horizontal placement', () => {
  test('the panel is right-aligned to the trigger, as it always was', () => {
    // Replaces the old `right: 0`.
    assert.equal(place(200).left, 1210 - PANEL.menuWidth)
  })

  test('a trigger near the left edge does not push the panel off screen', () => {
    const result = placeMenu({
      anchor: { top: 200, bottom: 221, left: 10, right: 40 },
      ...PANEL, ...VIEWPORT,
    })
    assert.equal(result.left, MENU_MARGIN, 'clamped into the viewport')
  })

  test('a trigger at the far right does not overflow either', () => {
    const result = placeMenu({
      anchor: { top: 200, bottom: 221, left: 1270, right: 1280 },
      ...PANEL, ...VIEWPORT,
    })
    assert.ok(result.left + PANEL.menuWidth <= VIEWPORT.viewportWidth - MENU_MARGIN)
  })
})

describe('short tables and narrow screens', () => {
  test('a table with only one row still places its menu on screen', () => {
    // A 1-3 row table is short, so its rows sit HIGH in the viewport and the
    // menu opens below with room to spare — the case that always worked, pinned
    // so a future "always flip" shortcut cannot break it.
    const only = place(180)
    assert.equal(only.placement, 'below')
    assert.ok(only.top + PANEL.menuHeight <= VIEWPORT.viewportHeight - MENU_MARGIN)
  })

  test('a phone-sized viewport still fits the whole panel', () => {
    const phone = { viewportWidth: 390, viewportHeight: 844 }
    for (const top of [40, 400, 800]) {
      const result = placeMenu({ anchor: anchorAt(top), ...PANEL, ...phone })
      assert.ok(result.top >= MENU_MARGIN)
      assert.ok(result.top + PANEL.menuHeight <= phone.viewportHeight - MENU_MARGIN)
      assert.ok(result.left >= MENU_MARGIN)
      assert.ok(result.left + PANEL.menuWidth <= phone.viewportWidth - MENU_MARGIN)
    }
  })
})

// ══ 2. The panel is not structurally trapped in a clipping container ═════════

describe('the menu escapes the card that clips it', () => {
  test('the panel is rendered into <body>, not into the row', () => {
    // THE STRUCTURAL CLAIM. `.boe-card` carries overflow: hidden, so anything
    // positioned inside it is clipped at its edges. A portal is what takes the
    // panel out of that subtree entirely.
    assert.ok(view.includes("import { createPortal } from 'react-dom'"))
    assert.ok(view.includes('createPortal(panel, document.body)'),
      'the panel must be portalled to the document body')
  })

  test('and it is positioned against the viewport, not an offset parent', () => {
    const menu = view.slice(view.indexOf('function RowActionsMenu'))
    const body = menu.slice(0, menu.indexOf('\n}\n'))
    assert.ok(body.includes("position: 'fixed'"),
      'a portalled panel is placed against the viewport')
    assert.ok(!body.includes("position: 'absolute'"),
      'absolute positioning is what the clipping ancestor cut off')
    assert.ok(!/top: '100%'/.test(body),
      'and the unconditional downward placement is gone')
  })

  test('the card still clips its own corners — the fix did not widen overflow', () => {
    // The container's overflow is load-bearing: it keeps rows from bleeding
    // past the rounded corners. Solving the menu by loosening it would trade
    // one visual defect for another.
    assert.ok(view.includes(`<div className="boe-card" style={{ overflow: 'hidden' }}>`),
      'the card keeps overflow: hidden')
  })

  test('nothing was solved by padding the page or hiding actions', () => {
    const menu = view.slice(view.indexOf('function RowActionsMenu'))
    const body = menu.slice(0, menu.indexOf('\n}\n'))
    assert.ok(!/minHeight|paddingBottom:\s*\d{3}/.test(body),
      'no empty page height was added to make room')
    assert.ok(!/slice\(0,|\.filter\(/.test(body),
      'the menu must render every action it is given')
  })
})

describe('placement is measured, and re-measured', () => {
  const menu = view.slice(view.indexOf('function RowActionsMenu'))
  const body = menu.slice(0, menu.indexOf('\n}\n'))

  test('the real panel height decides the flip', () => {
    assert.ok(body.includes('panel.offsetHeight'),
      'measured, so a menu with more actions flips sooner')
    assert.ok(body.includes('trigger.getBoundingClientRect()'),
      'and anchored to where the trigger actually is')
  })

  test('the decision is the shared, tested one', () => {
    assert.ok(body.includes('placeMenu({'),
      'the component must not hand-roll its own placement rule')
  })

  test('scrolling or resizing re-places an open menu', () => {
    // The panel is fixed and the row is not, so without this the menu would
    // stay behind while its row scrolled away.
    assert.ok(body.includes("window.addEventListener('scroll', reposition, true)"),
      'capture phase, because a scroll inside the table does not bubble')
    assert.ok(body.includes("window.addEventListener('resize', reposition)"))
    assert.ok(body.includes("window.removeEventListener('scroll', reposition, true)"),
      'and both are removed again')
  })

  test('the panel is not visible before it has been placed', () => {
    assert.ok(body.includes("visibility: placement ? 'visible' : 'hidden'"),
      'otherwise it would flash at 0,0 for a frame')
  })

  test('it sits above the app shell', () => {
    assert.ok(/zIndex: 1000/.test(body))
  })

  test('it closes on Escape, on an outside click, and on choosing an action', () => {
    assert.ok(body.includes("event.key === 'Escape'"))
    assert.ok(body.includes("document.addEventListener('pointerdown', onPointerDown, true)"))
    assert.ok(body.includes('onClick={() => { setOpen(false); action.onSelect() }}'),
      'choosing an action closes the menu and then runs it')
  })

  test('it keeps an accessible name and reports its state', () => {
    assert.ok(body.includes('aria-haspopup="menu"'))
    assert.ok(body.includes('aria-expanded={open}'))
    assert.ok(body.includes('aria-label={label}'))
    assert.ok(body.includes("role=\"menu\"") && body.includes("role=\"menuitem\""))
  })

  test('server rendering does not reach for document', () => {
    assert.ok(body.includes("typeof document !== 'undefined'"))
  })
})

// ══ 3. The fix moved WHERE the menu draws, never WHICH actions it holds ══════

describe('the action lists are untouched', () => {
  test('the menu renders every action it is handed, in order', () => {
    const menu = view.slice(view.indexOf('function RowActionsMenu'))
    const body = menu.slice(0, menu.indexOf('\n}\n'))
    assert.ok(body.includes('actions.map(action => ('),
      'one menuitem per action, no slicing and no reordering')
    assert.ok(body.includes('if (actions.length === 0) return null'),
      'and a row with no permitted actions still shows no control at all')
  })

  test('Allocate Funds is still offered from its own permission rule', () => {
    // The reported symptom was that actions BELOW Allocate Funds were cut off.
    // Allocate Funds itself is gated by canOfferAllocateFunds and canAllocate,
    // and this fix must not have moved that decision into the menu.
    assert.ok(view.includes('...(offerAllocate'))
    assert.ok(view.includes('{ label: ALLOCATE_FUNDS_ACTION_LABEL, onSelect: () => onAllocateFunds(r) }'))
    assert.ok(view.includes('const offerAllocate = canAllocate && canOfferAllocateFunds(r)'),
      'still permission-derived at the call site')
  })

  test('the manage-only actions are still gated on canManage', () => {
    assert.ok(view.includes('...(canManage && !r.order_id'),
      'linking is still a manage capability, and still only for an unlinked payment')
  })

  test('the destructive action is still admin-gated and still last', () => {
    // canDeleteRow is the admin-only rule; `danger: true` keeps Delete drawn in
    // red at the foot of the list.
    assert.ok(view.includes('canDeleteRow(r)'))
    assert.ok(/danger: true/.test(view), 'the destructive entry keeps its marker')
  })

  test('a non-admin sees exactly what they saw before', () => {
    // The component applies no permission logic of its own — proved by absence,
    // which is what keeps a presentation fix from becoming an access change.
    const menu = view.slice(view.indexOf('function RowActionsMenu'))
    const body = menu.slice(0, menu.indexOf('\n}\n'))
    for (const gate of ['canManage', 'canAllocate', 'canDeleteRow', 'isAdmin', 'role ===', 'profile']) {
      assert.ok(!body.includes(gate),
        `RowActionsMenu must not reference ${gate} — it draws what it is given`)
    }
  })

  test('both Finance tables share this one menu, so both are fixed', () => {
    assert.equal((view.match(/<RowActionsMenu/g) ?? []).length, 2,
      'Confirmed Payments and Payments to Verify')
  })

  test('the mobile cards keep their inline buttons and are unaffected', () => {
    // Cards render actions side by side rather than behind a dropdown, so they
    // never had anything to clip. Pinned so a later "unify the menus" change
    // has to consider this file.
    const cards = view.slice(view.indexOf('function ReceivedPaymentsCards'))
    const body = cards.slice(0, cards.indexOf('\n}\n'))
    assert.ok(!body.includes('RowActionsMenu'), 'cards do not use the dropdown')
    assert.ok(body.includes('onAllocateFunds(r)') && body.includes('onDelete(r)'),
      'and still offer the same actions inline')
  })
})
