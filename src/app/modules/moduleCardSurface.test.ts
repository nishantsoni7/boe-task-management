/**
 * What the Modules launcher shows, and what happens when you activate a tile.
 *
 * The page is a welcome panel, an Essentials row and a compact "More to
 * explore" grid. A tile is a NUMBER, AN ICON, ITS NOTIFICATION BADGE, THE MODULE
 * NAME AND A DECORATIVE ARROW. Never a description, at any width: that
 * furniture used to cost a phone most of the card to restate what the icon, the
 * name and the badge had already said.
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

// ── Two tile sizes, one component ────────────────────────────────────────────
//
// The Essentials tile is the larger one; every other module is a compact tile.
// Both are ModuleCard, so every behaviour pinned above applies to both. These
// pin the SHAPE, not exact pixels: a particular number is a design call and
// changing one should not fail a suite.
describe('the tile: number, icon, name and a decorative arrow', () => {
  test('both sizes are one component, chosen by a variant', () => {
    assert.match(CARD, /variant: 'essential' \| 'compact'/)
    assert.ok(CARD.includes(styleClass('cardEssential')))
    assert.ok(CARD.includes(styleClass('cardCompact')))
    assert.equal((PAGE.match(/function ModuleCard\(/g) ?? []).length, 1,
      'there is no second card component to keep in step')
  })

  test('the icon leads the name, on one row, a short gap apart', () => {
    assert.match(baseRule('.cardBody'), /flex-direction:\s*row/)
    assert.match(baseRule('.cardBody'), /align-items:\s*center/)
    const gap = baseRule('.cardBody').match(/\bgap:\s*(\d+)px/)
    assert.ok(gap && Number(gap[1]) <= 24, 'icon and name sit a short, fixed gap apart')
    const icon = CARD.indexOf(styleClass('iconWrap'))
    const title = CARD.indexOf(styleClass('titleWrap'))
    assert.ok(icon > -1 && title > icon, 'the icon leads')
  })

  test('the number is decoration: hidden from assistive technology', () => {
    assert.match(CARD, /<span className=\{styles\.cardNumber\} aria-hidden="true">/)
    assert.ok(CARD.includes("String(number).padStart(2, '0')"), 'a two-digit label')
  })

  test('THE ARROW IS DECORATION, and is not drawn in edit mode', () => {
    assert.match(CARD, /\{!editing && \(\s*<ArrowUpRight className=\{styles\.cardArrow\} aria-hidden="true"/,
      'aria-hidden, and only while the tile opens something')
    assert.match(baseRule('.cardArrow'), /pointer-events:\s*none/,
      'it never intercepts the click meant for the tile')
    // It is the lucide component, not hand-drawn artwork.
    assert.equal(/<svg\b/.test(stripJs(CARD)), false,
      'the tile draws no artwork of its own besides the module icon it is given')
  })

  test('"Open" and "View" never come back as words', () => {
    assert.equal(/\bOpen\b/.test(stripJs(CARD)), false)
    assert.equal(/\bView\b/.test(stripJs(CARD)), false)
  })

  test('the Essentials tile is the larger one', () => {
    const at = CSS.indexOf('@container (min-width: 720px) {\n  .cardEssential {')
    assert.notEqual(at, -1, 'the wide Essentials rule exists')
    const wide = CSS.slice(at, CSS.indexOf('}', at))
    const floor = wide.match(/min-height:\s*(\d+)px/)
    const compact = DESKTOP_CARD.match(/min-height:\s*(\d+)px/)
    assert.ok(floor && compact && Number(floor[1]) > Number(compact[1]),
      'a featured tile stands taller than a compact one')
    assert.match(baseRule('.cardEssential .iconBox'), /width:\s*4\d+px/,
      'and carries a boxed icon')
  })

  test('the attention tint follows a REAL count, on Essentials only', () => {
    assert.ok(CARD.includes("variant === 'essential' && hasNotif ? styles.cardAttention : ''"),
      'no count, no tint — nothing about it is decoration')
  })

  test('the icon is not squeezed by a long name', () => {
    for (const rule of ['iconWrap', 'iconBox']) {
      assert.match(baseRule(`.${rule}`), /flex-shrink:\s*0/,
        `.${rule} must not shrink when "Performance Management" wraps`)
    }
  })

  test('the name takes the rest of the row and may wrap', () => {
    assert.ok(/\.titleWrap\s*\{[^}]*flex:\s*1 1 auto/.test(CSS))
    assert.ok(/\.titleWrap\s*\{[^}]*min-width:\s*0/.test(CSS))
  })

  test('a narrow grid stacks a compact icon DIRECTLY above its name', () => {
    const at = CSS.indexOf('@container (max-width: 559px)')
    assert.notEqual(at, -1, 'the narrow-grid block exists')
    const narrow = CSS.slice(at, CSS.indexOf('@media (max-width: 767px)'))
    assert.match(narrow, /\.cardCompact \.cardBody\s*\{[^}]*flex-direction:\s*column/)
  })

  test('the badge stays on the icon in BOTH tile sizes', () => {
    // .badge is positioned against .iconWrap, which both sizes render, and no
    // rule anywhere repositions it against the tile.
    assert.equal((stripCss(CSS).match(/\.badge\s*\{/g) ?? []).length, 1,
      'one badge rule, not a per-size override that could move it to a corner')
    assert.ok(CARD.indexOf(styleClass('badge')) > CARD.indexOf(styleClass('iconWrap')))
    assert.ok(CARD.indexOf(styleClass('badge')) < CARD.indexOf(styleClass('titleWrap')),
      'the badge is inside the icon wrapper, before the name')
  })
})

// ── The phone ────────────────────────────────────────────────────────────────
describe('a phone gets full-width Essentials and two compact tiles across', () => {
  test('Essentials are one column until the launcher is 720px wide', () => {
    assert.match(baseRule('.essentialsGrid'), /grid-template-columns:\s*minmax\(0, 1fr\)/)
    const at = CSS.indexOf('@container (min-width: 720px)')
    assert.match(CSS.slice(at, CSS.indexOf('}', at)),
      /\.essentialsGrid\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/)
  })

  test('every tile is a comfortable tap target', () => {
    const essential = baseRule('.cardEssential').match(/min-height:\s*(\d+)px/)
    assert.ok(essential && Number(essential[1]) >= 64,
      `a phone Essentials row must stay tappable — found ${essential?.[1]}px`)
    const compact = DESKTOP_CARD.match(/min-height:\s*(\d+)px/)
    assert.ok(compact && Number(compact[1]) >= 88,
      `a compact tile must stay tappable — found ${compact?.[1]}px`)
  })

  test('two compact tiles across, and one only below 340px', () => {
    assert.match(baseRule('.grid'), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
    const narrow = CSS.indexOf('@media (max-width: 339px)')
    assert.notEqual(narrow, -1)
    assert.ok(/grid-template-columns:\s*minmax\(0, 1fr\)/.test(CSS.slice(narrow)))
  })

  test('there is no hover lift on a touch screen', () => {
    const at = CSS.indexOf('@media (max-width: 767px)')
    assert.notEqual(at, -1)
    assert.match(CSS.slice(at), /\.card:hover\s*\{[^}]*transform:\s*none/)
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

// ── The header and the welcome panel ─────────────────────────────────────────
//
// The app header keeps the page title, the announcements bell and Edit order.
// The supporting line moved into the welcome panel, beside the headline it
// supports, so it is still said exactly once.
//
// These read the LAYOUT as well as the page, because the header is something
// this page supplies rather than draws.
describe('the header, and the welcome panel beneath it', () => {
  const LAYOUT = read('src/components/layout/BoeOsLayout.tsx')

  /** The props the launcher hands the shell. */
  const LAYOUT_CALL = (() => {
    const at = PAGE.indexOf('<BoeOsLayout')
    assert.notEqual(at, -1, 'the launcher still renders the shell')
    return PAGE.slice(at, PAGE.indexOf('>\n', at))
  })()

  /** The welcome panel's markup. */
  const HERO = (() => {
    const at = PAGE.indexOf('<section className={styles.hero}')
    assert.notEqual(at, -1, 'the welcome panel exists')
    return PAGE.slice(at, PAGE.indexOf('</section>', at))
  })()

  test('MODULES IS STILL THE PAGE’S h1, in the shell', () => {
    assert.match(LAYOUT_CALL, /title="Modules"/)
    assert.match(LAYOUT, /<h1 className="boe-page-title"[^>]*>\{title\}<\/h1>/)
    assert.equal((PAGE.match(/<h1\b/g) ?? []).length, 0,
      'the page body adds no second h1 — the headline is an h2')
    assert.match(HERO, /<h2 id="modules-hero-heading" className=\{styles\.heroHeadline\}>/)
  })

  test('the approved headline and instruction, each said once', () => {
    assert.match(HERO, /A better way to get work moving\./)
    assert.equal((PAGE.match(/Select a module to continue/g) ?? []).length, 1,
      'said once, in the panel — not in the header too')
    assert.equal(LAYOUT_CALL.includes('subtitle='), false,
      'the header no longer repeats the instruction')
    assert.equal(CARD.includes('Select a module'), false, 'and never on a tile')
  })

  test('THE COUNT IS THE ROLE-FILTERED LIST, never a literal', () => {
    assert.ok(PAGE.includes('const availableCount = canonicalModules.length'),
      'derived from the same gated list the tiles come from')
    assert.match(HERO, /\{availableCount\}/)
    assert.equal(/>\s*\d+\s*</.test(stripJs(HERO)), false,
      'no number is written into the panel')
    // Above the icon drawings, whose path coordinates legitimately contain 13.
    const logic = stripJs(PAGE.slice(0, PAGE.indexOf('// ── Icons')))
    assert.equal(/\b13\b/.test(logic), false, 'and 13 is written nowhere in the page logic')
  })

  test('the circular motif is decoration: hidden, unclickable, behind the text', () => {
    assert.match(HERO, /<svg className=\{styles\.heroMotif\}[^>]*aria-hidden="true"/)
    assert.match(baseRule('.heroMotif'), /pointer-events:\s*none/)
    assert.match(baseRule('.heroMotif'), /z-index:\s*-1/)
  })

  test('the panel clips only its motif, without creating a scroll box', () => {
    assert.match(baseRule('.hero'), /overflow:\s*clip/)
    assert.equal(/\boverflow:\s*(hidden|auto|scroll)/.test(stripCss(CSS)), false)
  })

  test('the panel steps aside while arranging tiles', () => {
    assert.ok(PAGE.includes('{!editingOrder && (\n              <section className={styles.hero}'))
  })

  test('THE DATE IS NOT BACK, and no activity data was invented', () => {
    assert.equal(/toLocaleDateString|new Date\(\)/.test(PAGE), false)
    assert.equal(/fetch\(|\.from\(/.test(stripJs(HERO)), false,
      'the panel reads nothing of its own')
  })

  test('BOE Operating System is still the sidebar brand, untouched', () => {
    assert.equal(LAYOUT_CALL.includes('BOE Operating System'), false)
    assert.match(LAYOUT, /boe-sidebar-brand-name">BOE</)
    assert.match(LAYOUT, /boe-sidebar-brand-sub">Operating System</)
  })

  test('Edit order and the bell are still offered in the header’s action slot', () => {
    assert.match(LAYOUT_CALL, /headerActions=\{showBell \|\| canEditOrder \? \(/)
    assert.match(LAYOUT_CALL, /\{canEditOrder && <ModuleOrderBar/)
    assert.match(LAYOUT_CALL, /<AnnouncementBell/)
    assert.ok(CONTROLS_SRC.includes('Edit order'), 'whose normal-mode label is unchanged')
    assert.match(LAYOUT_CALL, /quickActions=\{quickActions\}/, 'and Quick Add Expense stays in the sidebar')
  })

  test('the order of the body: announcements, quick action, launcher', () => {
    const body = PAGE.slice(PAGE.indexOf('<BoeOsLayout'))
    const banner = body.indexOf('<AnnouncementBanner')
    const quick = body.indexOf('<QuickActionList')
    const launcher = body.indexOf('<div className={styles.launcher}>')
    assert.ok(banner > -1 && quick > banner && launcher > quick)
  })
})

// ── Essentials and More to explore ───────────────────────────────────────────
describe('two sections, drawn from one gated list', () => {
  test('the Essentials are Task, Order and Finance, by key', () => {
    assert.ok(PAGE.includes("const ESSENTIAL_MODULE_KEYS: readonly string[] = ['tasks', 'orders', 'finance']"))
  })

  test('BOTH SECTIONS ARE FILTERS OF THE RENDERED LIST — neither can admit a card', () => {
    assert.ok(PAGE.includes('const essentialModules = modules.filter(mod => isEssential(mod.key))'))
    assert.ok(PAGE.includes('const moreModules = modules.filter(mod => !isEssential(mod.key))'))
  })

  test('a section with no cards is not drawn at all', () => {
    assert.ok(PAGE.includes('{essentialModules.length > 0 && ('))
    assert.ok(PAGE.includes('{moreModules.length > 0 && ('))
  })

  test('the default order reads Task, Order, Finance', () => {
    const at = (key: string) => PAGE.indexOf(`canOpenModule('${key}') ? [{`)
    assert.ok(at('task_management') < at('orders') && at('orders') < at('finance'))
  })

  test('A MOVE STAYS IN ITS SECTION, through the unchanged reducer', () => {
    assert.ok(PAGE.includes('onMove={moveWithinSection}'), 'arrow keys move within the section')
    assert.ok(PAGE.includes("dispatchOrderEdit({ type: 'moveToSlotOf', key, targetKey: section[to].key })"))
    assert.ok(PAGE.includes('if (isEssential(key) !== isEssential(targetKey)) return'),
      'a drag never pushes a card into the other section')
  })

  test('a handle announces its place in the section a person can see', () => {
    assert.ok(PAGE.includes('position={position + 1}'))
    assert.ok(PAGE.includes('total={total}'))
  })
})

// ── Colour, state and the page's own surface ─────────────────────────────────
describe('one restrained palette, and every state in the stylesheet', () => {
  test('NO PER-MODULE ACCENT and no inline style', () => {
    assert.equal(/\baccent\b/.test(stripJs(PAGE)), false)
    assert.equal(/style=\{/.test(stripJs(CARD)), false)
    assert.equal(CSS.includes('!important'), false)
  })

  test('BOE red marks the tile being pointed at — icon and arrow — and nothing at rest', () => {
    const icon = CSS.match(/\.card:hover \.iconBox,\s*\.card:focus-visible \.iconBox\s*\{([^}]*)\}/)
    assert.ok(icon)
    assert.match(icon[1], /color:\s*#DC1F2E/i)
    const arrow = CSS.match(/\.card:hover \.cardArrow,\s*\.card:focus-visible \.cardArrow\s*\{([^}]*)\}/)
    assert.ok(arrow)
    assert.match(arrow[1], /color:\s*#DC1F2E/i)
    assert.equal(/#DC1F2E/i.test(baseRule('.iconBox')), false, 'a resting icon is ink')
    assert.equal(/#DC1F2E/i.test(baseRule('.cardArrow')), false, 'a resting arrow is grey')
  })

  test('the card keeps no hover flag in React — :hover does that job', () => {
    assert.equal(/useState\(/.test(CARD), false)
    assert.equal(/onMouseEnter|onMouseLeave/.test(CARD), false)
  })

  test('HOVER AND FOCUS ARE ONE LANGUAGE', () => {
    assert.ok(/\.card:hover,\s*\.card:focus-visible\s*\{/.test(CSS))
    assert.ok(/\.card:focus-visible\s*\{[^}]*outline:\s*2px solid #141922/.test(CSS))
    assert.ok(/\.card:active\s*\{/.test(CSS))
  })

  test('the drag handle is still absolutely positioned, so it costs no layout', () => {
    assert.ok(/\.dragHandle\s*\{[^}]*position:\s*absolute/.test(CSS))
  })

  test('THE TYPEFACE AND SURFACE ARE SCOPED TO THIS PAGE', () => {
    assert.match(baseRule('.launcher'), /font-family:\s*var\(--font-inter\)/,
      'Inter, which the root layout already loads')
    // Every rule that reaches outside the module is anchored on this page's
    // own launcher, so no other screen can match it.
    for (const line of stripCss(CSS).split('\n').filter(l => l.startsWith(':global('))) {
      assert.match(line, /:has\(\.launcher\)/, `unscoped global rule: ${line}`)
    }
    const ROOT_LAYOUT = read('src/app/layout.tsx')
    assert.match(ROOT_LAYOUT, /variable: '--font-inter'/, 'Inter is loaded once, at the root')
  })
})

// ── The responsive contract ──────────────────────────────────────────────────
describe('the launcher sizes itself from the width it actually has', () => {
  test('COLUMNS COME FROM CONTAINER QUERIES, not the viewport', () => {
    assert.ok(/\.launcher\s*\{[^}]*container-type:\s*inline-size/.test(CSS))
    assert.equal(/@media \(min-width/.test(CSS), false)
  })

  test('the compact grid steps 2 → 3 → 4 → 5, and never past five', () => {
    for (const [width, cols] of [[560, 3], [860, 4], [1120, 5]] as const) {
      const at = CSS.indexOf(`@container (min-width: ${width}px)`)
      assert.notEqual(at, -1, `the ${width}px step exists`)
      assert.match(CSS.slice(at, CSS.indexOf('}', CSS.indexOf('.grid', at))),
        new RegExp(`grid-template-columns:\\s*repeat\\(${cols}, minmax\\(0, 1fr\\)\\)`))
    }
    assert.equal(/repeat\([6-9], /.test(stripCss(CSS)), false)
  })

  test('THE PAGE ASKS FOR ONE 1440px CONTENT COLUMN', () => {
    const LAYOUT = read('src/components/layout/BoeOsLayout.tsx')
    assert.match(PAGE, /contentMaxWidth=\{1440\}/)
    assert.ok(LAYOUT.includes('boe-main-content-capped'))
  })

  test('a compact tile is a sensible width at 1920, 1366 and 1024', () => {
    // Launcher width = min(window - 260px sidebar - 44px gutters, 1440px
    // column); 14px between tiles.
    const tile = (window: number, cols: number) => {
      const grid = Math.min(window - 260 - 44, 1440)
      return (grid - (cols - 1) * 14) / cols
    }
    for (const [window, cols] of [[1920, 5], [1366, 4], [1024, 3]] as const) {
      const w = tile(window, cols)
      assert.ok(w > 200 && w < 300,
        `${cols} columns at ${window} give a ${Math.round(w)}px tile — too cramped or too empty`)
    }
  })

  test('nothing can push a tile wider than its column', () => {
    assert.ok(/\.title\s*\{[^}]*overflow-wrap:\s*anywhere/.test(CSS))
    assert.ok(/\.titleWrap\s*\{[^}]*min-width:\s*0/.test(CSS))
    assert.match(baseRule('.cardBody'), /min-width:\s*0/)
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

  test('a compact tile is white with the warm hairline', () => {
    assert.match(DESKTOP_CARD, /background:\s*#fff/i)
    assert.match(DESKTOP_CARD, /border:\s*1px solid #E7E3DE/i)
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
