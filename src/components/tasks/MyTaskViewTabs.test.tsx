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
import {
  MyTaskViewTabs,
  MyTaskViewSelect,
  MY_TASK_VIEW_TABS,
  ALL_ACTIVE_TASKS_LABEL,
} from './MyTaskViewTabs'
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

const renderSelect = (over: Partial<Parameters<typeof MyTaskViewSelect>[0]> = {}) =>
  renderToStaticMarkup(
    <MyTaskViewSelect
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

  test('and on mobile the strip stands down entirely', () => {
    // The five-tab strip is desktop-only. It must not render a half-strip or a
    // hidden one on a phone — the choices move to MyTaskViewSelect, asserted
    // below, and the strip contributes nothing.
    assert.equal(render({ isMobile: true }), '')
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
  test('every workflow choice is reachable on mobile, in the dropdown', () => {
    // Same guarantee the wrapped strip used to provide, and the same failure
    // mode it guarded: no choice may be present in the code and unreachable on
    // a phone. A select shows every option it holds, so the assertion is that
    // all six are in it.
    const html = renderSelect()
    for (const label of [ALL_ACTIVE_TASKS_LABEL, 'Today Actionable', 'Overdue Actionable',
                         'Future Actionable', 'Waiting / Blocked', AWAITING_APPROVAL_LABEL]) {
      assert.ok(html.includes(label), `"${label}" is missing from the mobile dropdown`)
    }
    assert.equal((html.match(/<option/g) ?? []).length, MY_TASK_VIEW_TABS.length + 1)
    assert.equal(html.includes('scrollbar-width:none'), false, 'no hidden-scrollbar affordance')
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

describe('the mobile dropdown', () => {
  test('carries each choice with its own live count', () => {
    const counts = zeroCounts()
    counts.all                = 13
    counts.today_actionable   = 3
    counts.overdue_actionable = 11
    counts.awaiting_approval  = 4
    const html = renderSelect({ counts })
    assert.ok(html.includes(`${ALL_ACTIVE_TASKS_LABEL} (13)`))
    assert.ok(html.includes('Today Actionable (3)'))
    assert.ok(html.includes('Overdue Actionable (11)'))
    assert.ok(html.includes(`${AWAITING_APPROVAL_LABEL} (4)`))
  })

  test('the default no-tab state is an option, not a blank', () => {
    // The page opens with no tab selected. A select always shows something, so
    // that state has to be named — an empty first option would read as a
    // broken tab rather than as "every active task".
    const html = renderSelect({ activeTab: null })
    const first = html.match(/<option value=""[^>]*selected[^>]*>([^<]*)</);
    assert.ok(first, `the default option must be the selected one`)
    assert.ok(first[1].startsWith(ALL_ACTIVE_TASKS_LABEL), `it is named "${ALL_ACTIVE_TASKS_LABEL}", got "${first[1]}"`)
  })

  test('a selected tab is the one the select reports', () => {
    const html = renderSelect({ activeTab: 'awaiting_approval' })
    const opt = html.match(/<option value="awaiting_approval"[^>]*selected[^>]*>/)
    assert.ok(opt, 'the chosen tab must be the selected option')
  })

  test('zero counts still render — no choice disappears', () => {
    const html = renderSelect({ counts: zeroCounts() })
    assert.equal((html.match(/\(0\)/g) ?? []).length, MY_TASK_VIEW_TABS.length + 1)
  })
})
