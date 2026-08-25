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
import {
  CONFIRMED_ALLOCATION_BADGE,
  CONFIRMED_ALLOCATION_STATUSES,
} from '@/lib/finance/paymentSurfaces'

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
    assert.ok(view.includes('{ label: ALLOCATE_FUNDS_ACTION_LABEL, onSelect: () => onAllocateFunds(r), Icon: Split }'))
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

// ══ 4. The hover and focus treatment ═════════════════════════════════════════

describe('a menu entry shows which action is about to run', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
  const menu = view.slice(view.indexOf('function RowActionsMenu'))
  const body = menu.slice(0, menu.indexOf('\n}\n'))

  /** One CSS rule's declaration block, by exact selector. */
  const ruleFor = (selector: string): string => {
    const at = css.indexOf(selector)
    assert.ok(at > -1, `missing rule: ${selector}`)
    return css.slice(at, css.indexOf('}', at))
  }

  test('the styling is a class, not an inline style', () => {
    // :hover and :focus-visible cannot be expressed inline at all, which is why
    // the old inline block could only ever have had a mouse state.
    assert.ok(body.includes("className={`boe-menu-item${action.danger ? ' boe-menu-item--danger' : ''}`}"),
      'every entry takes the shared class, and a destructive one takes the modifier')
    assert.ok(!body.includes("color: action.danger ? colors.red : colors.primary"),
      'the inline colour branch is gone — the class carries it')
  })

  test('a normal action gets the established neutral hover', () => {
    const rule = ruleFor('.boe-menu-item:hover:not(:disabled),')
    assert.ok(rule.includes('#E8EBF0'),
      'colors.hover — the token every other hover in the app uses')
  })

  test('KEYBOARD FOCUS GETS THE SAME SURFACE, not just an outline', () => {
    // THE REQUIREMENT THIS PINS: hover must not be the only feedback. The
    // selector list is shared, so the two states cannot drift apart.
    const rule = ruleFor('.boe-menu-item:hover:not(:disabled),')
    assert.ok(/\.boe-menu-item:hover:not\(:disabled\),\s*\n\s*\.boe-menu-item:focus-visible:not\(:disabled\)\s*\{/.test(css),
      'hover and focus-visible share one declaration block')
    assert.ok(rule.includes('#E8EBF0'))
  })

  test('and a focus ring that stays inside the panel', () => {
    const rule = ruleFor('.boe-menu-item:focus-visible {')
    assert.ok(rule.includes('outline: 2px solid rgba(232,160,48,0.45)'),
      'the app-wide focus ring, not a new one')
    assert.ok(rule.includes('outline-offset: -1px'),
      'inset, so it does not spill over the panel’s rounded edge')
  })

  test('the destructive action keeps red text and takes a RED surface', () => {
    assert.ok(ruleFor('.boe-menu-item--danger {').includes('#D94F4F'),
      'colors.red, as before')
    const rule = ruleFor('.boe-menu-item--danger:hover:not(:disabled),')
    assert.ok(rule.includes('rgba(217,79,79,0.14)'),
      'the value .boe-btn-danger:hover already uses — not a new red')
    assert.ok(!rule.includes('#E8EBF0'),
      'Delete Payment must never share the neutral highlight with an ordinary action')
    assert.ok(/--danger:hover:not\(:disabled\),\s*\n\s*\.boe-menu-item--danger:focus-visible:not\(:disabled\)\s*\{/.test(css),
      'and its focus state matches its hover state')
  })

  test('the red hover is the one the buttons already use', () => {
    // Reuse, stated as an equality rather than a duplicated literal's comment:
    // if .boe-btn-danger:hover ever moves, this fails and the two are realigned.
    assert.ok(css.includes('.boe-btn-danger:hover { background: rgba(217,79,79,0.14); }'),
      'the established danger hover this borrows from')
  })

  test('a disabled entry is never made to look pressable', () => {
    // The component offers no disabled action today — an unheld permission drops
    // the entry entirely — so this is the guard for the day one is added.
    for (const selector of ['.boe-menu-item:hover:not(:disabled),',
                            '.boe-menu-item--danger:hover:not(:disabled),']) {
      assert.ok(selector.includes(':not(:disabled)'), `${selector} excludes disabled`)
    }
    const rule = ruleFor('.boe-menu-item:disabled {')
    assert.ok(rule.includes('cursor: not-allowed'))
    assert.ok(rule.includes('background: transparent'), 'and takes no highlight')
    assert.ok(!/disabled\?/.test(body),
      'the action type has no disabled flag yet; the CSS is defensive, not dead wiring')
  })

  test('the whole row is the target, with the padding and radius it always had', () => {
    const rule = ruleFor('.boe-menu-item {')
    // Flex since the icons landed — an icon and its label on one aligned row.
    // Still the full row: width:100% and a block-level flex container.
    assert.ok(rule.includes('display: flex') && rule.includes('width: 100%'),
      'the full row is clickable, not just the label')
    assert.ok(rule.includes('align-items: center') && rule.includes('gap: 8px'),
      'icon and label share one baseline')
    assert.ok(rule.includes('padding: 6px 9px'), 'unchanged from the inline style')
    assert.ok(rule.includes('border-radius: 6px'), 'unchanged')
    assert.ok(rule.includes('font-size: 12px'), 'unchanged')
    assert.ok(rule.includes('text-align: left'))
  })

  test('nothing that moves, grows or shouts', () => {
    // Requirement: no excessive animation, shadow, scale, icon or layout shift.
    const block = css.slice(css.indexOf('.boe-menu-item {'))
    const section = block.slice(0, block.indexOf('.boe-menu-item:disabled'))
    assert.ok(section.includes('transition: background-color 0.12s ease'),
      'a short transition, and only on the background')
    for (const forbidden of ['transform', 'box-shadow', 'scale(', 'translate']) {
      assert.ok(!section.includes(forbidden), `${forbidden} must not appear`)
    }
  })

  test('THE PANEL IS STILL THE SAME SIZE, so placement is unaffected', () => {
    // The collision maths measures the rendered panel. A hover treatment that
    // changed padding, font size or border would move where the menu opens —
    // which is the defect this file was created for.
    const rule = ruleFor('.boe-menu-item {')
    assert.ok(rule.includes('border: none'), 'no border was added')
    // Only colour-ish properties may appear in the interaction states.
    for (const state of ['.boe-menu-item:hover:not(:disabled),',
                         '.boe-menu-item--danger:hover:not(:disabled),']) {
      const declarations = ruleFor(state)
        .split('{')[1]
        .split(';')
        .map(d => d.split(':')[0].trim())
        .filter(Boolean)
      assert.deepEqual(declarations, ['background'],
        `${state} may change the background and nothing else`)
    }
  })

  test('both Finance tables get it, because both share this component', () => {
    assert.equal((view.match(/<RowActionsMenu/g) ?? []).length, 2)
  })

  test('the mobile inline actions were not touched', () => {
    const cards = view.slice(view.indexOf('function ReceivedPaymentsCards'))
    const cardBody = cards.slice(0, cards.indexOf('\n}\n'))
    assert.ok(!cardBody.includes('boe-menu-item'),
      'cards render inline buttons and keep their own styling')
  })
})

// ══ 5. The eight-column table, and where the removed columns went ════════════

describe('the primary row shows eight columns and no money detail', () => {
  const table = view.slice(view.indexOf('function ReceivedPaymentsTable'),
                           view.indexOf('function RowActionsMenu'))

  test('Customer, Total Allocated and Remaining are gone from the table body', () => {
    // THE CHANGE: all three moved into the detail modal the Allocation Status
    // badge opens. Customer was the widest and most-truncated column; the two
    // money figures are halves of one answer that cannot be acted on from a row.
    assert.ok(!table.includes('<CustomerName'),
      'the customer name is not a primary column any more')
    assert.ok(!table.includes('figures.totalAllocated'),
      'Total Allocated is not a primary column')
    assert.ok(!table.includes('value={figures.remaining}'),
      'Remaining is not a primary column')
  })

  test('but the row still renders the eight that remain, in order', () => {
    const order = ['r.human_payment_id', 'fmtAmount(r.amount)', 'fmtDate(r.payment_date)',
                   'PAYMENT_MODE_LABEL[r.payment_mode]', '<ConfirmedAllocationBadge',
                   'conciseName(r.submitted_by_name)', 'conciseName(r.approved_by_name)',
                   '<RowActionsMenu']
    let cursor = -1
    for (const marker of order) {
      const at = table.indexOf(marker, cursor + 1)
      assert.ok(at > cursor, `${marker} must appear, after the column before it`)
      cursor = at
    }
  })

  test('the raw UUID is never printed', () => {
    // human_payment_id is the identifier; r.id addresses rows and anchors, and
    // must not be rendered as text.
    assert.ok(!/>\{r\.id\}</.test(table), 'the row id is not shown to anyone')
    assert.ok(table.includes('{r.human_payment_id}'))
  })

  test('the expandable per-row breakdown is untouched', () => {
    // The exact PI/Order split still lives where it lived; only the two totals
    // beside it left the primary row.
    assert.ok(table.includes('CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS.map'))
    assert.ok(table.includes('figures.toPI') && table.includes('figures.toOrders'))
  })

  test('NOTHING LEFT THE QUERY — the modal still gets every removed field', () => {
    // The point of the whole change: this is what the TABLE draws, not what the
    // page knows. All three removed fields are still selected and still used.
    assert.ok(view.includes('client_name'), 'customer is still selected')
    assert.ok(view.includes('allocated_total'), 'the allocation total is still selected')
    assert.ok(view.includes('confirmedFigures'), 'the figures helper still exists')
  })
})

// ══ 6. The Allocation Status badge is a door ═════════════════════════════════

describe('every allocation status opens the payment record', () => {
  const badge = view.slice(view.indexOf('function ConfirmedAllocationBadge'))
  const body = badge.slice(0, badge.indexOf('\n}\n'))

  test('all four statuses render the same control — none is special-cased', () => {
    // zero / partial / full / over all reach the same <button>: the component
    // branches on whether an opener was GIVEN, never on which status it is.
    assert.ok(body.includes('if (!onOpen) return'),
      'the only branch is whether the badge was given something to open')
    assert.ok(!/status === 'zero'|status === 'partial'|status === 'full'/.test(body),
      'no status may be excluded from being clickable')
    for (const status of CONFIRMED_ALLOCATION_STATUSES) {
      assert.ok(CONFIRMED_ALLOCATION_BADGE[status], `${status} has a badge`)
    }
  })

  test('it is a real button, so Enter and Space work without wiring', () => {
    assert.ok(body.includes('<button'))
    assert.ok(body.includes('type="button"'), 'never a submit inside a form')
  })

  test('the accessible name identifies the PAYMENT, not just the state', () => {
    // Forty rows reading "Fully Allocated" are indistinguishable to a screen
    // reader unless the name carries the record.
    assert.ok(body.includes('aria-label={`View allocation details for ${paymentId ?? \'this payment\'}`}'))
    assert.ok(!body.includes('aria-label={meta.label}'), 'the state alone is not a name')
  })

  test('clicking it opens the record and nothing else', () => {
    // The row itself opens the record, and the expand toggle is in the same
    // row. A click on the badge must reach neither.
    assert.ok(body.includes('event.stopPropagation()'))
    assert.ok(view.includes('<td style={TD} onClick={e => e.stopPropagation()}>'),
      'the cell stops the row handler too')
  })

  test('the status colours are the badge’s own, in both shapes', () => {
    assert.ok(body.includes('const shared: React.CSSProperties'),
      'one style object serves the inert and the clickable badge')
    assert.ok(body.includes('background: style.bg') && body.includes('color: style.color'),
      'the per-status tone is unchanged')
  })

  test('hover and focus deepen the badge rather than recolouring it', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const rule = css.slice(css.indexOf('.boe-allocation-badge:hover,'))
    const decls = rule.slice(0, rule.indexOf('}'))
    assert.ok(decls.includes('filter: brightness(0.96)'),
      'a green badge stays green — the status is never restyled into another status')
    assert.ok(!decls.includes('background:'), 'and its own background is not replaced')
    assert.ok(css.includes('.boe-allocation-badge:focus-visible {'), 'keyboard focus is visible')
  })

  test('OVER-ALLOCATED keeps its warning', () => {
    assert.ok(body.includes("status === 'over'"))
    assert.ok(body.includes('Allocated total exceeds payment amount — flagged for Admin review'),
      'the admin-review warning survives the badge becoming a control')
    assert.ok(body.includes('overTitle ?? '), 'and it takes precedence over the generic tooltip')
  })

  test('a row with no status stays inert rather than opening nothing', () => {
    assert.ok(body.includes("if (!status) return <span"), 'an unknown status is a dash, not a button')
  })
})

// ══ 7. The modal is the existing one, extended ═══════════════════════════════

describe('the detail modal carries what the table stopped showing', () => {
  const modal = view.slice(view.indexOf('function DetailsModal'),
                           view.indexOf('function EditPaymentModal'))

  test('the badge opens the EXISTING modal — no competing duplicate', () => {
    // onView is what the row and the View button already called.
    assert.ok(view.includes('onOpen={() => onView(r)}'))
    assert.equal((view.match(/function DetailsModal/g) ?? []).length, 1,
      'there is exactly one payment detail modal')
    assert.equal((view.match(/function AllocationPanel/g) ?? []).length, 1,
      'and exactly one allocation breakdown component')
  })

  test('the customer name is there, unabridged', () => {
    // Not <CustomerName>, which truncates for a column — the whole name.
    assert.ok(modal.includes('{r.client_name}'))
    assert.ok(modal.includes("wordBreak: 'break-word'"), 'it wraps rather than clipping')
  })

  test('Payment ID, both people and the status are in the summary', () => {
    for (const field of ['Payment ID', 'Received Date', 'Payment Mode',
                         'Initiated By', 'Approved By', 'Allocation Status']) {
      assert.ok(modal.includes(field), `${field} must be in the modal summary`)
    }
    assert.ok(modal.includes('r.human_payment_id'), 'the human id, never the UUID')
    assert.ok(modal.includes('r.submitted_by_name') && modal.includes('r.approved_by_name'))
  })

  test('the allocation breakdown reaches it through the shared panel', () => {
    assert.ok(modal.includes('<AllocationPanel'))
    assert.ok(modal.includes('summary={allocation}') && modal.includes('amount={r.amount}'))
  })
})

describe('the allocation breakdown', () => {
  const panel = view.slice(view.indexOf('function AllocationPanel'),
                           view.indexOf('function DetailsModal'))

  test('every active allocation is listed, with its type, name and amount', () => {
    assert.ok(panel.includes('summary.targets.map'), 'one line per allocation, never a summary')
    assert.ok(panel.includes("target.kind === 'order' ? 'Order' : 'PI'"), 'the target type')
    assert.ok(panel.includes('{name}'), 'the human-readable number where it could be read')
    assert.ok(panel.includes('formatMoney(target.amount)'), 'and the amount allocated to it')
  })

  test('the allocation date is shown when it was selected', () => {
    assert.ok(panel.includes('target.allocatedAt &&'),
      'absent is simply nothing — no total depends on it')
    assert.ok(panel.includes('Allocated {fmtDate(target.allocatedAt)}'))
  })

  test('the totals reconcile the lines to the payment', () => {
    assert.ok(panel.includes('formatMoney(summary.allocated)'), 'total of all allocations')
    assert.ok(panel.includes('formatMoney(summary.unallocated)'), 'and what is left')
  })

  test('ZERO ALLOCATED gets an empty state, and still states the figure', () => {
    assert.ok(panel.includes('summary.targets.length === 0'))
    assert.ok(panel.includes('No funds from this payment have been allocated yet.'))
    assert.ok(panel.includes('The whole of {formatMoney(String(amount))} is still free'),
      'the remaining amount is the thing somebody acts on')
  })

  test('OVER-ALLOCATED is called over, never rounded into fully', () => {
    assert.ok(panel.includes("summary.state === 'over' ? 'Over the payment by '"))
    assert.ok(panel.includes("summary.state === 'over' ? colors.red"), 'and shown in red')
  })

  test('a restricted viewer is told the limit of their own sight', () => {
    assert.ok(panel.includes("summary.state === 'unknown'"))
    assert.ok(panel.includes('ALLOCATION_STATE_LABEL.unknown'))
  })
})

// ══ 8. Icons support the labels ══════════════════════════════════════════════

describe('every action carries an icon and keeps its words', () => {
  const menu = view.slice(view.indexOf('function RowActionsMenu'))
  const menuBody = menu.slice(0, menu.indexOf('\n}\n'))

  test('the icons come from the project’s existing library', () => {
    assert.ok(view.includes("from 'lucide-react'"), 'no new icon dependency')
    for (const icon of ['Eye', 'Link2', 'Pencil', 'Split', 'Trash2', 'Unlink']) {
      assert.ok(new RegExp(`\\b${icon}\\b`).test(view), `${icon} is imported`)
    }
  })

  test('each action is paired with the right icon', () => {
    const pairs: [string, string][] = [
      ['ALLOCATE_FUNDS_ACTION_LABEL', 'Split'],
      ["'Link to an Order'", 'Link2'],
      ["'Unlink'", 'Unlink'],
      ["'Edit'", 'Pencil'],
      ['PAYMENT_DELETE_CONFIRM_LABEL', 'Trash2'],
    ]
    for (const [label, icon] of pairs) {
      assert.ok(new RegExp(`label: ${label.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}[^}]*Icon: ${icon}`).test(view),
        `${label} should carry ${icon}`)
    }
    assert.ok(view.includes('<Eye size={13}'), 'View Details takes the eye')
  })

  test('THE ICON SUPPORTS THE LABEL, it does not replace it', () => {
    assert.ok(menuBody.includes('<span>{action.label}</span>'),
      'the text is always rendered')
    assert.ok(menuBody.includes('aria-hidden="true"'),
      'and the glyph is decorative, so it is not announced twice')
  })

  test('labels line up whether or not an action has an icon', () => {
    assert.ok(menuBody.includes("<span aria-hidden=\"true\" style={{ width: 14, flexShrink: 0 }} />"),
      'an icon-less action reserves the same box')
  })

  test('icons are sized consistently and cannot squash', () => {
    assert.ok(menuBody.includes('size={14}'), 'one size inside the menu')
    assert.ok(menuBody.includes('flexShrink: 0'))
  })

  test('the icon-only-adjacent View control keeps a name and a tooltip', () => {
    assert.ok(view.includes('title={`View details for ${r.human_payment_id ?? \'this payment\'}`}'))
    assert.ok(view.includes('aria-label={`View details for ${r.human_payment_id ?? \'this payment\'}`}'))
  })

  test('the danger entry keeps its contract: red text, red hover', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    assert.ok(css.includes('.boe-menu-item--danger {'))
    assert.ok(css.slice(css.indexOf('.boe-menu-item--danger:hover')).startsWith('.boe-menu-item--danger:hover'))
    assert.ok(view.includes('danger: true, Icon: Trash2'),
      'Delete keeps both its danger marker and its icon')
  })
})

// ══ 9. Mobile cards follow the same priority ═════════════════════════════════

describe('the mobile card matches the table’s information order', () => {
  const cards = view.slice(view.indexOf('function ReceivedPaymentsCards'))
  const body = cards.slice(0, cards.indexOf('\n}\n'))

  test('Payment ID leads and the customer is not a card field', () => {
    assert.ok(!body.includes('<CustomerName'),
      'the customer name belongs to the modal, whole, not to a truncating card line')
    assert.ok(body.includes('{r.human_payment_id}'))
  })

  test('the fields appear in the required order', () => {
    const order = ['r.human_payment_id', 'fmtAmount(r.amount)', 'fmtDate(r.payment_date)',
                   'PAYMENT_MODE_LABEL[r.payment_mode]', '<ConfirmedAllocationBadge',
                   'conciseName(r.submitted_by_name)', 'conciseName(r.approved_by_name)']
    let cursor = -1
    for (const marker of order) {
      const at = body.indexOf(marker, cursor + 1)
      assert.ok(at > cursor, `${marker} must appear, after the field before it`)
      cursor = at
    }
  })

  test('the badge opens the SAME modal on mobile', () => {
    assert.ok(/<ConfirmedAllocationBadge[\s\S]{0,200}?onOpen=\{\(\) => onView\(r\)\}/.test(body))
    assert.ok(/<ConfirmedAllocationBadge[\s\S]{0,200}?paymentId=\{r\.human_payment_id\}/.test(body))
  })

  test('the inline actions survive, with matching icons and their labels', () => {
    assert.ok(body.includes('{ALLOCATE_FUNDS_ACTION_LABEL}') && body.includes('<Split size={13}'))
    assert.ok(body.includes('{PAYMENT_DELETE_CONFIRM_LABEL}') && body.includes('<Trash2 size={13}'))
    assert.ok(!body.includes('RowActionsMenu'), 'cards keep inline buttons, not a dropdown')
  })

  test('the card no longer computes figures it does not draw', () => {
    assert.ok(!body.includes('const figures = confirmedFigures(r)'),
      'the exact figures moved to the modal; the card must not compute them for nothing')
  })
})

// ══ 10. No new database work ═════════════════════════════════════════════════

describe('this is a presentation change, and costs no extra request', () => {
  test('the allocation read is still ONE batched query per page load', () => {
    assert.ok(view.includes(".in('payment_request_id', rows.map(r => r.id))"),
      'batched across the page, never per row')
    const perRow = /rows\.map\([\s\S]{0,400}?\.from\('finance_payment_allocations'\)/
    assert.ok(!perRow.test(view), 'no allocation read may sit inside a row loop')
  })

  test('the allocation date rides the SAME select — one more column, not one more call', () => {
    const reads = (view.match(/\.from\('finance_payment_allocations'\)/g) ?? []).length
    assert.equal(reads, 2, 'the page-load read and refreshOneRow’s single-row read — unchanged')
    assert.equal((view.match(/allocated_amount, status, order_id, order_submission_id, created_at/g) ?? []).length, 2,
      'created_at was added to both existing selects rather than fetched separately')
  })

  test('the modal fetches nothing of its own for the new fields', () => {
    // Payment ID, customer, both people and the status all come from the row
    // the list already holds.
    const modal = view.slice(view.indexOf('function DetailsModal'),
                             view.indexOf('function EditPaymentModal'))
    for (const field of ['r.human_payment_id', 'r.client_name', 'r.submitted_by_name',
                         'r.approved_by_name', 'r.confirmed_allocation_status']) {
      assert.ok(modal.includes(field), `${field} is read from the row in hand`)
    }
  })

  test('opening the badge triggers no query at all', () => {
    const badge = view.slice(view.indexOf('function ConfirmedAllocationBadge'))
    const body = badge.slice(0, badge.indexOf('\n}\n'))
    for (const call of ['.from(', '.rpc(', 'fetch(']) {
      assert.ok(!body.includes(call), `${call} must not appear in a badge`)
    }
  })
})

// ══ 11. Permission gates are exactly as they were ════════════════════════════

describe('nothing about who may do what has moved', () => {
  test('each action keeps its own gate at the call site', () => {
    assert.ok(view.includes('const offerAllocate = canAllocate && canOfferAllocateFunds(r)'))
    assert.ok(view.includes('...(canManage && !r.order_id'), 'linking is manage-only, unlinked only')
    assert.ok(view.includes('...(canManage\n'), 'edit is manage-only')
    assert.ok(view.includes('...(canDeleteRow(r)'), 'deletion keeps its admin-only gate')
  })

  test('the badge confers nothing — it opens a record, it does not act on one', () => {
    const badge = view.slice(view.indexOf('function ConfirmedAllocationBadge'))
    const body = badge.slice(0, badge.indexOf('\n}\n'))
    for (const gate of ['canManage', 'canAllocate', 'canDeleteRow', 'isAdmin', 'role ===']) {
      assert.ok(!body.includes(gate), `a status badge must not reference ${gate}`)
    }
  })

  test('the menu still decides no permission of its own', () => {
    const menu = view.slice(view.indexOf('function RowActionsMenu'))
    const body = menu.slice(0, menu.indexOf('\n}\n'))
    for (const gate of ['canManage', 'canAllocate', 'canDeleteRow', 'isAdmin', 'profile']) {
      assert.ok(!body.includes(gate), `RowActionsMenu must not reference ${gate}`)
    }
  })
})
