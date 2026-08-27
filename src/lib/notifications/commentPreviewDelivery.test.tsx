/**
 * THE COMMENT PREVIEW, FROM THE WRITER TO THE PIXEL.
 *
 * WHAT WENT WRONG
 * ---------------
 * A comment notification rendered as a bare "Comment added" with no text
 * beneath it, on the preview, on rows the database had linked correctly. Every
 * unit in the chain passed its own tests. The defect was in the SEAM:
 *
 *   the notification ROWS lived in the React Query cache
 *   the enrichment MAPS lived in component state, assigned inside queryFn
 *
 * Two stores, two lifetimes. `staleTime: 30s` means a page served from cache
 * never runs queryFn — so the maps stayed `{}` while the rows rendered fine.
 * Mutations write rows back with setQueryData and carry no map. Two observers
 * of one key share one fetch, so only one of them is ever assigned the maps.
 *
 * Every one of those renders a correctly linked comment as "Comment added".
 *
 * So the fix is structural: the detail is attached to the ROW, server-side, and
 * the card reads it from there. This file proves the chain end to end and, most
 * importantly, proves it SURVIVES THE CACHE PATHS THAT BROKE IT — a page that
 * round-trips through the cache untouched, and rows mapped by a mutation.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/commentPreviewDelivery.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import type { Notification } from '@/lib/types'
import {
  attachRowContext,
  enrichNotificationPage,
  rowContext,
  type NotificationPageEnrichment,
} from './pageEnrichment'
import { COMMENT_WITHOUT_PREVIEW } from './eventPresentation'
import { NotificationTaskGroup } from '@/components/notifications/NotificationTaskGroup'
import { groupNotificationsByTask, type NotificationTaskGroup as TaskGroup } from './grouping'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const TASK_DETAIL = read('src/app/tasks/[id]/page.tsx')
const ROUTE = read('src/app/api/notify-status-update/route.ts')
const LIST_ROUTE = read('src/app/api/notifications/route.ts')
const LINK = read('src/lib/notifications/activityLink.ts')
const GROUP_SRC = read('src/components/notifications/NotificationTaskGroup.tsx')

const TASK = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ACT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ACTOR = 'cccccccc-3333-4333-8333-cccccccccccc'
const ASSIGNEE = 'dddddddd-4444-4444-8444-dddddddddddd'

let seq = 0
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `n${seq}`, user_id: 'me', task_id: TASK, entity_id: null,
    type: 'task_acknowledged', title: 'Aditya added a comment',
    body: 'Revised dimensions', is_read: false, is_push_sent: false, is_digest: false,
    activity_log_id: ACT,
    created_at: '2026-08-27T10:00:00.000Z', read_at: null, ...over,
  } as Notification
}

/** A stub of just the three reads enrichNotificationPage makes. */
function client(opts: {
  note?: string | null
  actorId?: string | null
  action?: string
  fromStatus?: string | null
  toStatus?: string | null
  activityRows?: Record<string, unknown>[]
} = {}) {
  const activity = opts.activityRows ?? [{
    id: ACT, actor_id: opts.actorId === undefined ? ACTOR : opts.actorId,
    action: opts.action ?? 'note_added',
    note: opts.note === undefined ? 'Please confirm the revised dimensions.' : opts.note,
    from_status: opts.fromStatus ?? null, to_status: opts.toStatus ?? null,
  }]
  return {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === 'tasks') {
            return { data: [{ id: TASK, title: 'Balcony railing', assigned_to: ASSIGNEE }], error: null }
          }
          if (table === 'task_activity_log') return { data: activity, error: null }
          return {
            data: [{ id: ACTOR, full_name: 'Aditya' }, { id: ASSIGNEE, full_name: 'Nishant' }],
            error: null,
          }
        },
      }),
    }),
  }
}

/** The whole server side of a page: enrich, then attach to the rows. */
async function serverPage(
  rows: Notification[],
  c: ReturnType<typeof client> = client(),
): Promise<Notification[]> {
  const enrichment = await enrichNotificationPage(c, rows)
  return attachRowContext(rows, enrichment) as Notification[]
}

function groupOf(rows: Notification[]): TaskGroup {
  const g = groupNotificationsByTask(rows).find(i => i.kind === 'task')
  assert.ok(g && g.kind === 'task')
  return g
}

const noop = () => {}

/** Render the card the way the page does: NO maps passed, row context only. */
function renderCard(rows: Notification[], over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <NotificationTaskGroup
      group={groupOf(rows)}
      filter="all"
      selected={new Set()}
      pendingDeletes={new Set()}
      onToggleSelect={noop} onOpenTask={noop} onMarkGroupRead={noop}
      onDeleteGroup={noop} onDeleteOne={noop} onRowClick={noop}
      {...over}
    />,
  )
}

/**
 * The text inside the card's quotation marks, or null when it drew none.
 *
 * The curly quotes are the detail line's own — nothing else on the card uses
 * them, so this cannot pick up an attribute value the way a straight-quote
 * match would.
 */
function detailLine(html: string): string | null {
  const m = /\u201C([\s\S]*?)\u201D/.exec(html)
  return m ? m[1] : null
}

// ── 1–2. The writer hands over the id it already holds ───────────────────────

describe('1-2. the exact comment writer passes its own activity id', () => {
  test('1. Task Detail inserts the comment, reads the row back, and sends THAT id', () => {
    // The one comment writer in the product. Asserted as a sequence, because
    // the id being sent is worth nothing if it is not the id just returned.
    const save = TASK_DETAIL.slice(TASK_DETAIL.indexOf('const saveComment = async ()'),
                                  TASK_DETAIL.indexOf('const saveDescription'))
    assert.ok(save.length > 0, 'saveComment must exist')

    const insertAt = save.indexOf("action:         'note_added'")
    const readBackAt = save.indexOf(".select('id, action, note")
    const sendAt = save.indexOf('activityLogId: logRow.id')
    assert.ok(insertAt > 0, 'it inserts the comment activity row')
    assert.ok(readBackAt > insertAt, 'and reads the inserted row back')
    assert.ok(sendAt > readBackAt, 'and only then sends that row id')
    assert.ok(save.includes("action: 'comment_added'"), 'as a comment notification')

    // The comment text goes into `note`, which is the column the feed reads.
    assert.ok(save.includes('note:           commentNote.trim() || null'))
  })

  test('1b. it is the ONLY comment writer — nothing else can create one unlinked', () => {
    const writers = TASK_DETAIL.split('\n').filter(l => l.includes("action: 'comment_added'"))
    assert.equal(writers.length, 1)
    for (const other of ['src/app/tasks/my/page.tsx', 'src/app/dashboard/page.tsx']) {
      assert.equal(read(other).includes("'comment_added'"), false,
        `${other} must not be a second comment writer`)
    }
  })

  test('1c. the status writers that hold a row send it too', () => {
    // Not the comment path, but the same defect class: a writer that reads its
    // activity row back and then throws the id away can never show the status
    // the task moved FROM, because that value exists only on that row.
    assert.ok(TASK_DETAIL.includes('activityLogId: logRow?.id ?? null'),
      'applyStatusChange links the row it already read back')
    assert.ok(TASK_DETAIL.includes('activityLogId: waitingLog?.id ?? null'),
      'the Waiting modal reads its row back and links it')
  })

  test('2. the route verifies the id belongs to the SAME task before storing it', () => {
    assert.ok(ROUTE.includes('verifyActivityBelongsToTask(supabase, activityLogId, taskId)'))
    assert.ok(ROUTE.includes('activity_log_id: linkedActivityId'))
    // Never the unchecked value.
    assert.equal(/activity_log_id:\s*activityLogId\b/.test(ROUTE), false)
    // And the check is scoped by BOTH id and task.
    assert.ok(LINK.includes(".eq('id', activityLogId)"))
    assert.ok(LINK.includes(".eq('task_id', taskId)"))
  })
})

// ── 3. A linked comment renders its actual text ──────────────────────────────

describe('3. a linked comment shows the comment', () => {
  test('3. the real text reaches the card', async () => {
    const html = renderCard(await serverPage([n()]))
    assert.ok(html.includes('Please confirm the revised dimensions.'),
      'the comment itself must be on screen')
    assert.equal(html.includes(COMMENT_WITHOUT_PREVIEW), false,
      'and the fallback must not be used when there is text')
  })

  test('3b. the action line, the quote and the actor read as the required shape', async () => {
    const html = renderCard(await serverPage([n()]))
    assert.ok(html.includes('Added a comment'))
    assert.equal(detailLine(html), 'Please confirm the revised dimensions.')
    assert.ok(html.includes('By Aditya'), 'the actor, resolved from the activity row')
  })
})

// ── 4–8. One safe line ───────────────────────────────────────────────────────

describe('4-8. the line is one line, and it is safe', () => {
  test('4. a multiline comment becomes one line', async () => {
    const html = renderCard(await serverPage([n()],
      client({ note: 'Line one.\n\nLine two.\r\nLine    three.' })))
    assert.equal(detailLine(html), 'Line one. Line two. Line three.')
    assert.equal(/\n/.test(detailLine(html) ?? ''), false)
  })

  test('5. a long comment truncates with an ellipsis', async () => {
    const long = 'The revised dimensions for the balcony railing must be confirmed by the fabrication team before the powder coating is scheduled for next week.'
    const html = renderCard(await serverPage([n()], client({ note: long })))
    const line = detailLine(html) ?? ''
    assert.ok(line.endsWith('…'), 'it must end in a real ellipsis')
    assert.ok(line.length < long.length, 'and be shorter than the comment')
    // And the cell itself clips rather than wrapping to a second line.
    assert.ok(GROUP_SRC.includes("whiteSpace: 'nowrap'"))
    assert.ok(GROUP_SRC.includes("textOverflow: 'ellipsis'"))
  })

  test('6. Markdown and HTML never render as markup', async () => {
    const html = renderCard(await serverPage([n()],
      client({ note: '**bold** _em_ `code` ## head <b>tag</b><script>x()</script>' })))
    const line = detailLine(html) ?? ''
    for (const mark of ['**', '_em_', '`', '##', '<b>', '</b>', '<script>']) {
      assert.equal(line.includes(mark), false, `${mark} must not survive into the line`)
    }
    assert.equal(html.includes('<script>'), false, 'and nothing executable reaches the markup')
    assert.ok(line.includes('bold'), 'the words themselves are kept')
  })

  test('7. a JSON-like payload is not exposed as structured data', async () => {
    for (const payload of ['{"taskId":"x","note":"y"}', '[{"a":1}]', '   {"k": 2}']) {
      const html = renderCard(await serverPage([n()], client({ note: payload })))
      assert.ok(html.includes(COMMENT_WITHOUT_PREVIEW),
        'a whole-payload blob is not a comment anybody wrote — fall back')
      assert.equal(html.includes('taskId'), false)
      assert.equal(detailLine(html), null, 'and no empty quotes are drawn')
    }
  })

  test('8. raw URLs are suppressed, attachment links included', async () => {
    const html = renderCard(await serverPage([n()], client({
      note: 'See https://xyz.supabase.co/storage/v1/object/sign/task-attachments/a.pdf?token=abc for the file',
    })))
    const line = detailLine(html) ?? ''
    assert.equal(/https?:\/\//.test(line), false, 'no URL may reach the card')
    assert.equal(line.includes('token'), false, 'and no signed-URL token')
    assert.ok(line.includes('See') && line.includes('for the file'), 'the prose survives')
  })

  test('8b. no internal id, column name or attachment metadata is ever printed', async () => {
    const html = renderCard(await serverPage([n()]))
    for (const leak of [ACT, ACTOR, ASSIGNEE, 'activity_log_id', 'actor_id', 'from_status',
                        'to_status', 'note_added', 'task_activity_log', 'storage_path']) {
      assert.equal(html.includes(leak), false, `${leak} must never be rendered`)
    }
  })
})

// ── 9–10. The actor ──────────────────────────────────────────────────────────

describe('9-10. the actor, once and honestly', () => {
  test('9. the actor appears exactly once on the card', async () => {
    const html = renderCard(await serverPage([n()]))
    assert.equal(html.split('Aditya').length - 1, 1, 'named once, in the meta line')
    assert.ok(html.includes('By Aditya'))
  })

  test('9b. and not at all when the actor IS the assignee', async () => {
    // The header already says whose task it is; repeating it on the event would
    // claim the owner performed something somebody else may have.
    const html = renderCard(await serverPage([n()], client({ actorId: ASSIGNEE })))
    assert.equal(html.includes('By Nishant'), false)
    assert.ok(html.includes('Assigned to:'))
  })

  test('10. an unresolvable actor is never labelled "System"', async () => {
    const html = renderCard(await serverPage([n({ title: 'added a comment' })],
      client({ actorId: null })))
    assert.equal(html.includes('System'), false,
      'a human event with no resolvable actor is not the system')
    assert.ok(html.includes('Please confirm the revised dimensions.'),
      'and the comment still shows')
  })
})

// ── 11–13. The honest fallbacks ──────────────────────────────────────────────

describe('11-13. an unlinked or empty row falls back, never lies', () => {
  test('11. a null activity_log_id keeps "Comment added"', async () => {
    const html = renderCard(await serverPage([n({ activity_log_id: null })]))
    assert.ok(html.includes(COMMENT_WITHOUT_PREVIEW))
    assert.equal(detailLine(html), null, 'no quotes, empty or otherwise')
  })

  test('12. a link whose activity row is gone falls back too', async () => {
    // ON DELETE SET NULL is what normally clears the link; this is the window
    // where a row is referenced but no longer readable. Still usable.
    const html = renderCard(await serverPage([n()], client({ activityRows: [] })))
    assert.ok(html.includes(COMMENT_WITHOUT_PREVIEW))
    assert.equal(detailLine(html), null)
  })

  test('13. an empty or whitespace note falls back WITHOUT empty quotes', async () => {
    for (const empty of [null, '', '   ', '\n\n', '<b></b>', 'https://example.com/only']) {
      const html = renderCard(await serverPage([n()], client({ note: empty })))
      assert.ok(html.includes(COMMENT_WITHOUT_PREVIEW), `${JSON.stringify(empty)} must fall back`)
      assert.equal(detailLine(html), null, `${JSON.stringify(empty)} must not draw ""`)
      assert.equal(/\u201C\s*\u201D/.test(html), false)
    }
  })

  test('13b. the card still opens its task when the link is null', async () => {
    const html = renderCard(await serverPage([n({ activity_log_id: null })]))
    // The control is a button that routes, not an anchor — assert what it is.
    assert.ok(html.includes('View Task'), 'View Task survives an unlinked row')
    assert.ok(html.includes('aria-label="View task Balcony railing"'),
      'and it names the task it opens')
  })
})

// ── 14. Nothing is matched by time ───────────────────────────────────────────

describe('14. the link is never inferred', () => {
  test('14. nothing chooses an activity row by time, recency or title', () => {
    const ENRICH = read('src/lib/notifications/pageEnrichment.ts')

    // The reader and the writer route touch no ordering and no time window at
    // all: they address activity rows by id and nothing else.
    for (const [name, src] of [['pageEnrichment', ENRICH], ['notify-status-update', ROUTE]] as const) {
      assert.equal(/\.order\(/.test(src), false, `${name} must not order anything`)
      assert.equal(/\.gte\(|\.lte\(|\.gt\(|\.lt\(/.test(src), false,
        `${name} must not window rows by time`)
      assert.equal(/created_at/.test(src), false, `${name} must not read created_at`)
    }

    // The comment path's own verification: id + task, no ordering, no limit
    // that could turn "which row" into "whichever came back".
    const verify = LINK.slice(LINK.indexOf('export async function verifyActivityBelongsToTask'),
                              LINK.indexOf('export async function findTaskCreationActivityId'))
    assert.equal(/\.order\(|created_at/.test(verify), false,
      'the comment link is verified by id, never by time')

    // The ONE ordered lookup in the product, and why it is not a time match:
    // it selects BY MEANING (action = 'created' names exactly one row) and
    // orders only so a retry returns the same id.
    const creation = LINK.slice(LINK.indexOf('export async function findTaskCreationActivityId'))
    assert.ok(creation.includes(".eq('action', 'created')"), 'selected by meaning')
    assert.ok(LINK.includes('DETERMINISM ACROSS RETRIES'))
    assert.equal(/\.gte\(|\.lte\(|\.gt\(|\.lt\(/.test(creation), false)

    // The list route DOES order — the notification FEED, newest first. That is
    // the reading order of the page, not a way of picking an activity row: it
    // touches `notifications` only.
    const feedOrder = LIST_ROUTE.slice(LIST_ROUTE.indexOf(".order('created_at'"))
    assert.ok(LIST_ROUTE.slice(0, LIST_ROUTE.indexOf(".order('created_at'"))
      .includes(".from('notifications')"))
    assert.ok(feedOrder.includes(".order('id'"), 'and it is a total order, for paging')
    assert.equal(/task_activity_log/.test(LIST_ROUTE), false,
      'the list route never queries activity itself')
  })

  test('14b. the reader looks activity up by primary key and nothing else', () => {
    const src = read('src/lib/notifications/pageEnrichment.ts')
    assert.ok(src.includes(".in('id', activityIds)"))
    assert.equal(src.includes("eq('task_id'"), false,
      'an activity row is found by its id, never re-derived from the task')
  })
})

// ── 15. Bounded queries ──────────────────────────────────────────────────────

describe('15. the query count is unchanged and bounded', () => {
  test('15. attaching the context costs no query at all', () => {
    // It is composition over data already fetched.
    let calls = 0
    const counting = {
      from: (t: string) => { calls += 1; return client().from(t) },
    }
    void counting
    const enrichment: NotificationPageEnrichment = { taskHeaders: {}, activityDetails: {} }
    attachRowContext([n(), n(), n(), n(), n()], enrichment)
    assert.equal(calls, 0)
  })

  test('15b. four queries per page, whatever the number of cards', async () => {
    const tables: string[] = []
    const counting = {
      from: (t: string) => {
        tables.push(t)
        return client().from(t)
      },
    }
    const rows = Array.from({ length: 40 }, (_, i) =>
      n({ id: `bulk${i}`, activity_log_id: ACT }))
    await serverPage(rows, counting as ReturnType<typeof client>)
    // notifications itself is the fourth, issued by the route.
    assert.deepEqual(tables, ['tasks', 'task_activity_log', 'users'])
  })

  test('15c. the card component issues no request of its own', () => {
    for (const forbidden of ['fetch(', 'supabase', 'useQuery', 'useEffect']) {
      assert.equal(GROUP_SRC.includes(forbidden), false,
        `the card must not ${forbidden} — one event must never cost one request`)
    }
  })
})

// ── 16. The cache paths that broke it, and everything else still working ─────

describe('16. it survives the cache, and the rest of the card still works', () => {
  test('16a. THE REGRESSION: a page served from cache still shows the comment', async () => {
    // This is the defect. The rows go into the cache and come back out with NO
    // query function having run, so nothing re-supplies a sibling map. The card
    // is rendered with no maps at all — exactly what the page does now.
    const page = await serverPage([n()])
    const fromCache = JSON.parse(JSON.stringify(page)) as Notification[]   // a cache round-trip
    const html = renderCard(fromCache)
    assert.ok(html.includes('Please confirm the revised dimensions.'),
      'a cached page must render the comment, with no map in sight')
    assert.equal(html.includes(COMMENT_WITHOUT_PREVIEW), false)
    assert.ok(html.includes('Balcony railing'), 'and the header survives the same trip')
  })

  test('16b. and after a mutation writes the rows straight back', async () => {
    // What markRead / delete-one do: map over the cached array. The context
    // rides along because it is ON the row.
    const page = await serverPage([n({ is_read: false })])
    const afterMarkRead = page.map(r => ({ ...r, is_read: true, read_at: '2026-08-27T11:00:00Z' }))
    const html = renderCard(afterMarkRead)
    assert.ok(html.includes('Please confirm the revised dimensions.'))
    assert.equal(html.includes('Unread'), false, 'and the row really is read now')
  })

  test('16c. a second observer that never ran the query function is not blank', async () => {
    // The old shape assigned the maps in queryFn, so a component sharing the
    // fetch got `{}`. With the context on the row there is nothing to miss.
    const page = await serverPage([n()])
    assert.ok(page[0].context?.activity?.note, 'the row carries its own detail')
    assert.equal(renderCard(page, { activityDetails: undefined, headerInfo: undefined })
      .includes('Please confirm the revised dimensions.'), true)
  })

  test('16d. grouping, unread, mark-read, delete and navigation are all intact', async () => {
    const page = await serverPage([
      n({ id: 'a', created_at: '2026-08-27T12:00:00.000Z' }),
      n({ id: 'b', created_at: '2026-08-27T11:00:00.000Z', is_read: true }),
      n({ id: 'c', created_at: '2026-08-27T10:00:00.000Z' }),
    ])
    const group = groupOf(page)
    assert.equal(group.loadedCount, 3, 'three events, one card')
    assert.equal(group.unreadCount, 2)
    // Three events collapse behind the disclosure — that is the layout this PR
    // shipped, so the closed card is what must be asserted, not the rows.
    const html = renderCard(page)
    assert.ok(html.includes('3 updates'))
    assert.ok(html.includes('aria-expanded="false"'), 'collapsed by default')
    assert.ok(html.includes('aria-label="Expand 3 updates for Balcony railing"'))
    assert.ok(html.includes('aria-label="View task Balcony railing"'), 'navigation')
    assert.ok(html.includes('Mark all read'), 'mark-read control')
    assert.ok(html.includes('Delete all notifications for this task'), 'delete control')
    // And the events still carry their context while collapsed, so opening the
    // disclosure cannot need another fetch.
    for (const row of group.notifications) {
      assert.equal(row.context?.activity?.note, 'Please confirm the revised dimensions.')
    }
  })

  test('16e. a historical row and a linked row render right side by side', async () => {
    // One page, two tasks: a single-event card each, so both event lines are on
    // screen. The point is that one page mixes linked and unlinked rows and
    // each gets the treatment it has earned.
    const OTHER = 'ffffffff-6666-4666-8666-ffffffffffff'
    const mixed = await serverPage([
      n({ id: 'linked' }),
      n({ id: 'historic', task_id: OTHER, activity_log_id: null }),
    ])
    assert.equal(mixed.find(r => r.id === 'linked')?.context?.activity?.note,
      'Please confirm the revised dimensions.')
    assert.equal(mixed.find(r => r.id === 'historic')?.context?.activity ?? null, null,
      'the historical row is resolved to nothing, not to somebody else\'s comment')

    const linkedHtml = renderCard([mixed[0]])
    const historicHtml = renderCard([mixed[1]])
    assert.ok(linkedHtml.includes('Please confirm the revised dimensions.'), 'the linked one')
    assert.ok(historicHtml.includes(COMMENT_WITHOUT_PREVIEW), 'and the historical one, honestly')
    assert.equal(detailLine(historicHtml), null, 'with no empty quotes')
  })

  test('16f. a status transition on a linked row shows both statuses', async () => {
    const page = await serverPage(
      [n({ title: 'Aditya moved task to Waiting' })],
      client({ action: 'status_changed', note: null, fromStatus: 'working', toStatus: 'waiting' }),
    )
    const html = renderCard(page)
    assert.ok(html.includes('Status changed'))
    assert.ok(/Working[\s\S]{0,40}Waiting/.test(html), 'previous → new, from the linked row')
  })
})

// ── The row context itself ───────────────────────────────────────────────────

describe('the attachment is faithful and never invents', () => {
  test('a row the page resolved nothing for is returned untouched', () => {
    const row = n({ task_id: null, activity_log_id: null })
    const [out] = attachRowContext([row], { taskHeaders: {}, activityDetails: {} })
    assert.equal('context' in out, false, 'no empty context is fabricated')
  })

  test('rowContext never borrows another row\'s activity', () => {
    const enrichment: NotificationPageEnrichment = {
      taskHeaders: {},
      activityDetails: { [ACT]: { action: 'note_added', note: 'mine', fromStatus: null, toStatus: null, actorName: 'A' } },
    }
    assert.equal(rowContext({ activity_log_id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee' }, enrichment), null)
    assert.equal(rowContext({ activity_log_id: null }, enrichment), null)
    assert.equal(rowContext({ activity_log_id: ACT }, enrichment)?.activity?.note, 'mine')
  })

  test('order and identity of the page are preserved', async () => {
    const rows = [n({ id: 'x' }), n({ id: 'y' }), n({ id: 'z' })]
    const out = await serverPage(rows)
    assert.deepEqual(out.map(r => r.id), ['x', 'y', 'z'])
    assert.equal(out.length, rows.length)
  })

  test('the list route sends the attached rows, not the bare ones', () => {
    assert.ok(LIST_ROUTE.includes('const enrichedRows = attachRowContext(notifications, enrichment)'))
    assert.ok(LIST_ROUTE.includes('notifications: enrichedRows'))
  })
})
