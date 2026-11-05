// Phones, content first (owner, 2026-11-05), Phase 1: the shared pieces every
// module's phone layout now leans on.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { PhoneHeaderMenu } from './PhoneHeaderMenu'
import { PhoneTableCards } from '@/components/ui/PhoneTableCards'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}
const read = (p: string) => readFileSync(p, 'utf8')
const css = read('src/app/globals.css')

describe('the phone header menu', () => {
  const items = [
    { key: 'a', label: 'Hand over cash', onSelect: noop },
    { key: 'b', label: 'Switch to Order Management', onSelect: noop, primary: true },
  ]

  test('closed: one phone-only icon button with an accessible name', () => {
    const html = renderToStaticMarkup(<PhoneHeaderMenu label="More actions" items={items} />)
    assert.ok(html.includes('boe-phone-only'))
    assert.ok(html.includes('aria-label="More actions"'))
    assert.equal(html.includes('role="dialog"'), false)
  })

  test('open: a sheet with every item, the primary one filled', () => {
    const html = renderToStaticMarkup(<PhoneHeaderMenu label="More actions" items={items} initiallyOpen />)
    assert.ok(html.includes('role="dialog"'))
    assert.ok(text(html).includes('Hand over cash'))
    assert.equal((html.match(/is-primary/g) ?? []).length, 1)
  })

  test('nothing to offer, nothing drawn', () => {
    assert.equal(renderToStaticMarkup(<PhoneHeaderMenu label="More actions" items={[]} />), '')
  })

  test('its sheet classes do not collide with the Payroll dialog (.boe-sheet)', () => {
    const src = read('src/components/layout/PhoneHeaderMenu.tsx')
    assert.equal(/"boe-sheet[ "-]/.test(src), false)
    assert.ok(src.includes('boe-psheet'))
  })
})

describe('every layout keeps its header one row on a phone', () => {
  test('Finance: Hand over cash and the switch move into the ⋯ menu', () => {
    const f = read('src/components/layout/FinanceLayout.tsx')
    assert.ok(f.includes('className="boe-btn boe-btn-secondary boe-desktop-only"'))
    assert.ok(f.includes("key: 'handover', label: 'Hand over cash'"))
    assert.ok(f.includes("useModuleSwitch('orders')"))
  })

  test('Orders: the switch is in the ⋯ menu', () => {
    const o = read('src/components/layout/OrdersLayout.tsx')
    assert.ok(o.includes("useModuleSwitch('finance')"))
    assert.ok(o.includes('<PhoneHeaderMenu'))
  })

  test('the switch button and the menu ask one visibility rule', () => {
    const m = read('src/components/layout/ModuleSwitchButton.tsx')
    assert.ok(m.includes('export function useModuleSwitch('))
    assert.ok(m.includes('const { visible, label, short, route } = useModuleSwitch(target)'))
    assert.ok(m.includes('boe-module-switch boe-desktop-only'))
  })

  test('Task Management: Self Task and Delegate Task become one "+"', () => {
    const d = read('src/components/layout/DashboardLayout.tsx')
    assert.equal((d.match(/boe-desktop-only/g) ?? []).length, 2)
    assert.ok(d.includes('label="New task"'))
    assert.ok(d.includes('kind="add"'))
  })

  test('Samples has a menu button, so its tabs and Notifications are reachable on a phone', () => {
    const s = read('src/components/layout/SamplesLayout.tsx')
    assert.ok(s.includes('className="boe-menu-toggle"'))
    assert.ok(s.includes("boe-sidebar${sidebarOpen ? ' open' : ''}"))
  })

  test('the phone header rule: one line of title, one line of subtitle', () => {
    const at = css.indexOf('PHONES: CONTENT FIRST')
    assert.ok(at > 0)
    const block = css.slice(at, at + 3000)
    assert.ok(block.includes('.boe-page-title-group { flex: 1 1 140px; min-width: 0; }'))
    assert.ok(/\.boe-page-subtitle \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/.test(block))
  })
})

describe('cards, filters and tables on a phone', () => {
  test('number cards are a chip row and drop the line under the number', () => {
    assert.ok(css.includes('.fin-stats, .fin-stats[style] {'))
    assert.ok(css.includes('.fin-stat-sub { display: none !important; }'))
  })

  test('a filter chip opens as a sheet from the bottom of the screen', () => {
    assert.ok(css.includes('.fin-chip[open] > summary::after {'))
    assert.ok(/\.fin-chip-panel, \.fin-chip\[open\] \.fin-chip-panel \{\s*position: fixed;/.test(css))
  })

  test('PhoneTableCards wraps a table and the Control Center tables use it', () => {
    const html = renderToStaticMarkup(<PhoneTableCards className="x"><table><tbody><tr><td>1</td></tr></tbody></table></PhoneTableCards>)
    assert.ok(html.startsWith('<div class="boe-cardtable x">'))
    assert.ok(read('src/components/controlCenter/CcPrimitives.tsx').includes('<PhoneTableCards className={s.tableWrap}>'))
    assert.ok(css.includes('.boe-cardtable tbody td[data-label]::before {'))
  })

  test('Notifications: 44px tools and 40px pills on a phone', () => {
    const n = read('src/components/notifications/NotificationsView.tsx')
    assert.equal((n.match(/className="boe-notif-tool"/g) ?? []).length, 3)
    assert.ok(n.includes('className="boe-notif-pill"'))
    assert.ok(css.includes('.boe-notif-tool { min-height: 44px; min-width: 44px;'))
  })

  test('status tabs are 44px on a phone', () => {
    assert.ok(read('src/components/ui/StatusTabs.tsx').includes('className="boe-status-tab"'))
    assert.ok(css.includes('.boe-status-tab { min-height: 44px; }'))
  })
})
