/**
 * The Modules launcher's right-hand "Needs your attention" panel.
 *
 * Source-level, like the launcher's other suites: the panel moves notices that
 * already existed, so what matters is that it keeps their gates and never
 * leaves an empty shell behind.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const PAGE = read('src/app/modules/page.tsx')
const PANEL = read('src/app/modules/AttentionPanel.tsx')
const CSS = read('src/app/modules/modules.module.css')

describe('the attention panel is fed by the page\'s own gates', () => {
  test('Finance and Orders counts are null unless the person may open the module', () => {
    assert.match(PAGE, /financeUnread=\{mayOpenFinance \? financeCount\.count : null\}/)
    assert.match(PAGE, /ordersUnread=\{mayOpenOrders \? orderCount\.count : null\}/)
  })

  test('it is not drawn while arranging the cards', () => {
    assert.match(PAGE, /\{!editingOrder && \(\s*<AttentionPanel/)
  })

  test('the panel reuses the handover banner and the attendance approvals', () => {
    assert.match(PANEL, /<HandoverBanner \/>/)
    assert.match(PANEL, /<PendingApprovals userId=\{userId!\} inPanel \/>/)
  })

  test('a group with nothing to show is not drawn, and neither is an empty panel', () => {
    assert.match(PANEL, /if \(!showFinance && !showOrdersRow && !showAttendanceGroup\) return null/)
    assert.match(CSS, /\.attention:empty\s*\{\s*display:\s*none;/)
  })
})

describe('the panel sits beside the modules, then under them', () => {
  test('one flex-wrap shell, no viewport query', () => {
    assert.match(CSS, /\.launcherShell\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/)
    assert.match(CSS, /\.launcherShell > \.launcher\s*\{[^}]*flex:\s*999 1 640px;/)
  })
})
