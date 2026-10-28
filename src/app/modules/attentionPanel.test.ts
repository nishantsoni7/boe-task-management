/**
 * The Modules launcher's "For you" panel: what waits on you first, then each
 * module's newest unread updates.
 *
 * Source-level, like the launcher's other suites (there is no DOM harness for
 * this page): the panel moves notices that already existed, so what matters is
 * that it keeps their gates, splits action from information, and never stretches
 * the page.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const PAGE = read('src/app/modules/page.tsx')
const PANEL = read('src/app/modules/AttentionPanel.tsx')
const PREVIEWS = read('src/app/modules/NotificationPreviews.tsx')
const SHELL_CSS = read('src/app/modules/modules.module.css')
const CSS = read('src/app/modules/attentionPanel.module.css')

describe("the panel is fed by the page's own gates", () => {
  test('Finance and Orders counts are null unless the person may open the module', () => {
    assert.match(PAGE, /financeUnread: mayOpenFinance \? financeCount\.count : null,/)
    assert.match(PAGE, /ordersUnread: mayOpenOrders \? orderCount\.count : null,/)
  })

  test('neither the panel nor the strip is drawn while arranging the cards', () => {
    assert.match(PAGE, /\{!editingOrder && <AttentionPanel \{\.\.\.attentionSources\} \/>\}/)
    assert.match(PAGE, /\{!editingOrder && <AttentionStrip \{\.\.\.attentionSources\} \/>\}/)
  })

  test('a module group is mounted only when its count says there is something', () => {
    // The preview list fetches as soon as it mounts, so it must sit behind the
    // count, and the count is null for anybody who may not open the module.
    assert.match(PANEL, /\{financeCount > 0 && \(\s*<NotificationPreviews category="finance"/)
    assert.match(PANEL, /\{ordersCount > 0 && \(\s*<section/)
  })

  test('no panel at all for somebody with no source', () => {
    assert.match(PANEL, /if \(!s\.hasSource\) return null/)
  })
})

describe('action first, information second', () => {
  test('Waiting on you holds handovers handed to you and the attendance queue', () => {
    assert.ok(PANEL.indexOf('Waiting on you') < PANEL.indexOf('updates-finance-heading'))
    assert.match(PANEL, /\{s\.toAccept\.map\(h => <HandoverAction/)
    assert.match(PANEL, /<PendingApprovals userId=\{userId\} \/>/)
  })

  test('an action says how long it has waited and has a Review button', () => {
    assert.match(PANEL, /waiting \{waitingFor\(h\.ageHours\)\}/)
    assert.match(PANEL, />\s*Review\s*</)
  })

  test('the empty Waiting block is hidden rather than drawn as a bare heading', () => {
    assert.match(CSS, /\.waiting:not\(:has\(li\)\)\s*\{\s*display:\s*none;/)
  })

  test('nothing pending is one "caught up" line, only once every count is known', () => {
    assert.match(PANEL, /const caughtUp = s\.known && s\.actCount === 0 && s\.updateCount === 0/)
    assert.match(PANEL, /You&rsquo;re all caught up\./)
  })
})

describe('updates are previews that open their record', () => {
  test('a row marks its notification read and goes where the Notifications page would', () => {
    assert.match(PREVIEWS, /href=\{meta\.href \?\? allHref\}/)
    assert.match(PREVIEWS, /onClick=\{\(\) => markRead\(n\.id\)\}/)
  })

  test('three per module, then a link to the rest', () => {
    assert.match(PREVIEWS, /export const PREVIEW_LIMIT = 3/)
    assert.match(PREVIEWS, /\{more\} more in \{moduleName\} →/)
  })

  test('a row is cut to its two lines, so one long title cannot stretch the panel', () => {
    assert.match(CSS, /\.updateTitle,\s*\.updateDetail\s*\{[^}]*text-overflow:\s*ellipsis;/)
  })
})

describe('the panel sits beside the modules, then under them', () => {
  test('one flex-wrap shell, no viewport query for the columns', () => {
    assert.match(SHELL_CSS, /\.launcherShell\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/)
    assert.match(SHELL_CSS, /\.launcherShell > \.launcher\s*\{[^}]*flex:\s*999 1 640px;/)
    assert.match(CSS, /\.attention\s*\{[^}]*flex:\s*1 1 340px;/)
  })

  test("the panel's text-cutting rules stay out of the tiles' stylesheet", () => {
    assert.equal(/text-overflow/.test(SHELL_CSS), false)
  })

  test('the phone strip shows only where the panel has wrapped below the tiles', () => {
    assert.match(CSS, /\.attentionStrip\s*\{\s*display:\s*none;/)
    assert.match(CSS, /@media \(max-width: 1131px\)\s*\{\s*\.attentionStrip\s*\{\s*display:\s*flex;/)
    assert.match(PANEL, /href="#for-you"/)
    assert.match(PANEL, /<aside id="for-you"/)
  })
})
