/**
 * What a module launcher card shows, and what happens when you activate it.
 *
 * A card is an ICON, ITS NOTIFICATION BADGE AND THE MODULE NAME. Nothing else,
 * at any width. It used to carry a two-line description and a footer holding a
 * spelled-out notification count and "Open →"; on a phone that furniture cost
 * most of the card to restate what the icon, the name and the badge had already
 * said, and the count appeared twice — once on the icon and once underneath.
 *
 * These read the SOURCE rather than render it. The repository has no DOM test
 * harness for a client page of this size, and the facts worth pinning here are
 * structural: which elements exist, which stylesheet rules survive, and that
 * exactly one element carries the navigation handler. A renderer would not tell
 * us any of them more reliably, and a CSS rule it cannot apply it cannot check.
 *
 * Run:
 *   npx tsx --test src/app/modules/moduleCardSurface.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { moduleCardPressProps } from '@/lib/modules/moduleOrder'

const ROOT = process.cwd()
// \r is stripped on read. A rebase or a fresh clone under core.autocrlf can
// hand these files back with CRLF endings, and every multi-line assertion below
// would then look for a substring that is really there.
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

const PAGE = read('src/app/modules/page.tsx')
const CSS = read('src/app/modules/modules.module.css')

/**
 * The body of the FIRST rule named `selector`, wherever it appears.
 *
 * Deliberately not "everything before the first @media": the grid's column
 * steps are min-width queries that now sit between `.grid` and `.card`, so a
 * slice like that would cut the card out of the file. Every base rule is still
 * declared before any block that overrides it, so the first match is the
 * unconditional one.
 */
function baseRule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `${selector} must still exist`)
  return CSS.slice(at, CSS.indexOf('}', at))
}

/** The base `.card` rule, so a match in `.cardEditing` cannot pass for it. */
const DESKTOP_CARD = baseRule('.card')

/** Just the ModuleCard component, so a match elsewhere on the page cannot pass. */
const CARD = (() => {
  const start = PAGE.indexOf('function ModuleCard(')
  assert.notEqual(start, -1, 'ModuleCard must still exist')
  const end = PAGE.indexOf('\nfunction ', start + 1)
  return PAGE.slice(start, end === -1 ? undefined : end)
})()

describe('a card shows the module name and nothing else', () => {
  test('the name is rendered', () => {
    assert.ok(CARD.includes('{mod.title}'), 'the module name is the card')
  })

  test('NO DESCRIPTION IS RENDERED, at any width', () => {
    assert.equal(CARD.includes('{mod.description}'), false,
      'the description must not reach the card')
    assert.equal(CARD.includes('styles.description'), false,
      'and no element may carry the description class')
    // Removed from the MARKUP, not hidden by a rule. A display: none would keep
    // the text in the file and leave a class whose absence is what this suite
    // is really asserting; there is no rule left to unwind at a breakpoint.
    assert.equal(/\.description\b/.test(CSS), false,
      'the stylesheet keeps no .description rule to hide or unhide')
  })

  test('NO "Open" OR "View" FOOTER TEXT IS RENDERED', () => {
    assert.equal(/>\s*Open\b/.test(CARD), false, '"Open" must not appear on a card')
    assert.equal(/>\s*View\b/.test(CARD), false, '"View" must not appear on a card')
    assert.equal(CARD.includes('styles.footer'), false, 'the footer element is gone')
    assert.equal(/\.footer\b/.test(CSS), false, 'and so is every .footer rule')
  })

  test('the description text itself is still DATA, so the registry keeps matching', () => {
    // ModuleDef.description stays on the definitions: the registered module
    // descriptions are asserted against permission_modules and the migrations
    // elsewhere (see src/lib/permissions/imageEditor.test.ts). This change is
    // about what the CARD draws, not about deleting the registry's copy.
    assert.ok(PAGE.includes('description: string'), 'ModuleDef keeps the field')
    assert.ok(PAGE.includes("description: 'Create, assign, and track tasks across your team.'"))
  })
})

describe('the notification badge is unchanged, and is the only count on the card', () => {
  test('a positive count draws a badge and a zero or missing one does not', () => {
    assert.ok(CARD.includes('const hasNotif = (mod.notificationCount ?? 0) > 0'))
    assert.ok(CARD.includes('{hasNotif && ('))
    assert.ok(CARD.includes(styleClass('badge')))
    assert.ok(CARD.includes("{count! > 99 ? '99+' : count}"), '99+ cap is unchanged')
  })

  test('the count is not ALSO spelled out underneath', () => {
    assert.equal(CARD.includes("'No notifications'"), false)
    assert.equal(/notification(s)?\`/.test(CARD), false,
      'the "3 notifications" line went with the footer')
  })

  test('the badge travels with the icon, so centring the icon centres both', () => {
    // .badge is positioned against .iconWrap, and only .iconWrap is centred.
    assert.ok(/\.badge\s*\{[^}]*position:\s*absolute/.test(CSS))
    assert.ok(/\.iconWrap\s*\{[^}]*position:\s*relative/.test(CSS))
  })
})

// ── The root's interactive props ─────────────────────────────────────────────
//
// THESE ASSERTIONS NOW EXECUTE RATHER THAN PATTERN-MATCH, and that is the only
// thing about them that changed.
//
// `role`, `tabIndex` and the key handler used to be written inline on the card
// root and were checked by looking for their text in this file. The personal
// card-order work moved them into moduleCardPressProps (src/lib/modules/
// moduleOrder.ts), because the launcher now has a second mode — while somebody
// is rearranging the grid, a card is NOT a button — and "what makes a card a
// button" became a decision worth running rather than reading.
//
// The header above says these read the source because the repository has no DOM
// harness for a page this size. That reason does not apply to a pure function:
// it can simply be called. So every promise the inline version made is made
// here, of the real props the card spreads, plus the one the second mode adds.
describe('the WHOLE card is one control', () => {
  test('the card root spreads the press props, and adds no handler of its own', () => {
    assert.ok(CARD.includes('const press = moduleCardPressProps(onClick)'),
      'the card must take its interactive props from the one helper')
    assert.ok(CARD.includes('{...press}'), 'and spread them on the root')

    // A SECOND onClick would be a duplicate navigation handler. The helper
    // supplies the only one, so the card itself must declare none.
    const handlers = CARD.match(/onClick=/g) ?? []
    assert.equal(handlers.length, 0,
      'a second onClick would be a duplicate navigation handler')

    // It is on the ROOT: the spread sits on the first element of the returned
    // tree, before the icon wrapper. Everything inside it — the icon, the badge,
    // the name and the empty space around them — therefore activates it.
    assert.ok(CARD.indexOf('{...press}') < CARD.indexOf(styleClass('iconWrap')))
  })

  test('exactly one element carries the navigation handler, and it is that root', () => {
    const press = moduleCardPressProps(() => {})
    assert.equal(typeof press.onClick, 'function')
    // The helper returns a flat set of props for one element. There is no
    // nesting it could distribute a second handler into.
    assert.deepEqual(Object.keys(press).sort(), ['onClick', 'onKeyDown', 'role', 'tabIndex'])
  })

  test('there is no nested link or button inside the card', () => {
    // Comments stripped first: the keyboard handler is explained in prose that
    // names <button>, and that sentence is not an element.
    const markup = CARD.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal(/<a\b/.test(markup), false, 'no anchor may nest inside a role="button"')
    assert.equal(/<button\b/.test(markup), false, 'and no nested button either')
    assert.equal(/<Link\b/.test(markup), false, 'and no next/link')
    const roles = markup.match(/role="/g) ?? []
    assert.equal(roles.length, 0, 'the only role comes from the press props')

    // The drag handle IS a <button>, and it is why this still holds: it is
    // rendered only while the card is NOT a button (the props above are all
    // undefined then), so a control never nests inside a role="button".
    assert.ok(CARD.includes('{handle}'), 'the handle is injected, not declared here')
    assert.equal(moduleCardPressProps(null).role, undefined,
      'a card showing a handle must not also be announced as a button')
  })

  test('the card fills its grid cell, so the empty area is clickable too', () => {
    // The card IS the grid item — the handler is on the element the grid sizes,
    // so there is no inner wrapper that could leave a dead margin around it.
    assert.ok(/\.card\s*\{[^}]*cursor:\s*pointer/.test(CSS))
    assert.ok(/\.card\s*\{[^}]*min-height:/.test(CSS),
      'a min-height gives the empty area real size to be clicked in')
  })
})

describe('keyboard accessibility', () => {
  test('the card is focusable and announced as a button', () => {
    const press = moduleCardPressProps(() => {})
    assert.equal(press.role, 'button')
    assert.equal(press.tabIndex, 0)
  })

  test('BOTH Enter and Space activate it', () => {
    for (const key of ['Enter', ' ']) {
      let opened = 0
      const press = moduleCardPressProps(() => { opened += 1 })
      press.onKeyDown?.({ key, preventDefault: () => {} })
      assert.equal(opened, 1,
        `role="button" promises both, as a native <button> gives both — ${JSON.stringify(key)} did not activate`)
    }
  })

  test('Space does not also scroll the page', () => {
    // Space is the browser's page-scroll key. Without preventDefault, activating
    // a focused card would open the module AND scroll the launcher behind it —
    // and the default must be cancelled BEFORE navigating.
    for (const key of ['Enter', ' ']) {
      const events: string[] = []
      const press = moduleCardPressProps(() => events.push('navigate'))
      press.onKeyDown?.({ key, preventDefault: () => events.push('preventDefault') })
      assert.deepEqual(events, ['preventDefault', 'navigate'],
        `${JSON.stringify(key)}: the default is cancelled before navigating`)
    }
  })

  test('and no other key is swallowed', () => {
    for (const key of ['ArrowDown', 'Tab', 'Escape', 'a']) {
      const events: string[] = []
      const press = moduleCardPressProps(() => events.push('navigate'))
      press.onKeyDown?.({ key, preventDefault: () => events.push('preventDefault') })
      assert.deepEqual(events, [], `${key} belongs to the page`)
    }
  })

  test('while the grid is being rearranged the card is not a button at all', () => {
    // The second mode, and the reason these moved out of the JSX. Not a handler
    // that declines to navigate — no handler, no role, nothing focusable.
    assert.deepEqual(moduleCardPressProps(null), {
      onClick: undefined, role: undefined, tabIndex: undefined, onKeyDown: undefined,
    })
  })
})

describe('a long module name arrives whole', () => {
  test('nothing clamps or ellipsises the title, at any width', () => {
    // "Performance Management" and "Attendance & Payroll" wrap to two lines in
    // a half-width phone column. The name is the only text left on the card, so
    // a clipped one is the single thing that could still leave a card unreadable.
    assert.equal(/-webkit-line-clamp/.test(CSS), false, 'no clamp survives anywhere')
    assert.equal(/text-overflow:\s*ellipsis/.test(CSS), false)
    assert.equal(/\boverflow:\s*hidden/.test(CSS), false)
    assert.ok(/\.title\s*\{[^}]*overflow-wrap:\s*anywhere/.test(CSS),
      'and a single unbroken word still cannot overflow the card')
  })

  test('every min-height is a floor and never a ceiling', () => {
    assert.equal(/max-height/.test(CSS), false,
      'a max-height would cut the card a wrapped name just grew')
    const floors = CSS.match(/min-height:\s*(\d+)px/g) ?? []
    assert.ok(floors.length >= 2, 'the base card and the phone card each have one')
  })

  test('the launcher still reserves a real title for these two', () => {
    assert.ok(PAGE.includes("title: 'Performance Management'"))
    assert.ok(PAGE.includes('Attendance'))
  })
})

describe('the mobile card centres its icon and its name', () => {
  /** The <= 767px block, which is where the centring lives. */
  const SMALL = (() => {
    const at = CSS.indexOf('@media (max-width: 767px)')
    assert.notEqual(at, -1, 'the small-screen block must still exist')
    return CSS.slice(at, CSS.indexOf('@media (max-width: 639px)'))
  })()

  test('the card centres its children and its text', () => {
    assert.ok(/\.card\s*\{[^}]*align-items:\s*center/.test(SMALL))
    assert.ok(/\.card\s*\{[^}]*text-align:\s*center/.test(SMALL))
  })

  test('the icon is centred, which carries the badge with it', () => {
    assert.ok(/\.iconWrap\s*\{[^}]*align-self:\s*center/.test(SMALL))
  })

  test('the name spans the card, so centring it has something to centre in', () => {
    assert.ok(/\.titleWrap\s*\{[^}]*width:\s*100%/.test(SMALL))
  })

  test('the arrow leaves the flow, so a wrapped name keeps the full width', () => {
    // On a desktop the arrow is the third item in a row. On a phone the card is
    // a column, and an arrow left in that flow would either sit under the name
    // or take width from it — so here it comes out of the flow into the corner.
    assert.ok(/\.arrow\s*\{[^}]*position:\s*absolute/.test(SMALL))
  })

  test('DESKTOP IS NOT CENTRED ON THE INLINE AXIS — the centring is scoped here', () => {
    assert.equal(/text-align:\s*center/.test(DESKTOP_CARD), false,
      'the desktop card keeps its left edge')
    // `align-items: center` IS now set on the desktop card, and on a ROW that is
    // the VERTICAL axis: it centres the icon, the name and the arrow against one
    // another. It says nothing about the left edge, which the assertion above is
    // what really guards. The phone card re-declares the card as a COLUMN, where
    // the same property means horizontal — which is why this reads the two
    // directions apart rather than looking for one property name in both.
    assert.ok(/flex-direction:\s*row/.test(DESKTOP_CARD),
      'the desktop card is a row, so align-items is its vertical axis')
    assert.ok(/flex-direction:\s*column/.test(SMALL),
      'and the phone card turns it back into a column')
  })
})

// ── The desktop card is a ROW ────────────────────────────────────────────────
//
// The layout contract this redesign is actually about. The card used to be a
// 132px column — a 56px icon stacked above a name — and once the description
// and the "Open →" footer were removed that left most of a 240px-wide box
// empty. Laid on its side the same two things need 92px, and the grid fits four
// across a wide screen instead of three.
//
// These pin the SHAPE, not the exact numbers: a particular pixel is a design
// call and changing one should not fail a suite. What must not change silently
// is the direction, the order of the three parts, and the fact that the card
// stays compact rather than becoming a tall box with a hole in it again.
describe('the desktop card is a horizontal row: icon, name, arrow', () => {
  test('it is a row, and its three parts are in that order in the markup', () => {
    assert.ok(/flex-direction:\s*row/.test(DESKTOP_CARD))
    const icon = CARD.indexOf(styleClass('iconWrap'))
    const title = CARD.indexOf(styleClass('titleWrap'))
    const arrow = CARD.indexOf(styleClass('arrow'))
    assert.ok(icon > -1 && title > -1 && arrow > -1, 'all three are rendered')
    assert.ok(icon < title, 'the icon leads')
    assert.ok(title < arrow, 'and the arrow is last')
  })

  test('the card is COMPACT — no oversized box for an icon and a name', () => {
    const floor = DESKTOP_CARD.match(/min-height:\s*(\d+)px/)
    assert.ok(floor, 'the desktop card still has a floor')
    assert.ok(Number(floor[1]) <= 100,
      `a card holding an icon and a name must stay compact — found ${floor[1]}px`)
  })

  test('the name takes the slack, so the arrow sits at the far edge', () => {
    assert.ok(/\.titleWrap\s*\{[^}]*flex:\s*1 1 auto/.test(CSS),
      'the name grows into the space between the icon and the arrow')
    assert.ok(/\.titleWrap\s*\{[^}]*min-width:\s*0/.test(CSS),
      'and min-width: 0 is what lets it wrap rather than widen the row')
  })

  test('neither the icon nor the arrow is squeezed by a long name', () => {
    for (const rule of ['iconWrap', 'iconBox', 'arrow']) {
      const at = CSS.indexOf(`.${rule} {`)
      assert.notEqual(at, -1, `.${rule} must exist`)
      assert.ok(/flex-shrink:\s*0/.test(CSS.slice(at, CSS.indexOf('}', at))),
        `.${rule} must not shrink when "Performance Management" wraps`)
    }
  })
})

describe('nothing else about the launcher moved', () => {
  test('the module set, its order and its routes are untouched', () => {
    for (const key of [
      'task_management', 'sample_tracking', 'showroom_qr', 'assets_access',
      'employee_records', 'performance', 'finance', 'meetings', 'orders',
      'image_editor',
    ]) {
      assert.ok(PAGE.includes(`canOpenModule('${key}')`), `${key} is still gated`)
    }
  })

  test('the parent gate still decides whether a card exists at all', () => {
    assert.ok(PAGE.includes('canAccessManagementModule'),
      'permissions are unchanged — this work never touched the gate')
  })
})

// ── The page header carries the guidance, so the cards do not ────────────────
//
// THE TRADE THIS REDESIGN MAKES. A launcher with no descriptions on its cards
// still has to tell somebody what the screen is for; it just says it once, at
// page level, instead of thirteen times. If that line ever goes, the cards get
// argued back — so it is pinned here, beside the rule that keeps them off.
describe('the page header: eyebrow, heading, one supporting line', () => {
  /** The header row only, so a match inside a card cannot pass for one here. */
  const HEADER = (() => {
    const at = PAGE.indexOf('<div className={styles.sectionHeader}>')
    assert.notEqual(at, -1, 'the header row must still exist')
    return PAGE.slice(at, PAGE.indexOf('className={styles.grid}', at))
  })()

  test('all three lines are rendered, in order', () => {
    const eyebrow = HEADER.indexOf('>Workspace<')
    const heading = HEADER.indexOf('>Modules<')
    const support = HEADER.indexOf('>Select a module to continue<')
    assert.ok(eyebrow > -1, 'the WORKSPACE eyebrow')
    assert.ok(heading > -1, 'the Modules heading')
    assert.ok(support > -1, 'the supporting line')
    assert.ok(eyebrow < heading && heading < support, 'and in that order')
  })

  test('the heading is a real heading element, not a styled div', () => {
    assert.ok(/<h1 className=\{styles\.sectionLabel\}>/.test(HEADER),
      'the page names itself with an <h1> before listing its destinations')
  })

  test('the eyebrow is THE BOE RED, and the only thing on the page wearing it', () => {
    const at = CSS.indexOf('.eyebrow {')
    assert.notEqual(at, -1)
    assert.ok(/color:\s*#DC1F2E/i.test(CSS.slice(at, CSS.indexOf('}', at))),
      'the eyebrow carries the brand red')
    // Branding here is one label. A red card, a red border or a red button
    // would be the "subtle" in subtle branding going the other way.
    const reds = CSS.match(/#DC1F2E/gi) ?? []
    assert.equal(reds.length, 1,
      'exactly one rule in this stylesheet may use the BOE red')
  })

  test('a divider closes the header off from the grid', () => {
    const at = CSS.indexOf('.sectionHeader {')
    assert.notEqual(at, -1)
    assert.ok(/border-bottom:\s*1px solid #E4E7EC/i.test(CSS.slice(at, CSS.indexOf('}', at))),
      'a light neutral rule under the header')
  })

  test('AND THE CARDS STILL SAY NOTHING — the line is page-level, not per-card', () => {
    assert.equal(CARD.includes('Select a module'), false,
      'the guidance belongs to the page, never to a card')
  })
})

// ── The navigation cue ───────────────────────────────────────────────────────
//
// It replaces the "Open →" footer WITHOUT bringing the word back: an arrow says
// "this leads somewhere" in no characters at all, and the brief is explicit
// that the textual link does not return.
describe('the arrow is a cue, not a control and not a label', () => {
  test('it carries no text — "Open" does not come back in any form', () => {
    const at = CARD.indexOf(styleClass('arrow'))
    assert.notEqual(at, -1, 'the arrow must exist')
    const svg = CARD.slice(at, CARD.indexOf('</svg>', at))
    assert.equal(/>[A-Za-z]/.test(svg.replace(/<[^>]*>/g, '')), false,
      'the arrow is paths and nothing else')
    // Comments stripped first. The prose above the arrow explains that it
    // replaces the "Open" footer, and that sentence is not a label.
    assert.equal(/\bOpen\b/.test(stripJs(CARD)), false,
      'the word never reaches a card')
  })

  test('it is hidden from assistive technology and out of the tab order', () => {
    const at = CARD.indexOf(styleClass('arrow'))
    const tag = CARD.slice(at, CARD.indexOf('<path', at))
    assert.ok(/aria-hidden="true"/.test(tag),
      'the card is announced as one button named after its module, and nothing else')
    assert.ok(/focusable="false"/.test(tag), 'and SVG focus is off too')
    // The whole card is the control; a pointer event landing on the arrow must
    // still be the card's.
    assert.ok(/\.arrow\s*\{[^}]*pointer-events:\s*none/.test(CSS))
  })

  test('IT IS NOT DRAWN IN EDIT MODE, where the handle takes that corner', () => {
    assert.ok(CARD.includes('{!editing && ('),
      'a card that does not navigate shows no navigation cue')
    // On a phone both live in the top-right. Only one is ever rendered.
    assert.ok(/\.dragHandle\s*\{[^}]*position:\s*absolute/.test(CSS))
  })

  test('it answers FOCUS as well as hover, so a keyboard is not second class', () => {
    assert.ok(/\.card:hover \.arrow,\s*\.card:focus-visible \.arrow/.test(CSS),
      'hover and focus-visible share one rule — hover is never on its own')
    assert.ok(/\.card:hover::before,\s*\.card:focus-visible::before/.test(CSS),
      'and so does the accent stripe')
  })
})

// ── The responsive contract ──────────────────────────────────────────────────
describe('the grid steps down by column, and never overflows', () => {
  test('4 / 3 / 2 columns at 1920 / 1440 / 1024, DECLARED rather than inferred', () => {
    // WHY NOT auto-fill. The sidebar takes 260px and the page body 22px of
    // gutter each side, so 1920 leaves 1616px of grid — room for six 232px
    // tracks when the approved design is four. A minimum track width cannot say
    // "four, however wide the screen gets", so the steps are declared.
    assert.equal(/auto-fill|auto-fit/.test(stripCss(CSS)), false,
      'a minimum card width cannot express a fixed column count at 1920')
    assert.match(baseRule('.grid'), /grid-template-columns:\s*repeat\(2, 1fr\)/)

    // Each step, and the viewport it starts at.
    for (const [query, columns] of [['1200px', 3], ['1600px', 4]] as const) {
      const at = CSS.indexOf(`@media (min-width: ${query})`)
      assert.notEqual(at, -1, `the ${columns}-column step must exist`)
      assert.match(CSS.slice(at, CSS.indexOf('}', CSS.indexOf('.grid {', at))),
        new RegExp(`grid-template-columns:\\s*repeat\\(${columns}, 1fr\\)`))
    }
  })

  test('a card never becomes an oversized box at the widest step', () => {
    // 1920 minus the 260px sidebar and 44px of gutter is 1616px of grid; four
    // columns and three 14px gaps make each card (1616 - 42) / 4 = 393px. The
    // test is the arithmetic, so a future column change has to re-do it: a
    // 6-column 1920 would give 254px cards, and a 2-column one 787px.
    const CONTENT_AT_1920 = 1920 - 260 - 44
    const GAP = 14
    const card = (CONTENT_AT_1920 - GAP * 3) / 4
    assert.ok(card > 300 && card < 420,
      `four columns at 1920 give a ${Math.round(card)}px card, which is not the approved proportion`)
  })

  test('a phone gets TWO columns, and one only when two cannot be read', () => {
    const phone = CSS.slice(CSS.indexOf('@media (max-width: 639px)'))
    assert.ok(/\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, 1fr\)/.test(phone),
      'two-up at ordinary phone widths — 430, 390 and 360 all land here')
    const narrow = CSS.indexOf('@media (max-width: 339px)')
    assert.notEqual(narrow, -1, 'and a single column below 340px')
    assert.ok(/grid-template-columns:\s*1fr/.test(CSS.slice(narrow)))
  })

  test('nothing can push a card wider than its column', () => {
    // The three ways a card overflows its track: a name that will not break, a
    // fixed-width child that will not shrink, or a title box with no min-width.
    assert.ok(/\.title\s*\{[^}]*overflow-wrap:\s*anywhere/.test(CSS))
    assert.ok(/\.titleWrap\s*\{[^}]*min-width:\s*0/.test(CSS))
  })
})

// ── Reorder, permissions and routes are somebody else's tests ────────────────
//
// This suite does not re-assert what moduleOrder.test.ts already proves. What it
// DOES pin is that the redesign left the launcher wired to that machinery — a
// presentation change that quietly dropped a prop would otherwise pass every
// other test in this file.
describe('the redesign did not unwire the launcher', () => {
  test('edit mode still reaches the same reducer, handle and save path', () => {
    for (const wiring of [
      '<ModuleOrderBar',
      '<ModuleDragHandle',
      'saveModuleOrder',
      'onClick={editingOrder ? null : () => router.push(mod.href)}',
    ]) {
      assert.ok(PAGE.includes(wiring), `${wiring} must survive the redesign`)
    }
  })

  test('a card still navigates to its own href, and none is hard-coded', () => {
    assert.ok(PAGE.includes('router.push(mod.href)'),
      'the destination comes from the module definition, as before')
  })

  test('reorder mode is visibly different without a second card component', () => {
    assert.ok(/\.cardEditing\s*\{[^}]*border-style:\s*dashed/.test(CSS),
      'a dashed border says "you are rearranging" — one class, one card')
    assert.equal(CSS.includes('.cardReorder'), false,
      'and no parallel card style was introduced to maintain alongside .card')
  })
})

// ── Light only ───────────────────────────────────────────────────────────────
describe('this page has no dark variant, and adds none', () => {
  test('the stylesheet declares no dark-mode block', () => {
    // The AT-RULE, not the phrase: the header comment says in prose that the
    // app has no prefers-color-scheme block anywhere, and a test that could not
    // tell those apart would forbid explaining the decision.
    assert.equal(/@media[^{]*prefers-color-scheme/.test(stripCss(CSS)), false,
      'the launcher is light-only, like the rest of the app')
    assert.equal(/data-theme/.test(stripCss(CSS)), false)
  })

  test('the card surface is white and its border is the neutral grey', () => {
    assert.ok(/\.card\s*\{[^}]*background:\s*#fff/i.test(CSS))
    assert.ok(PAGE.includes("'#E4E7EC'"),
      'the resting border is the approved neutral, set inline beside the accent')
  })

  test('reduced motion drops the movement and keeps the meaning', () => {
    const rm = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    assert.notEqual(rm, '', 'the block must exist')
    assert.ok(/transition:\s*none/.test(rm), 'nothing eases')
    assert.ok(/transform:\s*none\s*!important/.test(rm),
      'and the 2px lift — which is motion and nothing else — is dropped outright')
  })
})

/** `className={styles.x}`, written once so a rename is a single edit. */
function styleClass(name: string): string {
  return `styles.${name}`
}

// ── Comments are prose, not markup ───────────────────────────────────────────
//
// Both files explain, at length, the things these tests forbid: page.tsx says
// the arrow replaces the "Open" footer, and modules.module.css says the app has
// no prefers-color-scheme block anywhere. A suite that searched the raw text
// would fail on the explanation and pass on a file that simply said nothing —
// exactly backwards. So the two assertions that look for a FORBIDDEN string
// strip comments first, as the nested-control test above already does.

/** JSX/TS source with `//` and block comments removed. */
function stripJs(source: string): string {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** CSS with block comments removed. CSS has no line-comment form. */
function stripCss(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}
