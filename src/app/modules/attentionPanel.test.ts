/**
 * The Modules launcher's "For you" panel (owner, 2026-10-29): only a new
 * announcement, cash handed to you, cash not with the company, and leave and
 * late-arrival requests.
 *
 * Source-level, like the launcher's other suites (there is no DOM harness for
 * this page): the panel moves things that already existed, so what matters is
 * that it shows only what was asked for, keeps every gate and writes only
 * through existing doors.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const PAGE = read('src/app/modules/page.tsx')
const PANEL = read('src/app/modules/AttentionPanel.tsx')
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

  test('the four sections, in order', () => {
    const order = ['<AnnouncementItem', 'Cash handed to you', 'Cash not with the company', 'Leave and late arrival']
      .map(s => PANEL.indexOf(s))
    assert.ok(order.every(i => i >= 0), 'each section exists')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'and in this order')
  })
})

describe('cash handed to you — for everyone', () => {
  test('a handover whose recipient is the viewer and that they may accept', () => {
    assert.match(PANEL, /const toAccept = mine\.filter\(h => handoverRole\(h, viewerId\) === 'recipient' && h\.canAccept\)/)
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
  test("reads Finance's own list, one row per person holding money", () => {
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
  test('only while unread, and it links to its page', () => {
    assert.match(PANEL, /latestAnnouncement && !latestAnnouncement\.read_at \? latestAnnouncement : null/)
    assert.match(PANEL, /href=\{`\/announcements\/\$\{latest\.id\}`\}/)
  })
})

describe('when the panel is drawn', () => {
  test('neither the panel nor the strip while arranging the cards', () => {
    assert.match(PAGE, /\{!editingOrder && <AttentionPanel \{\.\.\.attentionSources\} \/>\}/)
    assert.match(PAGE, /\{!editingOrder && <AttentionStrip \{\.\.\.attentionSources\} \/>\}/)
  })

  test('no panel for somebody with nothing in it and nothing that regularly comes', () => {
    assert.match(PANEL, /const show = s\.itemCount > 0 \|\| s\.handoversError \|\| s\.cashError \|\| s\.regular/)
    assert.match(PANEL, /const regular = unclosed\.data\?\.scope === 'all' \|\| showAttendance/)
  })

  test('"caught up" only once every list is in', () => {
    assert.match(PANEL, /const caughtUp = s\.known && s\.itemCount === 0/)
    assert.match(PANEL, /You&rsquo;re all caught up\./)
  })

  test('the leave group is hidden while it holds no row', () => {
    assert.match(CSS, /\.group:not\(:has\(li\)\)\s*\{\s*display:\s*none;/)
  })
})

describe('the panel sits beside the modules, then under them', () => {
  test('one flex-wrap shell, no viewport query for the columns', () => {
    assert.match(SHELL_CSS, /\.launcherShell\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/)
    assert.match(SHELL_CSS, /\.launcherShell > \.launcher\s*\{[^}]*flex:\s*999 1 640px;/)
    assert.match(CSS, /\.attention\s*\{[^}]*flex:\s*1 1 340px;/)
  })

  test('the phone strip shows only where the panel has wrapped below the tiles', () => {
    assert.match(CSS, /\.attentionStrip\s*\{\s*display:\s*none;/)
    assert.match(CSS, /@media \(max-width: 1131px\)\s*\{\s*\.attentionStrip\s*\{\s*display:\s*flex;/)
    assert.match(PANEL, /href="#for-you"/)
    assert.match(PANEL, /<aside id="for-you"/)
  })
})
