/**
 * The Dashboard's "At a glance" bar (owner, 2026-10-29): the three counters
 * (Overdue, Waiting, Due Today) and Tasks Created moved from the bottom of the
 * page into a 280px bar docked to the window's right edge, built like the
 * Modules page's "For you" panel. Narrower than 1132px it falls under Needs
 * Your Attention, where those two sections were.
 *
 * Source-level, like the Dashboard's other suites (there is no DOM harness for
 * this page): the bar moves things that already existed, so what matters is
 * that the counts, labels and the open-a-list rule are the same ones, and that
 * the page no longer draws them twice.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const PAGE = read('src/app/dashboard/page.tsx')
const BAR = read('src/app/dashboard/GlanceBar.tsx')
const CSS = read('src/app/dashboard/glanceBar.module.css')
const REPORT = read('src/components/tasks/TaskCreationReport.tsx')

describe('the page draws the bar and nothing it replaced', () => {
  test('one GlanceBar, fed the lists the page already computes', () => {
    assert.equal(PAGE.split('<GlanceBar').length - 1, 1)
    assert.match(PAGE, /<GlanceBar\s+overdueTasks=\{overdueTasks\}\s+waitingTasks=\{waitingTasks\}\s+dueTodayTasks=\{dueTodayTasks\}\s+creationReport=\{creationReport\}\s+onShowList=\{setPreviewList\}/)
  })

  test('the old counters strip and the Tasks Created section are gone from the page', () => {
    assert.equal(PAGE.includes('OperationalStatusPanel'), false)
    assert.equal(PAGE.includes('title="Tasks Created"'), false)
    assert.equal(PAGE.includes('TaskCreationReportCard'), false)
  })

  test('the bar comes after Needs Your Attention, so a narrow screen shows it there', () => {
    assert.ok(PAGE.indexOf('title="Needs Your Attention"') < PAGE.indexOf('<GlanceBar'))
  })
})

describe('same counts, same labels, same rule', () => {
  test('Overdue, Waiting, Due Today in that order, with their lists and drawer titles', () => {
    const order = [
      "label: 'Overdue',   sub: 'Needs attention', items: overdueTasks,  title: 'Overdue Tasks'",
      "label: 'Waiting',   sub: 'Pending action',  items: waitingTasks,  title: 'Waiting Tasks'",
      "label: 'Due Today', sub: 'Finish today',    items: dueTodayTasks, title: 'Due Today'",
    ].map(s => BAR.indexOf(s))
    assert.ok(order.every(i => i >= 0), 'each counter exists')
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })

  test('a counter opens its list only when it has one', () => {
    assert.match(BAR, /\{count > 0 \? \(\s*<button/)
    assert.ok(BAR.includes('onClick={() => onShowList({ title: item.title, items: item.items })}'))
    // The 0 branch is a plain box: no handler, nothing to click.
    const idle = BAR.slice(BAR.indexOf(') : ('), BAR.indexOf('</li>'))
    assert.equal(idle.includes('onClick'), false)
  })

  test('only Overdue is red', () => {
    assert.equal(BAR.split('alarm: true').length - 1, 1)
    assert.match(CSS, /\.countAlarm\s*\{\s*color:\s*#B42332;/)
  })

  test('Tasks created keeps its two rows and both windows', () => {
    for (const s of ["label: 'Self tasks'", "label: 'Delegated tasks'", '>7 days<', '>30 days<', 'report?.self7', 'report?.self30', 'report?.delegated7', 'report?.delegated30']) {
      assert.ok(REPORT.includes(s), `${s} is in the table`)
    }
    assert.ok(BAR.includes('<TaskCreationReportCard report={creationReport} />'))
  })
})

describe('docked to the right edge at 280px, like the Modules panel', () => {
  test('fixed to the right edge, 280px, full height, from 1132px of window', () => {
    const docked = CSS.slice(CSS.indexOf('@media (min-width: 1132px)'))
    assert.match(docked, /\.glance\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*280px;/)
    assert.match(docked, /overflow-y:\s*auto;/)
  })

  test('the header and body reserve its width, only while it is drawn', () => {
    assert.match(CSS, /:global\(\.boe-main-content\):has\(\.glance\) > :global\(\.boe-page-header\),/)
    assert.match(CSS, /:global\(\.boe-main-content\):has\(\.glance\) > :global\(\.boe-page-body\)\s*\{\s*padding-right:\s*calc\(280px \+ 24px\);/)
  })

  test('the last card scrolls clear of the floating round buttons', () => {
    assert.match(CSS, /padding-bottom:\s*150px;/)
  })

  test('under the drawers: the list and task drawers sit at 40 and 50', () => {
    assert.match(CSS, /z-index:\s*25;/)
  })
})
