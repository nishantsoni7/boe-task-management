/**
 * The workflow tab strip, RENDERED.
 *
 * WHY THIS EXISTS. "Awaiting Approval" was reported missing from the running
 * page while the source plainly contained it, and every test in the suite
 * asserted on source text — which cannot tell "the tab is not in the code" from
 * "the tab is in the code but never reaches the DOM". This renders the real
 * component to markup and looks for the tab in the output.
 *
 * No test framework is added: React DOM's server renderer is already a
 * dependency, and static markup is enough to answer "is it in the tree, with
 * the right count, at this width".
 *
 * Run:
 *   npx tsx --test src/components/tasks/MyTaskViewTabs.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { MyTaskViewTabs, MY_TASK_VIEW_TABS } from './MyTaskViewTabs'
import {
  AWAITING_APPROVAL_LABEL,
  MY_TASK_TAB_KEYS,
  ACTIVE_WORKING_TABS,
  type MyTaskTabKey,
} from '@/lib/tasks/myTaskTabs'

const zeroCounts = () => {
  const c = {} as Record<MyTaskTabKey, number>
  for (const k of MY_TASK_TAB_KEYS) c[k] = 0
  return c
}

const render = (over: Partial<Parameters<typeof MyTaskViewTabs>[0]> = {}) =>
  renderToStaticMarkup(
    <MyTaskViewTabs
      activeTab={null}
      counts={zeroCounts()}
      onSelect={() => {}}
      {...over}
    />,
  )

describe('the strip renders five tabs', () => {
  test('all five labels reach the markup at desktop width', () => {
    const html = render()
    for (const label of ['Today Actionable', 'Overdue Actionable', 'Future Actionable',
                         'Waiting / Blocked', 'Awaiting Approval']) {
      assert.ok(html.includes(label), `"${label}" is missing from the rendered strip`)
    }
  })

  test('and at mobile width', () => {
    const html = render({ isMobile: true })
    assert.ok(html.includes(AWAITING_APPROVAL_LABEL))
    assert.equal((html.match(/role="tab"/g) ?? []).length, 5)
  })

  test('Awaiting Approval sits beside Waiting / Blocked, last', () => {
    assert.deepEqual(MY_TASK_VIEW_TABS.map(t => t.key), [
      'today_actionable', 'overdue_actionable', 'future_actionable',
      'waiting_blocked', 'awaiting_approval',
    ])
    const html = render()
    assert.ok(html.indexOf('Waiting / Blocked') < html.indexOf(AWAITING_APPROVAL_LABEL))
  })

  test('exactly five buttons, one per configured tab', () => {
    const html = render()
    assert.equal((html.match(/<button/g) ?? []).length, MY_TASK_VIEW_TABS.length)
    assert.equal(MY_TASK_VIEW_TABS.length, 5)
  })
})

describe('badges come from the counts it is given', () => {
  test('each tab renders its own number', () => {
    const counts = zeroCounts()
    counts.today_actionable   = 3
    counts.overdue_actionable = 11
    counts.waiting_blocked    = 2
    counts.awaiting_approval  = 4
    const html = render({ counts })
    // The Awaiting Approval badge is present and carries its own count.
    const at = html.indexOf(AWAITING_APPROVAL_LABEL)
    assert.ok(at > -1)
    assert.ok(html.slice(at, at + 400).includes('>4<'), 'the Awaiting Approval badge shows 4')
    assert.ok(html.includes('>3<') && html.includes('>11<') && html.includes('>2<'))
  })

  test('a zero count still renders — the tab never disappears', () => {
    const html = render({ counts: zeroCounts() })
    assert.ok(html.includes(AWAITING_APPROVAL_LABEL))
    assert.equal((html.match(/>0</g) ?? []).length, 5)
  })
})

describe('nothing is hidden off-screen without an affordance', () => {
  test('the mobile strip WRAPS rather than scrolling with a hidden scrollbar', () => {
    // The failure mode this guards: a tab that is present, reachable in
    // principle, and invisible in practice because the strip scrolls
    // horizontally with `scrollbar-width:none` and nothing says to swipe.
    const html = render({ isMobile: true })
    assert.ok(html.includes('flex-wrap:wrap'), 'mobile must wrap so every tab is on screen')
    assert.equal(html.includes('scrollbar-width:none'), false, 'no hidden-scrollbar affordance')
    assert.equal(/overflow-x:\s*auto/.test(html), false, 'nothing is pushed out of view')
  })

  test('the desktop strip stays on one row', () => {
    assert.ok(render().includes('flex-wrap:nowrap'))
  })

  test('no tab is rendered with display:none or visibility:hidden', () => {
    for (const html of [render(), render({ isMobile: true })]) {
      assert.equal(/display:\s*none/.test(html), false)
      assert.equal(/visibility:\s*hidden/.test(html), false)
    }
  })
})

describe('the strip and the classifier agree', () => {
  test('every configured tab key is a real classifier bucket', () => {
    for (const tab of MY_TASK_VIEW_TABS) {
      assert.ok(MY_TASK_TAB_KEYS.includes(tab.key), `${tab.key} is not a bucket`)
    }
  })

  test('four of the five are actionable; Awaiting Approval is not', () => {
    const actionable = MY_TASK_VIEW_TABS.filter(t => ACTIVE_WORKING_TABS.includes(t.key))
    assert.equal(actionable.length, 4)
    assert.equal(ACTIVE_WORKING_TABS.includes('awaiting_approval'), false)
  })

  test('the selected tab is marked, and only it', () => {
    const html = render({ activeTab: 'awaiting_approval' })
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
    const at = html.indexOf('aria-selected="true"')
    assert.ok(html.slice(at, at + 600).includes(AWAITING_APPROVAL_LABEL))
  })
})
