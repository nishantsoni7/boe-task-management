/**
 * THE CARD HEADER, RENDERED.
 *
 *   test task  [person] Nishant  > 3 updates
 *
 * Source text cannot tell "the header exists" from "the header reaches the
 * DOM", so this renders the real component with react-dom/server — already a
 * dependency, no test framework added — and reads the markup.
 *
 * Run:
 *   npx tsx --test src/components/notifications/NotificationHeaderLayout.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Notification } from '@/lib/types'
import { NotificationTaskGroup } from './NotificationTaskGroup'
import { groupNotificationsByTask, type NotificationTaskGroup as TaskGroup } from '@/lib/notifications/grouping'
import { ASSIGNEE_UNAVAILABLE, type TaskHeaderInfo, type ActivityDetailMap } from '@/lib/notifications/pageEnrichment'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const TASK = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

let seq = 0
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `n${seq}`, user_id: 'me', task_id: TASK, entity_id: null,
    type: 'task_acknowledged', title: 'Dhruv added a comment',
    body: 'body-derived title', is_read: false, is_push_sent: false, is_digest: false,
    created_at: '2026-08-26T10:00:00.000Z', read_at: null, ...over,
  } as Notification
}

function groupOf(rows: Notification[]): TaskGroup {
  const g = groupNotificationsByTask(rows).find(i => i.kind === 'task')
  assert.ok(g && g.kind === 'task')
  return g
}

const noop = () => {}
const HEADER: TaskHeaderInfo = { title: 'test task', assigneeName: 'Nishant' }

const render = (group: TaskGroup, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <NotificationTaskGroup
      group={group}
      headerInfo={HEADER}
      filter="all"
      selected={new Set()}
      pendingDeletes={new Set()}
      onToggleSelect={noop} onMarkGroupRead={noop}
      onDeleteGroup={noop} onDeleteOne={noop} onRowClick={noop}
      {...over}
    />,
  )

const ONE = () => groupOf([n({ id: 'e1', title: 'Dhruv added a comment' })])
const THREE = () => groupOf([
  n({ id: 'e1', title: 'Dhruv added a comment',      created_at: '2026-08-26T12:00:00.000Z' }),
  n({ id: 'e2', title: 'Nishant moved task to Waiting', created_at: '2026-08-26T11:00:00.000Z' }),
  n({ id: 'e3', title: 'Nishant submitted task for approval', created_at: '2026-08-26T10:00:00.000Z' }),
])

// ── 1–2. The header ──────────────────────────────────────────────────────────

describe('1-2. the header names the task and its owner', () => {
  test('1. the task title comes from the TASK, not from the notification body', () => {
    const html = render(THREE())
    assert.ok(html.includes('test task'), 'the authoritative title')
    assert.equal(html.includes('body-derived title'), false,
      'the notification body must not be the header')
  })

  test('1b. with no lookup result it falls back rather than rendering empty', () => {
    const html = render(THREE(), { headerInfo: undefined })
    assert.ok(html.includes('body-derived title'))
    // The assignee has no fallback to derive, so it says so — and draws no
    // person chip, which would read as a name that failed to load.
    assert.ok(html.includes(ASSIGNEE_UNAVAILABLE))
    assert.equal(html.includes('title="Assigned to '), false)
    assert.equal(html.includes('lucide-user'), false)
  })

  test('2. the assignee is the TASK OWNER, not the latest actor', () => {
    // The visible words "Assigned to:" are gone — the person icon carries them
    // on screen and the tooltip / screen-reader text carry them everywhere
    // else. What this test is for is unchanged: the name shown is the task's
    // owner, never the person who happened to act most recently.
    const html = render(THREE())
    assert.ok(html.includes('Nishant'), 'the task owner')
    assert.equal(html.includes('Assigned to: Nishant'), false, 'the label text is gone')
    assert.ok(html.includes('title="Assigned to Nishant"'), 'but the meaning is not')
    // Dhruv is the newest event's ACTOR. He must never be named as the owner.
    assert.equal(html.includes('Assigned to Dhruv'), false)
  })

  test('3. ONE event → no "1 update" anywhere', () => {
    const html = render(ONE())
    assert.equal(html.includes('1 update'), false)
    // Strip accessible names and tooltips: "Mark all updates for this task as
    // read" is a control's label, not a count the reader is shown.
    const visible = html.replace(/aria-label="[^"]*"|title="[^"]*"/g, '')
    assert.equal(/\bupdates?\b/.test(visible), false,
      'no count label at all on a single-event card')
  })

  test('3b. and ONE event renders no accordion control', () => {
    const html = render(ONE())
    assert.equal(html.includes('aria-expanded'), false, 'no disclosure button')
    assert.equal(html.includes('aria-controls'), false)
    assert.equal(/Expand|Collapse/.test(html), false)
  })

  test('3c. the single event is visible without a click', () => {
    const html = render(ONE())
    assert.ok(html.includes('Comment added'), 'the event itself is on screen')
    assert.equal(html.includes('hidden=""'), false, 'nothing is hidden behind a panel')
  })

  test('4b. a group DOES render the accordion, collapsed', () => {
    const html = render(THREE())
    assert.ok(html.includes('aria-expanded="false"'))
    assert.ok(html.includes('hidden=""'), 'events start collapsed')
  })

  test('the count is never called subtasks, items or events', () => {
    const html = render(THREE())
    assert.equal(/\d+ (subtask|item|event)/i.test(html), false)
  })
})

// ── The event body ───────────────────────────────────────────────────────────

describe('events do not repeat the header', () => {
  const html = render(THREE(), { filter: 'all' })
  const expanded = renderToStaticMarkup(
    <NotificationTaskGroup
      group={THREE()} headerInfo={HEADER} filter="all"
      selected={new Set()} pendingDeletes={new Set()}
      onToggleSelect={noop} onMarkGroupRead={noop}
      onDeleteGroup={noop} onDeleteOne={noop} onRowClick={noop}
    />,
  )

  test('the task title appears once — in the header', () => {
    // Collapsed, so only the header is rendered; the aria-label mentions it too,
    // which is what a screen reader needs on the disclosure control.
    const visible = expanded.replace(/aria-label="[^"]*"|title="[^"]*"/g, '')
    assert.equal((visible.match(/test task/g) ?? []).length, 1)
  })

  test('the assignee is named once, in the header', () => {
    // Once as a tooltip and once as visible text, on ONE element — never
    // repeated per event.
    assert.equal((expanded.match(/title="Assigned to Nishant"/g) ?? []).length, 1)
  })

  test('no View Task button — the title is the link', () => {
    assert.equal(html.includes('View Task'), false)
    assert.equal((html.match(/href="\/tasks\//g) ?? []).length, 1,
      'exactly one link to the task, and it is the title')
  })

  test('9. an actor who is the assignee is not repeated on their own events', () => {
    // The single-event card renders its event, so this is observable directly.
    const own = render(groupOf([n({ id: 'x1', title: 'Nishant moved task to Waiting' })]))
    assert.ok(own.includes('Status changed to Waiting'))
    assert.equal(own.includes('By Nishant'), false, 'the owner is not re-announced')
  })

  test('10. a different actor appears once, as muted metadata', () => {
    const other = render(groupOf([n({ id: 'x2', title: 'Dhruv added a comment' })]))
    assert.ok(other.includes('By Dhruv'), 'shown once, in the metadata line')
    assert.equal((other.match(/Dhruv/g) ?? []).length, 1, 'and only once')
  })

  test('6. a comment with no stored preview shows the honest fallback', () => {
    const html2 = render(groupOf([n({ id: 'x3', title: 'Dhruv added a comment' })]))
    assert.ok(html2.includes('Comment added'))
    // The task title must never stand in for the comment text.
    assert.equal(html2.includes('“test task”'), false)
    assert.equal(html2.includes('“body-derived title”'), false)
  })

  test('8. a status event with only the new value never invents the previous one', () => {
    const html2 = render(groupOf([n({ id: 'x4', title: 'Dhruv moved task to Waiting' })]))
    assert.ok(html2.includes('Status changed to Waiting'))
    assert.equal(html2.includes('→'), false, 'no arrow without both halves')
  })

  test('no event carries a large actor badge', () => {
    const src = read('src/components/notifications/NotificationTaskGroup.tsx')
    const eventRow = src.slice(src.indexOf('function EventRow'))
    assert.equal(/badge/i.test(eventRow), false, 'the badge pill is gone from events')
    assert.equal(/getNotificationMeta/.test(eventRow), false, 'events use the event line, not the meta badge')
  })
})

// ── 13. Responsive ───────────────────────────────────────────────────────────

describe('13. the header wraps on mobile instead of cramming one row', () => {
  test('desktop puts title and meta on one row', () => {
    const html = render(THREE(), { isMobile: false })
    assert.ok(html.includes('flex-direction:row'))
    // NOT space-between any more: that pushed the assignee to the far right of
    // a 900px card and left a wide empty band down the middle of every row.
    // Title and assignee are one left-side block now; the gap sits after them.
    assert.equal(html.includes('justify-content:space-between'), false)
  })

  test('mobile stacks them', () => {
    const html = render(THREE(), { isMobile: true })
    assert.ok(html.includes('flex-direction:column'))
  })

  test('mobile keeps the 44px touch floor on the actions', () => {
    const html = render(THREE(), { isMobile: true })
    assert.ok(html.includes('min-height:44px'))
  })

  test('the title truncates on desktop and wraps on mobile', () => {
    assert.ok(render(THREE(), { isMobile: false }).includes('text-overflow:ellipsis'))
    assert.ok(render(THREE(), { isMobile: true }).includes('overflow-wrap:anywhere'))
  })
})

// ── Visual treatment ─────────────────────────────────────────────────────────

describe('the card is white with a light border, not a blue block', () => {
  test('no full blue background, read or unread', () => {
    const unread = render(THREE())
    assert.ok(unread.includes('background:#ffffff'))
    // The old treatment washed the whole card in blueTint.
    assert.equal(/background:rgba\(85,133,232/.test(unread), false)
  })

  test('unread is one small dot plus a subtle left accent', () => {
    const unread = render(ONE())
    assert.ok(unread.includes('border-radius:50%'), 'the dot')
    assert.ok(unread.includes('aria-label="Unread"'))
    const src = read('src/components/notifications/NotificationTaskGroup.tsx')
    assert.ok(src.includes('borderLeft: hasUnread'), 'the accent')
  })

  test('a read card shows neither', () => {
    const readCard = render(groupOf([n({ id: 'r1', is_read: true })]))
    assert.equal(readCard.includes('aria-label="Unread"'), false)
  })

  test('actions are secondary — outlined, never a filled primary block', () => {
    const html = render(THREE())
    assert.ok(html.includes('Mark all read'))
    // The old View Task was a filled blue button.
    assert.equal(/background:#5585E8|background:rgb\(85,133,232\)/.test(html), false)
  })
})

// ── 19-25. The linked detail, rendered ───────────────────────────────────────

const ACT = 'dddddddd-4444-4444-8444-dddddddddddd'
const linked = (over: Partial<Notification>, details: ActivityDetailMap) =>
  renderToStaticMarkup(
    <NotificationTaskGroup
      group={groupOf([n({ id: 'L1', activity_log_id: ACT, ...over } as Partial<Notification>)])}
      headerInfo={HEADER}
      activityDetails={details}
      filter="all"
      selected={new Set()} pendingDeletes={new Set()}
      onToggleSelect={noop} onMarkGroupRead={noop}
      onDeleteGroup={noop} onDeleteOne={noop} onRowClick={noop}
    />,
  )

describe('19-25. a linked notification shows the real detail', () => {
  test('19. a linked comment renders one quoted line', () => {
    const html = linked({ title: 'Dhruv added a comment' }, {
      [ACT]: { action: 'note_added', note: 'Please confirm the final dimensions before proceeding.', fromStatus: null, toStatus: null, actorName: 'Dhruv' },
    })
    assert.ok(html.includes('Added a comment'))
    assert.ok(html.includes('Please confirm the final dimensions before proceeding.'))
    assert.equal(html.includes('Comment added'), false, 'the fallback is not used when text exists')
  })

  test('19b. a long comment is truncated with an ellipsis, on one line', () => {
    const html = linked({ title: 'Dhruv added a comment' }, {
      [ACT]: { action: 'note_added', note: 'word '.repeat(80), fromStatus: null, toStatus: null, actorName: 'Dhruv' },
    })
    assert.ok(html.includes('…'))
    assert.ok(html.includes('white-space:nowrap'), 'the preview line does not wrap')
  })

  test('20. markup, JSON and URLs from a comment are never displayed', () => {
    const html = linked({ title: 'Dhruv added a comment' }, {
      [ACT]: { action: 'note_added', note: 'See <b>this</b> at https://xyz.supabase.co/storage/v1/object/sign/a.pdf', fromStatus: null, toStatus: null, actorName: 'Dhruv' },
    })
    assert.equal(html.includes('supabase.co'), false, 'no attachment URL')
    assert.equal(html.includes('&lt;b&gt;'), false, 'no markup')
    assert.ok(html.includes('See this at'))

    const jsonHtml = linked({ title: 'Dhruv added a comment' }, {
      [ACT]: { action: 'note_added', note: '{"note":"secret"}', fromStatus: null, toStatus: null, actorName: 'Dhruv' },
    })
    assert.equal(jsonHtml.includes('secret'), false, 'raw JSON is not a comment')
    assert.ok(jsonHtml.includes('Comment added'), 'and falls back honestly')
  })

  test('21. a linked status change renders previous → new', () => {
    const html = linked({ title: 'Dhruv moved task to Waiting' }, {
      [ACT]: { action: 'status_changed', note: null, fromStatus: 'working', toStatus: 'waiting', actorName: 'Dhruv' },
    })
    assert.ok(html.includes('Status changed'))
    assert.ok(html.includes('Working'))
    assert.ok(html.includes('Waiting'))
    assert.ok(html.includes('→'))
  })

  test('22. a linked row with only a to_status still invents no previous value', () => {
    const html = linked({ title: 'Dhruv moved task to Waiting' }, {
      [ACT]: { action: 'status_changed', note: null, fromStatus: null, toStatus: 'waiting', actorName: 'Dhruv' },
    })
    assert.ok(html.includes('Status changed to Waiting'))
    assert.equal(html.includes('→'), false)
  })

  test('23. a HISTORICAL row with no link uses the fallbacks', () => {
    const html = renderToStaticMarkup(
      <NotificationTaskGroup
        group={groupOf([n({ id: 'H1', title: 'Dhruv added a comment', activity_log_id: null } as Partial<Notification>)])}
        headerInfo={HEADER} activityDetails={{}} filter="all"
        selected={new Set()} pendingDeletes={new Set()}
        onToggleSelect={noop} onMarkGroupRead={noop}
        onDeleteGroup={noop} onDeleteOne={noop} onRowClick={noop}
      />,
    )
    assert.ok(html.includes('Comment added'))
    assert.ok(html.includes('test task'), 'title and assignee still come from the task lookup')
    assert.ok(html.includes('title="Assigned to Nishant"'))
  })

  test('23b. a link whose detail did not resolve also falls back', () => {
    // The enrichment failed, or the activity row was deleted (SET NULL races).
    const html = linked({ title: 'Dhruv moved task to Waiting' }, {})
    assert.ok(html.includes('Status changed to Waiting'), 'parsed from the title, as before')
    assert.equal(html.includes('→'), false)
  })

  test('24. the linked actor appears once, as muted metadata', () => {
    const html = linked({ title: 'Dhruv added a comment' }, {
      [ACT]: { action: 'note_added', note: 'ok', fromStatus: null, toStatus: null, actorName: 'Dhruv' },
    })
    assert.ok(html.includes('By Dhruv'))
    assert.equal((html.match(/Dhruv/g) ?? []).length, 1)
  })

  test('25. an actor who IS the assignee is not repeated', () => {
    const html = linked({ title: 'Nishant moved task to Waiting' }, {
      [ACT]: { action: 'status_changed', note: null, fromStatus: 'working', toStatus: 'waiting', actorName: 'Nishant' },
    })
    assert.equal(html.includes('By Nishant'), false)
    // The header still names them once — as one element carrying both the
    // tooltip and the visible name, which is two textual occurrences of the
    // same single mention.
    assert.equal((html.match(/title="Assigned to Nishant"/g) ?? []).length, 1)
    assert.equal((html.match(/>Nishant</g) ?? []).length, 1, 'visible exactly once')
  })

  test('a linked row never labels a human action "System"', () => {
    const html = linked({ title: 'Dhruv returned task to Working' }, {
      [ACT]: { action: 'status_changed', note: null, fromStatus: 'pending_approval', toStatus: 'working', actorName: null },
    })
    assert.equal(/System/i.test(html), false)
    assert.ok(html.includes('Returned for changes'))
  })
})
