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
/** The Edit order controls, whose labels this suite checks but does not own. */
const CONTROLS_SRC = read('src/app/modules/ModuleOrderControls.tsx')

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
  /** The first <= 767px block, which is where the card's phone shape lives. */
  const SMALL = (() => {
    const at = CSS.indexOf('@media (max-width: 767px)')
    assert.notEqual(at, -1, 'the small-screen block must still exist')
    return CSS.slice(at, CSS.indexOf('@media (max-width: 339px)'))
  })()

  test('the card centres its children and its text', () => {
    assert.ok(/\.card\s*\{[^}]*align-items:\s*center/.test(SMALL))
    assert.ok(/\.card\s*\{[^}]*text-align:\s*center/.test(SMALL))
  })

  test('the icon is centred, which carries the badge with it', () => {
    assert.ok(/\.iconWrap\s*\{[^}]*align-self:\s*center/.test(SMALL))
  })

  test('the name spans the card, so centring it has something to centre in', () => {
    // Declared on the base rule and not undone here: a full-width name box is
    // what both the left-aligned desktop tile and the centred phone card need.
    assert.ok(/\.titleWrap\s*\{[^}]*width:\s*100%/.test(CSS))
    assert.equal(/\.titleWrap\s*\{[^}]*width:\s*auto/.test(SMALL), false)
  })

  test('each phone card is its own white card', () => {
    // The desktop tile is already a bordered white card, so the phone inherits
    // the surface and only changes the alignment — nothing has to be re-drawn.
    assert.match(DESKTOP_CARD, /background:\s*#fff/i)
    assert.match(DESKTOP_CARD, /border:\s*1px solid #E3E6EB/i)
    assert.equal(/\.card\s*\{[^}]*background:\s*transparent/.test(SMALL), false,
      'the phone never strips the card surface')
  })

  test('a phone card is a real tap target', () => {
    const floor = SMALL.match(/\.card\s*\{[^}]*min-height:\s*(\d+)px/)
    assert.ok(floor, 'the phone card has a floor')
    assert.ok(Number(floor[1]) >= 88,
      `a phone card must stay comfortably tappable — found ${floor[1]}px`)
  })

  test('DESKTOP IS NOT CENTRED — the centring is scoped here', () => {
    // On a desktop the card is a row read from the left: icon, then name. Only
    // the phone card stacks and centres them.
    assert.equal(/text-align:\s*center/.test(DESKTOP_CARD), false,
      'the desktop card keeps its left edge')
    assert.match(DESKTOP_CARD, /justify-content:\s*flex-start/,
      'the desktop row starts at the left')
    assert.ok(/\.card\s*\{[^}]*align-items:\s*center/.test(SMALL),
      'and only the phone card centres its parts')
    assert.ok(/\.card\s*\{[^}]*flex-direction:\s*column/.test(SMALL),
      'as a column')
  })
})

// ── The desktop card is a ROW: icon beside name ──────────────────────────────
//
// The icon and the name are one unit — side by side on the card's centre
// line — not an icon at the top and a label at the bottom of a tall box. These
// pin the SHAPE, not exact pixels: a particular number is a design call and
// changing one should not fail a suite.
describe('the desktop card is a row: icon beside name', () => {
  test('it is a row, the icon leads, and both sit on the centre line', () => {
    assert.match(DESKTOP_CARD, /flex-direction:\s*row/)
    assert.match(DESKTOP_CARD, /align-items:\s*center/,
      'the icon and the name share one centre line')
    const icon = CARD.indexOf(styleClass('iconWrap'))
    const title = CARD.indexOf(styleClass('titleWrap'))
    assert.ok(icon > -1 && title > -1, 'both are rendered')
    assert.ok(icon < title, 'the icon leads')
  })

  test('the icon and the name are NOT pushed to opposite ends', () => {
    assert.equal(/space-between/.test(DESKTOP_CARD), false,
      'nothing spreads the icon and the name apart')
    const gap = DESKTOP_CARD.match(/\bgap:\s*(\d+)px/)
    assert.ok(gap && Number(gap[1]) <= 24, 'they sit a short, fixed gap apart')
  })

  test('the card is SIZED — substantial, not a table row and not a box of air', () => {
    const floor = DESKTOP_CARD.match(/min-height:\s*(\d+)px/)
    assert.ok(floor, 'the desktop card has a floor')
    const h = Number(floor[1])
    assert.ok(h >= 90 && h <= 120, `a row card of real presence — found ${h}px`)
  })

  test('the icon and the name are sized to be read at a glance', () => {
    assert.match(baseRule('.iconBox'), /width:\s*5[2-9]px/, 'a 52–59px icon block')
    const size = baseRule('.title').match(/font-size:\s*([\d.]+)px/)
    assert.ok(size && Number(size[1]) >= 16, `a module name of at least 16px — found ${size?.[1]}px`)
  })

  test('the name takes the rest of the row and may wrap', () => {
    assert.ok(/\.titleWrap\s*\{[^}]*flex:\s*1 1 auto/.test(CSS))
    assert.ok(/\.titleWrap\s*\{[^}]*min-width:\s*0/.test(CSS))
  })

  test('a narrow desktop grid stacks the icon DIRECTLY above the name', () => {
    const at = CSS.indexOf('@container (max-width: 599px)')
    assert.notEqual(at, -1, 'the narrow-grid block exists')
    const narrow = CSS.slice(at, CSS.indexOf('@media (max-width: 767px)'))
    assert.match(narrow, /flex-direction:\s*column/)
    assert.match(narrow, /justify-content:\s*center/,
      'the pair is centred as a group, never spread to top and bottom')
  })

  test('the icon is not squeezed by a long name', () => {
    for (const rule of ['iconWrap', 'iconBox']) {
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

// ── ONE HEADER, AT THE TOP OF THE PAGE ───────────────────────────────────────
//
// The launcher used to name itself twice. The app header said "BOE Operating
// System" over today's date; the body then opened with a second heading block
// carrying a WORKSPACE eyebrow, the page's real title, its supporting line and
// its own divider. Two headers, one screen, and the top one repeated the
// sidebar brand while the bottom one held the title that mattered.
//
// There is now one. The title and the supporting line are passed to
// BoeOsLayout, the Edit order control sits at the right-hand end of that same
// row, and the body starts with the grid.
//
// These read the LAYOUT as well as the page, because the header is no longer
// something this page draws — it is something it supplies.
describe('the page has ONE header, and it is the app header', () => {
  const LAYOUT = read('src/components/layout/BoeOsLayout.tsx')

  /** The props the launcher hands the shell. */
  const LAYOUT_CALL = (() => {
    const at = PAGE.indexOf('<BoeOsLayout')
    assert.notEqual(at, -1, 'the launcher still renders the shell')
    return PAGE.slice(at, PAGE.indexOf('>\n', at))
  })()

  test('the title is Modules and the supporting line sits under it', () => {
    assert.match(LAYOUT_CALL, /title="Modules"/)
    assert.match(LAYOUT_CALL, /subtitle="Select a module to continue"/)
    // In the shell, the subtitle is rendered immediately after the title inside
    // the same title group — so "under it" is structural, not a CSS accident.
    const group = LAYOUT.slice(LAYOUT.indexOf('boe-page-title-group'))
    assert.ok(group.indexOf('{title}') < group.indexOf('{subtitle'),
      'the supporting line follows the title')
  })

  test('MODULES IS THE PAGE’S MAIN HEADING, as an actual h1', () => {
    assert.match(LAYOUT, /<h1 className="boe-page-title"[^>]*>\{title\}<\/h1>/,
      'the page title is an h1, not a styled div')
    // And the page declares no second one.
    assert.equal((PAGE.match(/<h1\b/g) ?? []).length, 0,
      'the page body must not add a heading of its own')
  })

  test('the supporting line appears EXACTLY ONCE in the whole page', () => {
    assert.equal((PAGE.match(/Select a module to continue/g) ?? []).length, 1,
      'said once, in the header — never repeated in the body or on a card')
    assert.equal(CARD.includes('Select a module'), false,
      'and never on a card')
  })

  test('WORKSPACE IS GONE — eyebrow markup and its style both', () => {
    assert.equal(/Workspace/i.test(stripJs(PAGE).replace(/\/\*[\s\S]*?\*\//g, '')), false,
      'no WORKSPACE eyebrow is rendered')
    assert.equal(CSS.includes('.eyebrow'), false,
      'and the rule that styled it is deleted, not merely unreferenced')
    // BOE red now appears in this stylesheet for exactly one reason — the icon
    // of the card being pointed at — and never as a text colour on a label.
    assert.equal((stripCss(CSS).match(/#DC1F2E/gi) ?? []).length, 1,
      'the eyebrow red left with the eyebrow; the one red is the hover icon')
  })

  test('THE DATE IS GONE from the Modules header', () => {
    assert.equal(/toLocaleDateString/.test(PAGE), false,
      'nothing on a launcher depends on knowing what day it is')
    assert.equal(/new Date\(\)/.test(PAGE), false)
  })

  test('BOE Operating System is NOT the page header — but IS still the sidebar brand', () => {
    assert.equal(LAYOUT_CALL.includes('BOE Operating System'), false,
      'the product name is not this page’s title any more')
    // The shell still carries it as the brand, which is the one place it belongs.
    assert.ok(LAYOUT.includes('boe-sidebar-brand'), 'the brand block survives')
    assert.match(LAYOUT, /boe-sidebar-brand-name">BOE</, 'and still says BOE')
    assert.match(LAYOUT, /boe-sidebar-brand-sub">Operating System</,
      'with "Operating System" beneath it, untouched')
  })

  test('Edit order is still offered, now in the header’s action slot', () => {
    assert.match(LAYOUT_CALL, /headerActions=\{canEditOrder \? \(/,
      'the control is passed to the header, still behind the same permission')
    assert.match(LAYOUT_CALL, /<ModuleOrderBar/, 'and it is the same component')
    assert.ok(CONTROLS_SRC.includes('Edit order'), 'whose normal-mode label is unchanged')
    // The shell renders it in the slot every other layout in the app uses.
    assert.match(LAYOUT, /className="boe-header-actions"/)
    assert.ok(LAYOUT.includes('headerActions &&'),
      'and a caller that passes nothing gets no slot at all')
  })

  test('THE DUPLICATE CONTENT HEADER IS GONE, markup and CSS together', () => {
    // Not "renders nothing" — removed. A leftover wrapper would still reserve
    // margin and leave the gap this change exists to close.
    for (const cls of ['sectionHeader', 'sectionHeading', 'sectionLabel', 'sectionSupport', 'eyebrow']) {
      assert.equal(PAGE.includes(`styles.${cls}`), false,
        `styles.${cls} must not be referenced any more`)
      assert.equal(new RegExp(`^\\.${cls}\\b`, 'm').test(CSS), false,
        `.${cls} must be deleted from the stylesheet, not left unused`)
    }
    // And no divider is left floating between the header and the grid: the
    // header's own bottom border is the only rule there now.
    assert.equal(/border-bottom:\s*1px solid #E4E7EC/i.test(CSS), false,
      'the content header took its divider with it')
  })

  test('the launcher is the first thing in the body', () => {
    const body = PAGE.slice(PAGE.indexOf('<BoeOsLayout'))
    const launcher = body.indexOf('<div className={styles.launcher}>')
    const grid = body.indexOf('styles.grid')
    const quick = body.indexOf('<QuickActionList')
    assert.ok(launcher > -1 && grid > launcher, 'the grid sits inside its size container')
    // QuickActionList is the small-screen copy and legitimately precedes it;
    // nothing else may.
    assert.ok(quick > -1 && quick < launcher, 'only the quick actions come first')
    assert.equal(body.slice(quick, launcher).includes('<div className={styles.'), false,
      'no heading wrapper survives before the launcher')
    // The size container wraps the grid and nothing else: no heading, label or
    // divider has crept in between them.
    assert.match(body.slice(launcher, grid), /^<div className=\{styles\.launcher\}>\s*<div className=\{$/,
      'the grid is the size container’s first and only child')
  })
})

// ── No arrow, no per-module accent, no inline style ──────────────────────────
//
// The diagonal arrow that sat in every card's corner is gone: thirteen copies
// of one faint glyph said what the whole page already says, and the word "Open"
// it replaced does not come back either. Which card you are about to open is
// told by its STATE — the lift, the firmer edge and the BOE-red icon on hover
// and focus.
//
// Every module used to wear its own accent colour, applied inline. The launcher
// now has one restrained palette, so the card carries no colour of its own and
// no style attribute at all: every state is a stylesheet rule.
describe('the card carries no decoration of its own', () => {
  test('THERE IS NO ARROW, and "Open" does not come back in any form', () => {
    assert.equal(CARD.includes(styleClass('arrow')), false, 'no arrow is rendered')
    assert.equal(/\.arrow\b/.test(CSS), false, 'and no .arrow rule survives')
    assert.equal(/<svg\b/.test(stripJs(CARD)), false,
      'the only graphic on a card is the module icon it is given')
    // Comments stripped first. The prose explains what replaced the arrow, and
    // that sentence is not a label.
    assert.equal(/\bOpen\b/.test(stripJs(CARD)), false, 'the word never reaches a card')
  })

  test('NO PER-MODULE ACCENT — not on the definitions, not on the card', () => {
    assert.equal(/\baccent\b/.test(stripJs(PAGE)), false,
      'the module definitions carry no accent colour')
    assert.equal(/style=\{/.test(stripJs(CARD)), false,
      'the card sets no inline style: every state lives in the stylesheet')
    assert.equal(/--module-accent/.test(CSS), false, 'and the stylesheet reads none')
    assert.equal(CSS.includes('!important'), false,
      'with no inline style to beat, nothing needs !important')
  })

  test('BOE RED IS THE ONE COLOUR, and only on the card being pointed at', () => {
    // The brand cue is deliberate and narrow: the icon of the hovered or
    // focused card takes BOE red. At rest every icon is the same ink.
    const hot = CSS.match(/\.card:hover \.iconBox,\s*\.card:focus-visible \.iconBox\s*\{([^}]*)\}/)
    assert.ok(hot, 'hover and focus share one icon rule')
    assert.match(hot[1], /color:\s*#DC1F2E/i, 'and it is BOE red')
    assert.equal(/color:\s*#DC1F2E/i.test(baseRule('.iconBox')), false,
      'a resting icon is ink, not red')
  })

  test('the card keeps no hover flag in React — :hover does that job', () => {
    assert.equal(/useState\(/.test(CARD), false)
    assert.equal(/onMouseEnter|onMouseLeave/.test(CARD), false)
  })

  test('HOVER AND FOCUS ARE ONE LANGUAGE, so a keyboard is not second class', () => {
    assert.ok(/\.card:hover,\s*\.card:focus-visible\s*\{/.test(CSS),
      'the lift and the firmer edge answer both')
    assert.ok(/\.card:hover \.iconBox,\s*\.card:focus-visible \.iconBox\s*\{/.test(CSS),
      'and so does the red icon')
    assert.ok(/\.card:focus-visible\s*\{[^}]*outline:\s*2px solid #141922/.test(CSS),
      'focus adds an ink ring on top, so it can never be mistaken for a stray pointer')
    assert.ok(/\.card:active\s*\{/.test(CSS), 'and pressing has its own state')
  })

  test('the drag handle is still absolutely positioned, so it costs no layout', () => {
    assert.ok(/\.dragHandle\s*\{[^}]*position:\s*absolute/.test(CSS))
  })
})

// ── The responsive contract ──────────────────────────────────────────────────
describe('the launcher sizes itself from the width it actually has', () => {
  test('COLUMNS COME FROM A CONTAINER QUERY, not the viewport', () => {
    assert.ok(/\.launcher\s*\{[^}]*container-type:\s*inline-size/.test(CSS))
    assert.equal(/@media \(min-width/.test(CSS), false,
      'no viewport min-width step is left to disagree with the container')
    assert.match(baseRule('.grid'), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
    const at = CSS.indexOf('@container (min-width: 900px)')
    assert.notEqual(at, -1, 'the 3-column step must exist')
    assert.match(CSS.slice(at, CSS.indexOf('}', at)),
      /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/)
  })

  test('THREE AT EVERY DESKTOP SIZE — no 4- or 5-column step', () => {
    // Chosen with 13 modules, the production count: four or five across leave
    // the thirteenth card under three or four empty slots, three across leaves
    // it beside two, and a module sits in the same place on a laptop and a
    // large monitor.
    assert.equal(/repeat\([45], /.test(stripCss(CSS)), false)
  })

  test('THE PAGE ASKS FOR ONE CONTENT COLUMN, so the launcher has a deliberate width', () => {
    const LAYOUT = read('src/components/layout/BoeOsLayout.tsx')
    assert.match(PAGE, /contentMaxWidth=\{1180\}/, 'the launcher asks for an 1180px column')
    assert.ok(LAYOUT.includes('contentMaxWidth?: number'), 'the shell takes it as an optional prop')
    assert.ok(LAYOUT.includes('boe-main-content-capped'), 'and applies it with one class')
    const GLOBALS = read('src/app/globals.css')
    assert.match(GLOBALS, /\.boe-main-content-capped > \.boe-page-header,\s*\.boe-main-content-capped > \.boe-page-body \{/,
      'the header and the body share the column, so Edit order lines up with the last card')
  })

  test('a card is a sensible width at 1920, 1366 and 1024', () => {
    // The arithmetic the steps are built on, so a future change has to re-do
    // it. Grid width = min(window - 260px sidebar - 44px gutters, 1180px
    // column); 16px between cards.
    const card = (window: number, cols: number) => {
      const grid = Math.min(window - 260 - 44, 1180)
      return (grid - (cols - 1) * 16) / cols
    }
    for (const [window, cols] of [[1920, 3], [1366, 3], [1024, 2]] as const) {
      const w = card(window, cols)
      assert.ok(w > 300 && w < 400,
        `${cols} columns at ${window} give a ${Math.round(w)}px card — too cramped or too empty`)
    }
  })

  test('a phone gets TWO columns, and one only when two cannot be read', () => {
    const phone = CSS.slice(CSS.indexOf('@media (max-width: 767px)'))
    assert.ok(/\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/.test(phone),
      'two-up at ordinary phone widths — 430, 390 and 360 all land here')
    const narrow = CSS.indexOf('@media (max-width: 339px)')
    assert.notEqual(narrow, -1, 'and a single column below 340px')
    assert.ok(/grid-template-columns:\s*minmax\(0, 1fr\)/.test(CSS.slice(narrow)))
  })

  test('nothing can push a card wider than its column', () => {
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

  test('reorder mode is the same card, visibly loosened', () => {
    // A dashed edge says "you are rearranging", on every card at every width,
    // and the handle takes the corner the tile leaves empty.
    assert.ok(/\.cardEditing\s*\{[^}]*border-style:\s*dashed/.test(CSS),
      'the card turns dashed')
    assert.ok(/\.dragHandle\s*\{[^}]*top:\s*\d+px;[^}]*right:\s*\d+px/.test(CSS),
      'the handle sits in the top-right corner')
    assert.equal(CSS.includes('.cardReorder'), false,
      'and no parallel card style was introduced to maintain alongside .card')
  })

  test('the phone Quick Add steps aside while the grid is being arranged', () => {
    assert.ok(PAGE.includes('{!editingOrder && <QuickActionList actions={quickActions} variant="page" />}'))
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
    assert.match(DESKTOP_CARD, /background:\s*#fff/i)
    assert.match(DESKTOP_CARD, /border:\s*1px solid #E3E6EB/i)
  })

  test('reduced motion drops the movement and keeps the meaning', () => {
    const rm = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    assert.notEqual(rm, '', 'the block must exist')
    assert.ok(/transition:\s*none/.test(rm), 'nothing eases')
    assert.ok(/\.card:hover,\s*\.card:focus-visible\s*\{\s*transform:\s*none/.test(rm),
      'and the 2px lift — motion and nothing else — is dropped')
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
