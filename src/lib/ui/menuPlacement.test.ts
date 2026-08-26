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
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { placeMenu, MENU_GAP, MENU_MARGIN } from './menuPlacement'
import {
  CONFIRMED_ALLOCATION_BADGE,
  CONFIRMED_ALLOCATION_FILTERS,
  CONFIRMED_ALLOCATION_STATUSES,
  CONFIRMED_PAYMENT_COLUMNS,
} from '@/lib/finance/paymentSurfaces'
import {
  ROW_ACTION_KEYS,
  visibleRowActions,
  actionGroupWidthPx,
  actionsColumnWidthPx,
  maxSimultaneousRowActions,
  ACTIONS_COLUMN_WIDTH_PX,
  ROW_ACTION_TARGET_PX,
  ROW_ACTION_GAP_PX,
  TABLE_CELL_PADDING_X_PX,
} from '@/lib/finance/rowActions'
import type { RowActionKey } from '@/lib/finance/rowActions'

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
    // Confirmed Payments draws its actions as DIRECT icon buttons now, so the
    // gate moved from a menu-entry spread to a JSX guard — the CONDITION is
    // unchanged, which is what this asserts.
    assert.ok(view.includes('{offerAllocate && ('))
    assert.ok(view.includes('const offerAllocate = canAllocate && canOfferAllocateFunds(r)'),
      'still permission-derived at the call site')
  })

  test('the manage-only action is still gated on canManage', () => {
    // The conditions moved into visibleRowActions(); these assert the FUNCTION,
    // which is stronger than matching the JSX that used to hold them.
    const base = { offerAllocate: false, canDelete: false }
    assert.ok(!visibleRowActions({ ...base, canManage: false }).includes('edit'))
    assert.ok(visibleRowActions({ ...base, canManage: true }).includes('edit'),
      'editing a recorded payment is the finance.manage authority')
  })

  test('the destructive action is still admin-gated and still last', () => {
    const base = { offerAllocate: true, canManage: true }
    assert.ok(!visibleRowActions({ ...base, canDelete: false }).includes('delete'))
    const withDelete = visibleRowActions({ ...base, canDelete: true })
    assert.ok(withDelete.includes('delete'))
    assert.equal(withDelete[withDelete.length - 1], 'delete',
      'Delete is drawn after every other action')
    assert.ok(view.includes('danger: true'), 'and keeps its danger marker')
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

  test('Payments to Verify KEEPS the shared menu; Confirmed Payments no longer uses it', () => {
    // The portalled, collision-aware menu is not deleted — it is still the right
    // control for a table whose only action is Edit, and every assertion about
    // its placement above still applies to it there.
    assert.equal((view.match(/<RowActionsMenu/g) ?? []).length, 1,
      'exactly one caller left: the Payments to Verify table')
    const toVerify = view.slice(view.indexOf('function PaymentsToVerifyTable'))
    assert.ok(toVerify.slice(0, toVerify.indexOf('\n}\n')).includes('<RowActionsMenu'),
      'and that caller is Payments to Verify')
    assert.ok(view.includes('function RowActionsMenu'), 'the component itself survives')
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

// ══ 3b. Four actions, and the column is sized for exactly those ══════════════
//
// The Actions column was sized from a count made by eye twice, and was wrong
// both times: "six 24px icons fit the 110px column" (6x24 + 5x2 = 154, before
// any cell padding), then "the maximum is five, Link and Unlink being mutually
// exclusive" (they were not). Both counts are now moot — Link and Unlink are
// gone entirely, because one payment could point at only one Order and so
// could not express a partial attachment, a split across records, a mixed
// PI-Draft/Order division, or a remaining balance. Allocation expresses all
// five and is the single attachment workflow.
//
// So nothing below restates a number. Each assertion either COMPUTES the width
// from the visibility rules, or reads the declared width back out of the column
// definition and compares the two.

describe('Link and Unlink are gone from every active Finance surface', () => {
  const SURFACES = [
    'src/app/finance/received/ReceivedPaymentsView.tsx',
    'src/app/finance/page.tsx',
    'src/app/finance/received/AllocateFundsModal.tsx',
    'src/app/finance/received/AllocatePaymentModal.tsx',
    'src/app/finance/received/RecordSplitPaymentModal.tsx',
    'src/app/finance/components/PaymentEntryFields.tsx',
    'src/lib/finance/rowActions.ts',
    'src/lib/finance/paymentSurfaces.ts',
  ]

  test('no action key, icon or handler survives in the action model', () => {
    assert.deepEqual([...ROW_ACTION_KEYS], ['view', 'allocate', 'edit', 'delete'],
      'the whole action set, and neither link nor unlink is in it')
    const rules = readFileSync(join(process.cwd(), 'src/lib/finance/rowActions.ts'), 'utf8')
    const code = stripComments(rules)
    for (const gone of ['Link2', 'Unlink', "'link'", "'unlink'", 'orderId', 'orderRequestId', 'paymentAgainst']) {
      assert.equal(code.includes(gone), false,
        `rowActions.ts must not still model ${gone}`)
    }
  })

  test('no Link2 or Unlink icon is imported or drawn anywhere in Finance', () => {
    for (const path of SURFACES) {
      const code = stripComments(readFileSync(join(process.cwd(), path), 'utf8'))
      assert.equal(/\bLink2\b/.test(code), false, `${path} must not draw the Link2 icon`)
      assert.equal(/\bUnlink\b/.test(code), false, `${path} must not draw the Unlink icon`)
    }
  })

  test('no link/unlink modal, state or handler remains without a caller', () => {
    const code = stripComments(view)
    for (const gone of [
      'function LinkOrderModal', 'LinkOrderModal', 'LinkTarget',
      'linkRequest', 'setLinkRequest',
      'unlinkTarget', 'setUnlinkTarget', 'unlinkReason', 'unlinkError',
      'handleUnlink', 'onLink', 'onUnlink',
    ]) {
      assert.equal(code.includes(gone), false, `${gone} must not survive`)
    }
    // An orphan is as bad as a caller: a modal nothing opens is dead weight
    // that the next reader has to prove is dead.
    assert.equal(code.includes('Unlink Payment?'), false, 'no unlink dialog title')
    assert.equal(code.includes('Yes, Unlink'), false, 'no unlink confirm button')
  })

  test('no interface tells a reader to link or unlink a payment', () => {
    // Copy, not code — the two are separate failures and this is the one a
    // user would actually see.
    for (const path of [...SURFACES, 'src/app/admin/control-center/action-queue/page.tsx']) {
      const code = stripComments(readFileSync(join(process.cwd(), path), 'utf8'))
      for (const phrase of ['Link / Unlink', 'Link to an Order', 'Link suspense', 'Unlinking', 'Managed by Link']) {
        assert.equal(code.includes(phrase), false, `${path} must not say "${phrase}"`)
      }
    }
  })

  test('neither link RPC has a caller left in the app', () => {
    // The DATABASE functions survive — retiring a UI is not a migration — so
    // this asserts no call site, not that the name is never written down.
    for (const path of SURFACES) {
      const code = readFileSync(join(process.cwd(), path), 'utf8')
      assert.equal(code.includes(".rpc('link_finance_payment_to_order"), false, path)
      assert.equal(code.includes(".rpc('unlink_finance_payment_from_order"), false, path)
    }
  })

  test('the Action Queue generates ONLY action=allocate', () => {
    const queue = readFileSync(join(process.cwd(), 'src/app/admin/control-center/action-queue/page.tsx'), 'utf8')
    assert.equal(queue.includes('action=link'), false, 'the old deep link is gone')
    assert.ok(queue.includes('action=allocate'), 'and it points at allocation instead')
    assert.ok(queue.includes("actionLabel: 'Allocate suspense payment'"),
      'and says so in the row the reader clicks')
    // Every action= this file emits, whatever the category.
    const emitted = [...stripComments(queue).matchAll(/action=([a-z]+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(emitted)], ['allocate'],
      'no other action parameter may be generated from this queue')
  })

  test('NOTHING in the app generates an action=link URL', () => {
    // Repo-wide, not just this queue: a notification builder or a nav helper
    // could reintroduce it just as easily.
    const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
      .split('\n').filter(f => /\.tsx?$/.test(f) && !f.includes('.test.'))
    for (const f of files) {
      const code = stripComments(readFileSync(join(process.cwd(), f), 'utf8'))
      assert.equal(code.includes('action=link'), false, `${f} must not build an action=link URL`)
      assert.equal(code.includes("action: 'link'"), false, `${f} must not name a link action`)
    }
  })

  test('no application code calls a legacy Link or Unlink RPC', () => {
    const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
      .split('\n').filter(f => /\.tsx?$/.test(f) && !f.includes('.test.'))
    for (const f of files) {
      const code = readFileSync(join(process.cwd(), f), 'utf8')
      assert.equal(code.includes(".rpc('link_finance_payment"), false, `${f} calls a link RPC`)
      assert.equal(code.includes(".rpc('unlink_finance_payment"), false, `${f} calls an unlink RPC`)
    }
  })

  test('?action=allocate is the ONLY deep link that opens Allocate Funds', () => {
    const code = stripComments(view)
    assert.ok(code.includes("action === 'allocate' && caps.canAllocatePayment && canOfferAllocateFunds(match)"),
      'allocate opens the modal, re-gated on permission AND allocatable balance')
    assert.equal(/action === 'link'/.test(code), false,
      'and `link` is not accepted — reinterpreting one action as another would ' +
      'open a modal the URL did not ask for')
    assert.equal(code.includes('wantsAllocate'), false, 'no alias variable survives')
  })

  test('an unrecognised action falls through to the ordinary page', () => {
    // An old ?action=link URL is simply not an action this page knows. It must
    // land on the list — highlighted, or opened read-only when the row is on
    // another page — never on a modal chosen for it.
    const code = stripComments(view)
    const at = code.indexOf("action === 'allocate' && caps.canAllocatePayment")
    const chain = code.slice(at, code.indexOf('// Drop the deep-link params', at))
    assert.ok(chain.includes("action === 'edit' || action === 'allocate'"),
      'only the two known actions reach the read-only fallback branch')
    assert.ok(chain.includes('} else if (!onThisPage) {'),
      'and anything else reaches the plain highlight/open branch')
  })
})

describe('Allocate Funds is the only attachment workflow, and is unchanged', () => {
  test('its permission and balance conditions are untouched', () => {
    assert.ok(view.includes('const offerAllocate = canAllocate && canOfferAllocateFunds(r)'),
      'still permission-derived at the call site')
    assert.ok(view.includes("return r.confirmed_allocation_status === 'zero' || r.confirmed_allocation_status === 'partial'"),
      "and still offered only where there is balance to allocate — never on 'full' or 'over'")
    assert.ok(visibleRowActions({ offerAllocate: true, canManage: false, canDelete: false }).includes('allocate'),
      'allocation does not require finance.manage')
    assert.ok(!visibleRowActions({ offerAllocate: false, canManage: true, canDelete: true }).includes('allocate'),
      'and finance.manage does not grant it')
  })

  test('full, partial, multi-target and mixed allocation all still reach one atomic call', () => {
    const modal = readFileSync(join(process.cwd(), 'src/app/finance/received/AllocateFundsModal.tsx'), 'utf8')
    assert.ok(modal.includes('allocate_payment_to_targets'),
      'still the multi-target RPC, not a loop of single writes')
    assert.equal((modal.match(/\.rpc\(/g) ?? []).length, 1,
      'exactly one RPC call — the allocation stays atomic')
    assert.ok(modal.includes('searchAllocationTargets'),
      'and the target picker is the shared one')
    // The shared picker is what makes a MIXED PI-Draft/Order division possible.
    const picker = readFileSync(join(process.cwd(), 'src/app/finance/received/AllocatePaymentModal.tsx'), 'utf8')
    assert.ok(picker.includes("from('orders')") && picker.includes("from('order_submissions')"),
      'both target kinds are still searchable, so a mixed division is still possible')
    // Several rows in one call is what makes a MULTI-TARGET allocation possible.
    assert.ok(modal.includes('toRpcAllocations'), 'the rows are sent as a set')
    assert.ok(modal.includes('duplicateTargetKeys'), 'and the same target cannot be named twice')
  })

  test('no allocation read or write changed shape, and nothing became an N+1', () => {
    // The allocation figures still ride ONE batched .in() per page load.
    const batched = (view.match(/\.in\('payment_request_id'/g) ?? []).length
    assert.ok(batched >= 1, 'the batched allocation read survives')
    const perRow = stripComments(view).match(/rows\.map\([^)]*await/g) ?? []
    assert.equal(perRow.length, 0, 'no per-row await crept in')
  })
})

describe('the widest possible action group fits the declared Actions width', () => {
  test('the maximum is derived from the rules, not from a literal', () => {
    const max = maxSimultaneousRowActions()
    const byHand = Math.max(...allInputs().map(i => visibleRowActions(i).length))
    assert.equal(max, byHand,
      'the exhaustive search agrees with an independent sweep of the same rules')
    assert.equal(max, 4, 'four actions, which is the whole set')
    assert.equal(max, ROW_ACTION_KEYS.length,
      'every action is independently reachable, so the maximum IS the action count')
  })

  test('an Admin row with every action eligible fits the column on one line', () => {
    const adminRow = { offerAllocate: true, canManage: true, canDelete: true }
    const actions = visibleRowActions(adminRow)
    assert.deepEqual(actions, ['view', 'allocate', 'edit', 'delete'],
      'View, Allocate Funds, Edit, Delete — in the order they are drawn')
    const needed = actionsColumnWidthPx(actions.length)
    assert.ok(needed <= ACTIONS_COLUMN_WIDTH_PX,
      `the widest Admin row needs ${needed}px and the column declares ${ACTIONS_COLUMN_WIDTH_PX}px`)
  })

  test('NO reachable row can need more width than the column declares', () => {
    for (const input of allInputs()) {
      const needed = actionsColumnWidthPx(visibleRowActions(input).length)
      assert.ok(needed <= ACTIONS_COLUMN_WIDTH_PX,
        `${JSON.stringify(input)} needs ${needed}px > ${ACTIONS_COLUMN_WIDTH_PX}px`)
    }
    assert.equal(ACTIONS_COLUMN_WIDTH_PX,
      actionsColumnWidthPx(maxSimultaneousRowActions()),
      'the declared width IS the computed width — it is not a hand-picked number')
  })

  test('the arithmetic is targets, gaps and cell padding — nothing rounded away', () => {
    assert.equal(actionGroupWidthPx(0), 0, 'no icons, no group')
    assert.equal(actionGroupWidthPx(1), ROW_ACTION_TARGET_PX, 'one icon, no gaps')
    assert.equal(actionGroupWidthPx(4),
      4 * ROW_ACTION_TARGET_PX + 3 * ROW_ACTION_GAP_PX,
      'four targets and the three gaps between them')
    assert.equal(actionsColumnWidthPx(4),
      actionGroupWidthPx(4) + 2 * TABLE_CELL_PADDING_X_PX,
      'plus the cell padding on BOTH sides — the padding is what the first count dropped')
    assert.equal(ACTIONS_COLUMN_WIDTH_PX, 4 * 28 + 3 * 2 + 2 * 10,
      'which is 138px')
  })

  test('the column is no longer sized for the six obsolete actions', () => {
    // 198px was the six-action width. Carrying it forward would leave a wide
    // empty gutter beside four icons — the table has to take the room back.
    assert.ok(ACTIONS_COLUMN_WIDTH_PX < 198,
      'the six-action width must not survive the actions it was sized for')
    assert.equal(ACTIONS_COLUMN_WIDTH_PX, 138)
    assert.ok(actionsColumnWidthPx(6) > ACTIONS_COLUMN_WIDTH_PX,
      'and six icons would no longer fit, which is correct — there are only four')
  })

  test('the target is big enough to click and the CSS agrees', () => {
    assert.ok(ROW_ACTION_TARGET_PX >= 28 && ROW_ACTION_TARGET_PX <= 30,
      'a 28-30px square: comfortable to hit, still a table row and not a toolbar')
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const rule = css.slice(css.indexOf('.boe-icon-action'))
    const body = rule.slice(0, rule.indexOf('}'))
    assert.ok(body.includes(`${ROW_ACTION_TARGET_PX}px`),
      'the rendered square matches the square the arithmetic assumed')
  })

  test('the column definition carries the computed width, not a copy of it', () => {
    const actions = CONFIRMED_PAYMENT_COLUMNS.find(c => c.key === 'actions')
    assert.ok(actions, 'the Actions column still exists')
    assert.equal(actions.width, `${ACTIONS_COLUMN_WIDTH_PX}px`,
      'declared width tracks the computed one')
    const surfaces = readFileSync(join(process.cwd(), 'src/lib/finance/paymentSurfaces.ts'), 'utf8')
    assert.ok(surfaces.includes('${ACTIONS_COLUMN_WIDTH_PX}px'),
      'and it INTERPOLATES the constant rather than hard-coding the pixels')
    const actionsLine = surfaces.split('\n').find(l => l.includes("key: 'actions'")) ?? ''
    assert.equal(/\d+px'/.test(actionsLine), false,
      'the Actions row must carry no literal pixel width of its own')
  })

  test('the icon row cannot wrap, scroll or overflow its cell', () => {
    const table = stripComments(view.slice(view.indexOf('function ReceivedPaymentsTable')))
    const body = table.slice(0, table.indexOf('\n}\n'))
    const group = body.slice(body.indexOf('visibleRowActions({'))
    const container = body.slice(0, body.indexOf('visibleRowActions({'))
    const wrapper = container.slice(container.lastIndexOf('<div'))
    assert.ok(wrapper.includes("flexWrap: 'nowrap'"),
      'the icon row is pinned to one line — it never wraps to a second')
    assert.ok(wrapper.includes("display: 'inline-flex'"),
      'and it is a single flex row, not a grid that could reflow')
    assert.ok(!wrapper.includes('overflow'),
      'not made to scroll either — the column is declared wide enough instead')
    assert.ok(group.startsWith('visibleRowActions({'),
      'and the icons it holds come from the shared rule set the width was computed from')
  })

  test('the call site passes capabilities only — no linkage fields survive it', () => {
    const table = stripComments(view.slice(view.indexOf('function ReceivedPaymentsTable')))
    const call = table.slice(table.indexOf('visibleRowActions({'))
    const args = call.slice(0, call.indexOf('})'))
    for (const gone of ['orderId', 'orderRequestId', 'paymentAgainst']) {
      assert.equal(args.includes(gone), false,
        `the visible-action model must not read ${gone} any more`)
    }
    for (const kept of ['offerAllocate', 'canManage', 'canDelete']) {
      assert.ok(args.includes(kept), `${kept} is still what decides the row`)
    }
  })

  test('non-Admin rows show only their permitted actions, and stay narrower', () => {
    const readOnly = { offerAllocate: false, canManage: false, canDelete: false }
    assert.deepEqual(visibleRowActions(readOnly), ['view'],
      'a viewer with no capabilities sees View and nothing else')

    const financeNoDelete = { offerAllocate: true, canManage: true, canDelete: false }
    const finance = visibleRowActions(financeNoDelete)
    assert.ok(!finance.includes('delete'), 'Delete stays admin-only')
    assert.deepEqual(finance, ['view', 'allocate', 'edit'])

    const fullyAllocatedAdmin = { offerAllocate: false, canManage: true, canDelete: true }
    assert.deepEqual(visibleRowActions(fullyAllocatedAdmin), ['view', 'edit', 'delete'],
      'a fully allocated row offers no Allocate, even to an Admin')

    for (const input of [readOnly, financeNoDelete, fullyAllocatedAdmin]) {
      assert.ok(actionsColumnWidthPx(visibleRowActions(input).length) < ACTIONS_COLUMN_WIDTH_PX,
        'a restricted row needs strictly less width than the Admin worst case')
    }
  })
})

/** Source with comments removed, so an assertion about the CODE is never
 *  satisfied by a comment that happens to mention the thing. */
function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Every combination the visibility rules can distinguish. */
function allInputs() {
  const out = []
  for (const offerAllocate of [false, true])
    for (const canManage of [false, true])
      for (const canDelete of [false, true])
        out.push({ offerAllocate, canManage, canDelete })
  return out
}


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

  test('the menu styling still serves its one remaining caller', () => {
    assert.equal((view.match(/<RowActionsMenu/g) ?? []).length, 1,
      'Payments to Verify')
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
                   '<IconAction']
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

  test('THE LEGACY EXPANDABLE ROW IS GONE, chevron and all', () => {
    // THE DEFECT: a chevron column sat BEFORE Payment ID, so the required first
    // column was second, and it opened a strip under the row duplicating what
    // the detail modal now shows. Allocation detail is reached by the
    // Allocation Status badge or by View — those two, and nothing else.
    assert.ok(!table.includes('▶'), 'no expansion chevron in the table')
    assert.ok(!table.includes('Expand allocation breakdown'))
    assert.ok(!table.includes('Collapse allocation breakdown'))
    assert.ok(!table.includes('colSpan'), 'no full-width detail row remains')
    assert.ok(!/isExpanded|const \[expanded/.test(table), 'no expansion state')
    assert.ok(!table.includes('CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS'),
      'the breakdown does not render in the table any more')
  })

  test('and its figures moved into the modal rather than being dropped', () => {
    const modal = view.slice(view.indexOf('function DetailsModal'),
                             view.indexOf('function EditPaymentModal'))
    assert.ok(modal.includes('CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS.map'))
    assert.ok(modal.includes('modalFigures.toPI') && modal.includes('modalFigures.toOrders'))
    assert.ok(modal.includes('const modalFigures = confirmedFigures(r)'),
      'computed from the row already in hand — pure, no query')
  })

  test('PAYMENT ID IS THE FIRST COLUMN AND THE FIRST CELL', () => {
    assert.equal(CONFIRMED_PAYMENT_COLUMNS[0].key, 'payment_id')
    // Nothing is rendered between <tr> and the Payment ID cell.
    const row = table.slice(table.indexOf('id={`payment-row-${r.id}`}'))
    const firstCell = row.indexOf('<td')
    const paymentId = row.indexOf('{r.human_payment_id}')
    const gap = row.slice(firstCell, paymentId)
    assert.ok(paymentId > firstCell, 'the id is in a cell')
    assert.ok(!gap.includes('</td>'),
      'the FIRST cell of the row is the Payment ID cell — no chevron cell before it')
    // And no leading spacer header either. Matched on the CHEVRON header
    // specifically — `aria-hidden` on its own is legitimate and appears on
    // every decorative action icon.
    assert.ok(!/<th[^>]*width: '28px'[^>]*aria-hidden/.test(table),
      'the empty chevron header column is gone')
    const head = table.slice(table.indexOf('<thead>'), table.indexOf('</thead>'))
    assert.ok(!head.includes('<th style={{ ...TH, width:'),
      'the header row starts with the mapped columns, nothing before them')
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
    assert.ok(body.includes('const chip: React.CSSProperties'),
      'one chip style serves the inert and the clickable badge')
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
    for (const icon of ['Eye', 'Pencil', 'Split', 'Trash2']) {
      assert.ok(new RegExp(`\\b${icon}\\b`).test(view), `${icon} is imported`)
    }
    // The two that went with Link and Unlink must not linger as dead imports.
    for (const icon of ['Link2', 'Unlink']) {
      assert.equal(new RegExp(`\\b${icon}\\b`).test(view), false,
        `${icon} must not still be imported`)
    }
  })

  test('each Confirmed Payments action is a direct button with the right icon', () => {
    // ROW_ACTION_META is one entry per action: its icon, its label, what it
    // runs. visibleRowActions() decides which are drawn.
    const meta = view.slice(view.indexOf('const ROW_ACTION_META'))
    const block = meta.slice(0, meta.indexOf('\n  }\n'))
    const pairs: [RowActionKey, string, string][] = [
      ['view',     'Eye',    'View details for'],
      ['allocate', 'Split',  'ALLOCATE_FUNDS_ACTION_LABEL'],
      ['edit',     'Pencil', 'Edit '],
      ['delete',   'Trash2', 'PAYMENT_DELETE_CONFIRM_LABEL'],
    ]
    assert.equal(pairs.length, ROW_ACTION_KEYS.length,
      'one pair per action — an action added without an icon fails here')
    for (const [key, icon, labelFragment] of pairs) {
      const at = block.indexOf(`${key}: {`)
      assert.ok(at > -1, `${key} must have an entry`)
      const entry = block.slice(at, at + 320)
      assert.ok(entry.includes(`Icon: ${icon}`), `${key} should take ${icon}`)
      assert.ok(entry.includes(labelFragment),
        `${key} should be labelled with "${labelFragment}"`)
    }
    // Every key the predicate can return has an entry — no action can be chosen
    // and then fail to draw.
    for (const key of ROW_ACTION_KEYS) {
      assert.ok(block.includes(`${key}: {`), `${key} must be renderable`)
    }
    // The Payments to Verify menu keeps its own icon.
    assert.ok(view.includes("{ label: 'Edit', onSelect: () => onEdit(r), Icon: Pencil }"),
      'the remaining menu entry keeps its icon')
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

  test('EVERY icon-only control is named twice over', () => {
    // The glyph is the whole control, so nothing else names it: aria-label for a
    // screen reader, title for a pointer. IconAction applies both from one prop,
    // so no call site can forget one.
    const icon = view.slice(view.indexOf('function IconAction'))
    const body = icon.slice(0, icon.indexOf('\n}\n'))
    assert.ok(body.includes('aria-label={label}'))
    assert.ok(body.includes('title={label}'))
    assert.ok(body.includes('aria-hidden="true"'), 'and the glyph itself is not announced')
    // Every label names the PAYMENT, not just the verb.
    const meta = view.slice(view.indexOf('const ROW_ACTION_META'))
    const block = meta.slice(0, meta.indexOf('\n  }\n'))
    const labels = [...block.matchAll(/label: r => `([^`]+)`/g)].map(m => m[1])
    assert.equal(labels.length, ROW_ACTION_KEYS.length, 'one label per action')
    for (const label of labels) {
      assert.ok(label.includes('human_payment_id'),
        `"${label}" must name the payment, so forty identical glyphs are distinguishable`)
    }
  })

  test('the danger action keeps its contract: red text, red hover', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    // The menu entry's rule still exists for Payments to Verify's menu...
    assert.ok(css.includes('.boe-menu-item--danger {'))
    // ...and the icon button has its own, using the same established red.
    assert.ok(css.includes('.boe-icon-action--danger {'))
    const rule = css.slice(css.indexOf('.boe-icon-action--danger:hover:not(:disabled),'))
    assert.ok(rule.slice(0, rule.indexOf('}')).includes('rgba(217,79,79,0.14)'),
      'the same red .boe-btn-danger:hover uses')
    const meta = view.slice(view.indexOf('const ROW_ACTION_META'))
    assert.ok(/delete: \{[\s\S]{0,320}?Icon: Trash2[\s\S]{0,320}?danger: true/.test(meta),
      'Delete keeps both its icon and its danger marker')
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
  test('each action keeps its own gate, and the row supplies every one of them', () => {
    // The capabilities are still resolved at the call site and handed in; the
    // predicate decides nothing about permission on its own.
    assert.ok(view.includes('const offerAllocate = canAllocate && canOfferAllocateFunds(r)'))
    assert.ok(view.includes('canDelete: canDeleteRow(r)'), 'deletion keeps its admin-only gate')
    assert.ok(view.includes('canManage,'), 'manage is passed through')
    // The linkage inputs went with the actions that read them: a row's actions
    // no longer depend on which record the payment points at.
    assert.equal(view.includes('paymentAgainst: r.payment_against'), false)
    assert.equal(view.includes('orderId: r.order_id'), false)
    assert.equal(view.includes('orderRequestId: r.order_request_id'), false)
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

// ══ 12. The compact allocation control ═══════════════════════════════════════

describe('the allocation status reads as a status, not a button', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
  const badge = view.slice(view.indexOf('function ConfirmedAllocationBadge'))
  const body = badge.slice(0, badge.indexOf('\n}\n'))

  test('the coloured chip sits at the table’s own muted typography', () => {
    // IT WAS TOO BIG: an 11px chip with 2px/8px padding read as a button
    // competing with the figures beside it, in a table whose muted text is 11px
    // and whose cells are 12px.
    const chip = body.slice(body.indexOf('const chip:'), body.indexOf('if (!onOpen)'))
    assert.ok(chip.includes("fontSize: '10.5px'"), 'smaller than the row’s own text')
    assert.ok(chip.includes("padding: '1px 6px'"), 'and barely padded')
    assert.ok(chip.includes("borderRadius: '4px'"))
  })

  test('but the TARGET did not shrink with it', () => {
    // The wrapper is transparent and carries the extra pixels, with a negative
    // margin so the bigger hit area costs the cell no extra width.
    const rule = css.slice(css.indexOf('.boe-allocation-badge {'))
    const decls = rule.slice(0, rule.indexOf('}'))
    assert.ok(decls.includes('padding: 3px'), 'the button is bigger than its chip')
    assert.ok(decls.includes('margin: -3px'), 'without pushing the column wider')
    assert.ok(decls.includes('background: none') && decls.includes('border: none'),
      'and is invisible around it')
  })

  test('every status keeps its own colour, and none wraps', () => {
    const chip = body.slice(body.indexOf('const chip:'), body.indexOf('if (!onOpen)'))
    assert.ok(chip.includes('background: style.bg'))
    assert.ok(chip.includes('color: style.color'))
    assert.ok(chip.includes('border: `1px solid ${style.border}`'))
    assert.ok(chip.includes("whiteSpace: 'nowrap'"),
      '"Partially Allocated" must never wrap inside a table cell')
    for (const status of CONFIRMED_ALLOCATION_STATUSES) {
      assert.ok(CONFIRMED_ALLOCATION_BADGE[status], `${status} keeps a badge`)
    }
  })

  test('and it still opens the same modal, from all four statuses', () => {
    assert.ok(body.includes('if (!onOpen) return'),
      'the only branch is whether an opener was given — never which status it is')
    assert.ok(view.includes('onOpen={() => onView(r)}'), 'the same door as View')
    assert.ok(css.includes('.boe-allocation-badge:hover,'))
    assert.ok(css.includes('.boe-allocation-badge:focus-visible {'))
    assert.ok(body.includes('aria-label={`View allocation details for ${paymentId'))
  })
})

// ══ 13. The toolbar ══════════════════════════════════════════════════════════

describe('the toolbar puts narrowing left and the creating action far right', () => {
  const toolbar = view.slice(view.indexOf('{/* ── Toolbar ──'),
                             view.indexOf('{recordNotice &&'))

  test('search and both date bounds share the left group, in that order', () => {
    const left = toolbar.slice(0, toolbar.indexOf("marginLeft: 'auto'"))
    const search = left.indexOf('meta.searchPlaceholder')
    const from = left.indexOf('payment-date-from')
    const to = left.indexOf('payment-date-to')
    assert.ok(search > -1 && from > search && to > from,
      'Search, then Paid From, then Paid To')
    assert.ok(left.includes("flex: '1 1 auto'"), 'the narrowing group takes the slack')
  })

  test('Record Payment is pushed right by layout, not by a hardcoded gap', () => {
    assert.ok(toolbar.includes("marginLeft: 'auto'"),
      'the right group is separated by auto margin')
    assert.ok(!/marginLeft: '\d{2,}px'/.test(toolbar), 'no hardcoded empty margin')
    assert.ok(!toolbar.includes("position: 'absolute'"), 'and nothing is positioned absolutely')
    const rightGroup = toolbar.slice(toolbar.indexOf("marginLeft: 'auto'"))
    assert.ok(rightGroup.includes('RECORD_PAYMENT_ACTION_LABEL'),
      'Record Payment lives in the right group')
  })

  test('the count sits near it but does not compete with it', () => {
    const rightGroup = toolbar.slice(toolbar.indexOf("marginLeft: 'auto'"))
    const count = rightGroup.indexOf('resultSummary(')
    const button = rightGroup.indexOf('RECORD_PAYMENT_ACTION_LABEL')
    assert.ok(count > -1 && button > count, 'the count reads before the button')
    const countBlock = rightGroup.slice(count - 260, count)
    assert.ok(countBlock.includes("fontSize: '11px'") && countBlock.includes('colors.muted'),
      'muted 11px — an answer about the list, not an action')
  })

  test('it wraps rather than overlapping when there is no room', () => {
    assert.ok(toolbar.includes("flexWrap: 'wrap'"))
  })

  test('Record Payment is still gated on the capability that records one', () => {
    assert.ok(toolbar.includes('{caps.canAllocatePayment && ('),
      'unchanged: Finance module entry plus finance.allocate')
  })
})

// ══ 14. The five tabs are the only allocation filter ═════════════════════════

describe('the allocation tabs', () => {
  test('all five are still rendered from the shared list', () => {
    assert.ok(view.includes('CONFIRMED_ALLOCATION_FILTERS.map(f => {'))
    assert.ok(view.includes('role="tablist"') && view.includes('role="tab"'))
    assert.ok(view.includes('CONFIRMED_ALLOCATION_FILTER_LABEL[f]'))
    assert.deepEqual([...CONFIRMED_ALLOCATION_FILTERS],
      ['all', ...CONFIRMED_ALLOCATION_STATUSES])
  })

  test('and they are the ONLY allocation narrowing left', () => {
    const code = view.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.ok(!code.includes('aria-label="Filter by allocation state"'),
      'the duplicate <select> is gone')
    assert.ok(!code.includes('allocationFilterClauses'))
    assert.ok(!code.includes('allocationOffered'))
  })
})

// ══ 15. Nothing regressed from the previous passes ═══════════════════════════

describe('the earlier corrections still hold', () => {
  const table = view.slice(view.indexOf('function ReceivedPaymentsTable'),
                           view.indexOf('function IconAction'))

  test('Payment ID is still the first column and the first cell', () => {
    assert.equal(CONFIRMED_PAYMENT_COLUMNS[0].key, 'payment_id')
    const row = table.slice(table.indexOf('id={`payment-row-${r.id}`}'))
    const firstCell = row.indexOf('<td')
    const paymentId = row.indexOf('{r.human_payment_id}')
    assert.ok(!row.slice(firstCell, paymentId).includes('</td>'),
      'no cell precedes the Payment ID cell')
  })

  test('no expansion chevron or inline breakdown row has returned', () => {
    assert.ok(!table.includes('▶'))
    assert.ok(!table.includes('Expand allocation breakdown'))
    assert.ok(!table.includes('colSpan'))
    assert.ok(!/isExpanded|const \[expanded/.test(table))
  })

  test('Customer, Total Allocated and Remaining are still absent from the table', () => {
    assert.ok(!table.includes('<CustomerName'))
    assert.ok(!table.includes('figures.totalAllocated'))
    assert.ok(!table.includes('value={figures.remaining}'))
  })

  test('and all three are still in the modal', () => {
    const modal = view.slice(view.indexOf('function DetailsModal'),
                             view.indexOf('function EditPaymentModal'))
    assert.ok(modal.includes('{r.client_name}'))
    assert.ok(modal.includes('<AllocationPanel'))
    assert.ok(modal.includes('modalFigures.toPI') && modal.includes('modalFigures.toOrders'))
  })

  test('NO NEW DATABASE REQUEST — and one fewer, now the probe is gone', () => {
    const reads = (view.match(/\.from\('finance_payment_allocations'\)/g) ?? []).length
    assert.equal(reads, 2, 'page-load batched read plus refreshOneRow — unchanged')
    const perRow = /rows\.map\([\s\S]{0,400}?\.from\('finance_payment_allocations'\)/
    assert.ok(!perRow.test(view), 'no allocation read inside a row loop')
    assert.ok(!view.includes('const allocationProbe'), 'the dropdown’s probe query is gone')
    const icon = view.slice(view.indexOf('function IconAction'))
    const body = icon.slice(0, icon.indexOf('\n}\n'))
    for (const call of ['.from(', '.rpc(', 'fetch(']) {
      assert.ok(!body.includes(call), `an icon button must not ${call}`)
    }
  })
})
