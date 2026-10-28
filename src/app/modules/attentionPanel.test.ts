/**
 * The Modules launcher's "For you" panel (owner, 2026-10-29): a 280px column
 * docked to the window's right edge, holding only a new announcement, cash
 * handed to you, cash not with the company, and leave and late-arrival
 * requests — each one brief card with one action — plus Clear all. With
 * nothing to show it is not drawn and the tiles take the whole width.
 *
 * Source-level, like the launcher's other suites (there is no DOM harness for
 * this page): the panel moves things that already existed, so what matters is
 * that it shows only what was asked for, keeps every gate and writes only
 * through existing doors. Clear all's own rules are executed in
 * src/lib/modules/forYouSnooze.test.ts.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const PAGE = read('src/app/modules/page.tsx')
const PANEL = read('src/app/modules/AttentionPanel.tsx')
const CARD = read('src/app/modules/PendingApprovals.tsx')
const SHELL_CSS = read('src/app/modules/modules.module.css')
const CSS = read('src/app/modules/attentionPanel.module.css')

describe('only what was asked for', () => {
  test('no notification previews and no Orders group', () => {
    assert.equal(existsSync(join(process.cwd(), 'src/app/modules/NotificationPreviews.tsx')), false)
    const code = PANEL.replace(/\/\/.*$/gm, '')
    for (const gone of ['NotificationPreviews', 'useNotifications', 'Orders', 'financeUnread', 'ordersUnread']) {
      assert.equal(code.includes(gone), false, `${gone} is not in the panel`)
    }
  })

  test('the cards, in order: announcement, handed to you, cash, leave and late', () => {
    const order = ['<AnnouncementCard', '<AcceptCard', 'Not with the company ·', '<PendingApprovals']
      .map(s => PANEL.indexOf(s))
    assert.ok(order.every(i => i >= 0), 'each kind of card exists')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'and in this order')
  })

  test('each card is a brief with one action', () => {
    assert.match(PANEL, />\s*Read\s*</)
    assert.match(PANEL, />\s*Accept\s*</)
    assert.match(PANEL, />\s*Review\s*</)
    assert.match(CARD, />\s*Review\s*</)
  })
})

describe('cash handed to you — for everyone', () => {
  test('a handover whose recipient is the viewer and that they may accept', () => {
    assert.match(PANEL, /\.filter\(h => handoverRole\(h, viewerId\) === 'recipient' && h\.canAccept\)/)
  })

  test('Accept goes through the existing door, after the same confirmation', () => {
    assert.match(PANEL, /const \{ accept \} = useHandoverActions\(\)/)
    assert.match(PANEL, /await accept\.mutateAsync\(h\.id\)/)
    assert.match(PANEL, /confirmLabel=\{`Yes, I received \$\{formatINR\(h\.totalAmount\)\}`\}/)
    // Accepting custody never approves a payment (20270417000000).
    assert.equal(/approve_finance_payment_request|verify/i.test(PANEL.replace(/\/\/.*$/gm, '')), false)
  })
})

describe('cash not with the company', () => {
  test("reads Finance's own list, one card per person holding money", () => {
    assert.match(PANEL, /const unclosed = useUnclosedFunds\(\)/)
    assert.match(PANEL, /totalsByHolder\(payments\)/)
  })

  test('cash on its way to the viewer is not listed twice', () => {
    assert.match(PANEL, /\.filter\(p => !\(p\.openHandover && p\.openHandover\.recipientId === viewerId\)\)/)
  })

  test('Review opens Cash journeys only for somebody who may open Finance', () => {
    assert.match(PAGE, /financeAllowed: mayOpenFinance,/)
    assert.match(PANEL, /\{financeAllowed && \(\s*<Link\s*href=\{`\$\{CASH_JOURNEYS_PATH\}\?holder=/)
  })
})

describe('the newest announcement', () => {
  test('only while unread, and Read opens its page', () => {
    assert.match(PANEL, /latestAnnouncement && !latestAnnouncement\.read_at/)
    assert.match(PANEL, /href=\{`\/announcements\/\$\{latest\.id\}`\}/)
  })
})

describe('Clear all', () => {
  test('hides every card showing, through the snooze helpers', () => {
    assert.match(PANEL, /clearAll: \(\) => snooze\.clear\(visibleKeys\)/)
    assert.match(PANEL, /onClick=\{s\.clearAll\}/)
    // Every kind of card is filtered by it, the requests included.
    for (const k of ['itemKeys.announcement(', 'itemKeys.handover(', 'itemKeys.holder(', 'itemKeys.request(']) {
      assert.ok(PANEL.includes(k), `${k} is filtered`)
    }
    assert.match(CARD, /queue\.rows\.filter\(r => isShown\(itemKeys\.request\(r\.id\)\)\)/)
  })

  test('remembered per user in this browser, and expires on its own', () => {
    assert.match(PANEL, /window\.localStorage\.setItem\(snoozeStorageKey\(userId\)/)
    assert.match(PANEL, /window\.setTimeout\(\(\) => setState\(EMPTY_SNOOZE\)/)
  })
})

describe('when the panel is drawn', () => {
  test('neither the panel nor the strip while arranging the cards', () => {
    assert.match(PAGE, /\{!editingOrder && <AttentionPanel \{\.\.\.attentionSources\} \/>\}/)
    assert.match(PAGE, /\{!editingOrder && <AttentionStrip \{\.\.\.attentionSources\} \/>\}/)
  })

  test('NOTHING TO SHOW, NO PANEL — and no "caught up" line', () => {
    assert.match(PANEL, /if \(s\.itemCount === 0 && !errors\) return null/)
    assert.equal(PANEL.includes('caught up'), false)
  })
})

describe('docked to the right edge at 280px, full width again without it', () => {
  test('fixed to the right edge, 280px, full height, from 1132px of window', () => {
    const at = CSS.indexOf('@media (min-width: 1132px)')
    assert.notEqual(at, -1)
    const docked = CSS.slice(at)
    assert.match(docked, /\.attention\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*280px;/)
  })

  test('the page reserves that width only while the panel is drawn', () => {
    assert.match(CSS, /:global\(\.boe-main-content\):has\(\.attention\) > :global\(\.boe-page-body\)\s*\{\s*padding-right:\s*calc\(280px \+ 24px\);/)
    assert.match(CSS, /:global\(\.boe-main-content\):has\(\.attention\) > :global\(\.boe-page-header\),/)
  })

  test('narrower, it wraps below the tiles and a strip jumps to it', () => {
    assert.match(SHELL_CSS, /\.launcherShell\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/)
    assert.match(SHELL_CSS, /\.launcherShell > \.launcher\s*\{[^}]*flex:\s*999 1 640px;/)
    assert.match(CSS, /\.attention\s*\{[^}]*flex:\s*1 1 100%;/)
    assert.match(CSS, /@media \(max-width: 1131px\)\s*\{\s*\.attentionStrip\s*\{\s*display:\s*flex;/)
    assert.match(PANEL, /href="#for-you"/)
    assert.match(PANEL, /<aside id="for-you"/)
  })
})
