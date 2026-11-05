// Phone phase 3 (owner, 2026-11-05, "phones: content first"): Tasks, Meetings,
// Control Center, Performance, Assets, Super Admin, Settings, My Issues, My
// Credits, Manager and Dashboard on a phone. The shared list tools render, the
// pages use them, and every phone rule stays inside a phone media query.
//
// Run:
//   npx tsx --import ./scripts/testing/screen-source-preload.mjs --test src/app/tasks/phoneTasksAdmin.render.test.tsx

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { PhoneChips, PhoneSearchFilter, showResultsLabel } from '@/components/tasks/PhoneListTools'
import { ArchiveToolbar, ArchiveSelect } from '@/components/tasks/CancelledArchive'
import { isTaskCreateActionsHiddenRoute } from '@/lib/tasks/taskCreateActions'

const read = (p: string) => readFileSync(p, 'utf8')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}

describe('PhoneChips', () => {
  const html = renderToStaticMarkup(
    <PhoneChips
      label="Task view"
      active="today"
      onSelect={noop}
      chips={[
        { key: 'all', label: 'All Active', count: 9 },
        { key: 'today', label: 'Today', count: 3 },
        { key: 'waiting', label: 'Waiting / Blocked', count: 0 },
      ]}
    />,
  )
  test('one button per chip with its count, named by its own label', () => {
    assert.equal(text(html), 'All Active 9 Today 3 Waiting / Blocked 0')
    assert.ok(html.includes('aria-label="Task view"'))
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.equal((html.match(/is-zero/g) ?? []).length, 1)
  })
})

describe('PhoneSearchFilter', () => {
  const groups = [
    { id: 'priority', label: 'Priority', value: 'high', onChange: noop, options: [{ value: '', label: 'All' }, { value: 'high', label: 'High' }] },
  ]
  test('closed: a search box and one Filter button with the count set', () => {
    const html = renderToStaticMarkup(
      <PhoneSearchFilter
        search={{ value: '', onChange: noop, placeholder: 'Find tasks…', label: 'Find tasks' }}
        groups={groups} activeCount={1} resultCount={4} noun={['task', 'tasks']} onClearAll={noop}
      />,
    )
    assert.ok(html.includes('aria-label="Find tasks"'))
    assert.ok(html.includes('aria-label="Filter, 1 set"'))
    assert.equal(html.includes('role="dialog"'), false)
  })
  test('open: the groups, the chosen option pressed, and the page\'s own noun', () => {
    const html = renderToStaticMarkup(
      <PhoneSearchFilter groups={groups} activeCount={1} resultCount={1} noun={['meeting', 'meetings']} onClearAll={noop} initiallyOpen />,
    )
    assert.ok(html.includes('role="dialog"'))
    assert.ok(text(html).includes('Show 1 meeting'))
    assert.equal(text(html).includes('order'), false, 'never says "orders" outside Orders')
    assert.equal(showResultsLabel(12, ['task', 'tasks']), 'Show 12 tasks')
  })
  test('the cancelled archives move their selects into the sheet', () => {
    const html = renderToStaticMarkup(
      <ArchiveToolbar searchInput="" onSearch={noop} onSearchBlur={noop} phone={{ activeCount: 0, resultCount: 3, onClearAll: noop }}>
        <ArchiveSelect value="" label="Priority" onChange={noop}><option value="">All priorities</option></ArchiveSelect>
      </ArchiveToolbar>,
    )
    assert.ok(html.includes('boe-p3-tools'), 'phone tools are drawn')
    assert.ok(html.includes('boe-p3-desk'), 'the desktop toolbar is marked desktop-only')
  })
})

describe('the pages use the phone pieces', () => {
  const uses: [string, string][] = [
    ['src/app/tasks/my/page.tsx', '<PhoneSearchFilter'],
    ['src/app/tasks/my/page.tsx', '<PhoneChips'],
    ['src/app/tasks/assigned-by-me/page.tsx', '<PhoneSearchFilter'],
    ['src/app/tasks/my/completed/page.tsx', '<PhoneSearchFilter'],
    ['src/app/tasks/assigned-by-me/completed/page.tsx', '<PhoneSearchFilter'],
    ['src/app/tasks/cancelled/page.tsx', 'phone={{'],
    ['src/app/tasks/assigned-by-me/cancelled/page.tsx', 'phone={{'],
    ['src/app/meetings/MeetingsListScreen.tsx', '<PhoneSearchFilter'],
    ['src/app/meetings/follow-ups/FollowUpsScreen.tsx', '<PhoneSearchFilter'],
    ['src/app/meetings/[id]/MeetingWorkScreen.tsx', '<PhoneHeaderMenu'],
    ['src/components/controlCenter/MembersWorkspace.tsx', '<PhoneSearchFilter'],
    ['src/app/performance/team/page.tsx', '<PhoneTableCards'],
    ['src/app/assets-access/page.tsx', '<PhoneSearchFilter'],
    ['src/app/admin/control-center/action-queue/page.tsx', '<PhoneTableCards'],
    ['src/app/my-issues/page.tsx', '<PhoneTableCards'],
    ['src/app/my-credits/page.tsx', '<PhoneHeaderMenu'],
    ['src/app/manager/page.tsx', 'boe-p3-manager'],
  ]
  for (const [file, needle] of uses) {
    test(`${file} → ${needle}`, () => assert.ok(read(file).includes(needle)))
  }

  test('My Tasks phone icon buttons are 44px', () => {
    const page = read('src/app/tasks/my/page.tsx')
    assert.equal(page.includes("width: '36px', height: '36px'"), false)
    assert.ok(page.includes("width: '44px', height: '44px'"))
  })

  test('every Meeting action stays reachable from the phone menu', () => {
    const screen = read('src/app/meetings/[id]/MeetingWorkScreen.tsx')
    for (const kind of ["'complete'", "'reopen'", "'add-order'", "'carry-forward'", "'import'", "'delete-meeting'"]) {
      assert.ok((screen.match(new RegExp(`kind: ${kind}`, 'g')) ?? []).length >= 2, kind)
    }
  })

  test('Super Admin has no task-create buttons', () => {
    assert.equal(isTaskCreateActionsHiddenRoute('/super-admin'), true)
    assert.equal(isTaskCreateActionsHiddenRoute('/super-admin/view-user/x'), true)
    assert.equal(isTaskCreateActionsHiddenRoute('/tasks/my'), false)
  })
})

describe('phone rules stay on phones', () => {
  test('the phase 3 globals block hides the phone tools above 767px and scopes its rules', () => {
    const css = read('src/app/globals.css')
    const start = css.indexOf('/* PHONE PHASE 3 — TASKS, MEETINGS, ADMIN')
    assert.ok(start > 0)
    const block = css.slice(start)
    assert.ok(block.includes('.boe-p3-chips, .boe-p3-tools { display: none; }'))
    // Outside a media query, the block only hides phone-only pieces.
    const outside = block.replace(/@media \(max-width: 767px\) \{[\s\S]*?\n\}/g, '')
    for (const rule of outside.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
      assert.match(rule, /display: (none|contents)/, rule.trim())
    }
  })
  test('module CSS phone blocks are inside a phone media query', () => {
    for (const file of [
      'src/components/controlCenter/controlCenter.module.css',
      'src/app/admin/control-center/permissions/permissions.module.css',
      'src/app/tasks/assigned-by-me/assignedByMe.module.css',
    ]) {
      const css = read(file)
      const tail = css.slice(css.lastIndexOf('phone phase 3') )
      assert.ok(tail.includes('@media (max-width: 767px)'), file)
    }
  })
})
