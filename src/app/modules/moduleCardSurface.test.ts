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

const ROOT = process.cwd()
// \r is stripped on read. A rebase or a fresh clone under core.autocrlf can
// hand these files back with CRLF endings, and every multi-line assertion below
// would then look for a substring that is really there.
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

const PAGE = read('src/app/modules/page.tsx')
const CSS = read('src/app/modules/modules.module.css')

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

describe('the WHOLE card is one control', () => {
  test('exactly one element carries onClick, and it is the card root', () => {
    const handlers = CARD.match(/onClick=/g) ?? []
    assert.equal(handlers.length, 1,
      'a second onClick would be a duplicate navigation handler')
    // It is on the root: the first element of the returned tree, before the
    // icon wrapper. Everything inside it — the icon, the badge, the name and
    // the empty space around them — therefore activates the same handler.
    assert.ok(CARD.indexOf('onClick={onClick}') < CARD.indexOf(styleClass('iconWrap')))
  })

  test('there is no nested link or button inside the card', () => {
    // Comments stripped first: the keyboard handler is explained in prose that
    // names <button>, and that sentence is not an element.
    const markup = CARD.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal(/<a\b/.test(markup), false, 'no anchor may nest inside a role="button"')
    assert.equal(/<button\b/.test(markup), false, 'and no nested button either')
    assert.equal(/<Link\b/.test(markup), false, 'and no next/link')
    const roles = markup.match(/role="/g) ?? []
    assert.equal(roles.length, 1, 'one role on the card, none inside it')
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
    assert.ok(CARD.includes('role="button"'))
    assert.ok(CARD.includes('tabIndex={0}'))
  })

  test('BOTH Enter and Space activate it', () => {
    assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(CARD),
      'role="button" promises both, as a native <button> gives both')
    assert.ok(CARD.includes('onKeyDown'))
  })

  test('Space does not also scroll the page', () => {
    // Space is the browser's page-scroll key. Without preventDefault, activating
    // a focused card would open the module AND scroll the launcher behind it.
    const handler = CARD.slice(CARD.indexOf('onKeyDown'), CARD.indexOf('className={styles.card}'))
    assert.ok(handler.includes('e.preventDefault()'))
    assert.ok(handler.indexOf('e.preventDefault()') < handler.indexOf('onClick()'),
      'the default is cancelled before navigating')
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

  test('DESKTOP IS NOT CENTRED — the change is scoped to the breakpoint', () => {
    const base = CSS.slice(0, CSS.indexOf('@media'))
    const cardRule = base.slice(base.indexOf('.card'), base.indexOf('}', base.indexOf('.card')))
    assert.equal(/align-items:\s*center/.test(cardRule), false,
      'the desktop card does not centre its children on the cross axis')
    assert.equal(/text-align:\s*center/.test(cardRule), false,
      'the desktop card keeps its left edge')
    // justify-content IS centred, and is the MAIN axis of a column: it splits
    // the min-height slack above and below the icon/name pair. That is vertical
    // and says nothing about the left edge.
    assert.ok(/justify-content:\s*center/.test(cardRule))
    assert.ok(/\.iconWrap\s*\{[^}]*align-self:\s*flex-start/.test(base),
      'and the desktop icon stays at the left edge')
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

/** `className={styles.x}`, written once so a rename is a single edit. */
function styleClass(name: string): string {
  return `styles.${name}`
}
