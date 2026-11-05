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

// Phone phase 4 (owner, 2026-11-05): the remaining Tasks, core and admin pages
// under 8.5/10 on a 390px phone. Presentation only: each page names a phase 4
// class and every phase 4 rule sits inside a phone media query.
describe('phone phase 4', () => {
  const css = read('src/app/globals.css')
  // This module's block runs to the next Phase 4 block (every module appends one).
  const p4 = css.indexOf('/* PHONE PHASE 4 — TASKS, CORE, ADMIN')
  const p4next = css.indexOf('PHONE PHASE 4 —', p4 + 20)
  const block = css.slice(p4, p4next < 0 ? undefined : css.lastIndexOf('/*', p4next))

  test('the phase 4 globals block exists and has no rule outside a phone query', () => {
    assert.ok(block.length > 100)
    const outside = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media \(max-width: (767|639)px\) \{[\s\S]*?\n\}/g, '').trim()
    assert.equal(outside, '')
  })

  test('the 44px targets and 16px fields are pinned', () => {
    for (const rule of [
      '.boe-p4-qsg-back { width: 44px; height: 44px;',
      '.boe-p4-nrow-trash { width: 44px !important; height: 44px !important; }',
      '.boe-p4-nrow-check { width: 44px !important; }',
      '.boe-p4-nrow-right { width: auto !important;',
      '.boe-p4-load-older { min-height: 44px;',
      '.boe-p4-stack2 { grid-template-columns: minmax(0, 1fr) !important; }',
      '.boe-p4-prio { min-height: 44px; }',
      '.boe-p4-formcard { padding: 14px !important; }',
      '.boe-p4-acct-pw { font-size: 16px !important; min-height: 44px;',
      '.boe-p4-cc-select { width: 100%; min-width: 0 !important; min-height: 44px; font-size: 16px !important; }',
      '.boe-announce-btn { min-height: 44px; }',
      '.boe-announce-tabs button { min-height: 40px;',
      '.boe-p4-authlink { display: flex !important; align-items: center; justify-content: center; min-height: 44px;',
      '.boe-p4-eye { width: 44px !important; }',
      '.boe-p4-mg-jumps .meeting-guide-jump { flex: none; min-height: 40px;',
    ]) assert.ok(block.includes(rule), rule)
  })

  test('the pages carry the phase 4 classes', () => {
    const has = (file: string, ...names: string[]) => {
      const src = read(file)
      for (const n of names) assert.ok(src.includes(n), `${file}: ${n}`)
    }
    has('src/app/quick-start-guide/page.tsx', 'boe-p4-qsg-bar', 'boe-p4-qsg-badge', 'boe-p4-qsg-back', 'boe-p4-qsg-card', 'boe-p4-qsg-h1')
    has('src/components/notifications/NotificationRow.tsx', 'boe-p4-nrow-check', 'boe-p4-nrow-right', 'boe-p4-nrow-open', 'boe-p4-nrow-trash')
    has('src/components/notifications/NotificationsView.tsx', 'boe-p4-load-older')
    for (const f of ['src/app/tasks/create/page.tsx', 'src/app/tasks/create-self/page.tsx', 'src/app/tasks/quotation-requests/new/page.tsx']) {
      has(f, 'boe-p4-formcard', 'boe-p4-stack2', 'boe-p4-prio', 'boe-p4-addfiles', 'boe-p4-submit', 'aria-label="Remove file"', 'aria-label="Dismiss"')
    }
    has('src/app/tasks/quotation-requests/new/page.tsx', 'type="tel"', 'inputMode="tel"', 'boe-p4-hint')
    has('src/app/tasks/quotation-requests/page.tsx', '<PhoneSearchFilter', 'boe-qtn-toolbar-controls boe-p3-desk', 'boe-p4-qtn-tab')
    has('src/app/account/page.tsx', 'boe-p4-acct-card', 'boe-p4-acct-pw', 'boe-p4-acct-eye', 'boe-p4-acct-submit')
    has('src/app/meetings/guide/page.tsx', 'boe-btn boe-btn-ghost boe-desktop-only')
    has('src/app/meetings/guide/MeetingGuide.tsx', 'boe-p4-mg-jumps', 'boe-p4-mg-aside')
    has('src/components/controlCenter/ForYouSettings.tsx', 'What the three settings mean', 'styles.phoneLegend')
    has('src/app/admin/control-center/data-management/page.tsx', 'cc.bulletsPhone', 'cc.bulletsDesk')
    has('src/app/admin/control-center/test-data-cleanup/page.tsx', 'className={cc.radio}')
    has('src/app/admin/control-center/page.tsx', 'boe-p4-cc-select')
    has('src/app/coming-soon/page.tsx', 'boe-p4-soon-card', 'boe-p4-soon-btn')
    has('src/app/settings/roles/page.tsx', 'boe-p3-settings', 'href="/admin/control-center/people"', 'href="/admin/control-center/permissions"')
    has('src/app/my-credits/how-it-works/page.tsx', 'boe-p4-flow-arrow', 'boe-p4-cr-stats')
    has('src/app/tasks/all/page.tsx', 'boe-p3-pager-btn', 'boe-p4-clearlink')
    has('src/app/login/page.tsx', 'autoComplete="username"', 'autoComplete="current-password"', 'boe-p4-authlink')
    has('src/components/auth/AuthShell.tsx', 'boe-p4-authfoot')
    has('src/app/reset-password/page.tsx', 'boe-p4-eye')
    has('src/components/customerReviews/ReviewLeaderboardScreen.tsx', 'boe-p4-16')
  })

  test('the module CSS phase 4 rules are phone-only', () => {
    for (const file of ['src/components/controlCenter/controlCenter.module.css', 'src/components/controlCenter/forYouSettings.module.css']) {
      const tail = read(file).slice(read(file).lastIndexOf('phone phase 4'))
      assert.ok(tail.includes('@media (max-width: 767px)'), file)
    }
    const cc = read('src/components/controlCenter/controlCenter.module.css')
    assert.ok(cc.includes('.rowActions { gap: 8px; flex-wrap: wrap; }'))
    assert.ok(cc.includes('.listRow { flex-wrap: wrap; row-gap: 8px; }'))
  })
})
