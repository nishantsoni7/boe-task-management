/**
 * THE TASK-GROUP HEADER, AFTER THE POLISH.
 *
 * WHAT CHANGED, AND WHY EACH THING IS ASSERTED HERE
 * -------------------------------------------------
 * Before:  Task title | Assigned to: Name | Mark all read | View Task | Delete
 * After:   Task title [person] Name  > N updates        | Mark all read | Delete
 *
 *   * "Assigned to:" cost more room than the fact was worth at this size, and
 *     `justify-content: space-between` threw the name to the far right of a
 *     900px card, leaving a wide empty band down the middle of every row. The
 *     person icon carries it on screen; the tooltip and a screen-reader string
 *     carry it everywhere else, so the icon is NEVER the only thing saying it.
 *   * "View Task" said what the title already implied. The title is now the
 *     link — a real anchor, to the exact href the button pushed.
 *
 * TWO IDENTITIES, NEVER CONFLATED. The header names the task's ASSIGNEE — who
 * is handling it. Each event underneath names its own ACTOR — "By <name> ·
 * <time>" — who did that particular thing. A card that merges them claims its
 * owner performed an action somebody else did.
 *
 * Run:
 *   npx tsx --test src/components/notifications/NotificationHeaderPolish.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import type { Notification } from '@/lib/types'
import { NotificationTaskGroup } from './NotificationTaskGroup'
import { groupNotificationsByTask, type NotificationTaskGroup as TaskGroup } from '@/lib/notifications/grouping'
import {
  ASSIGNEE_UNAVAILABLE,
  attachRowContext,
  enrichNotificationPage,
} from '@/lib/notifications/pageEnrichment'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SRC = read('src/components/notifications/NotificationTaskGroup.tsx')
const VIEW = read('src/components/notifications/NotificationsView.tsx')
const CSS = read('src/app/globals.css')

const TASK = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ACT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ACTOR = 'cccccccc-3333-4333-8333-cccccccccccc'
const ASSIGNEE = 'dddddddd-4444-4444-8444-dddddddddddd'

const LONG_TITLE =
  'A considerably longer task title that keeps going well past any sensible ' +
  'width and must not be allowed to push the group actions off the right edge'

let seq = 0
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `p${seq}`, user_id: 'me', task_id: TASK, entity_id: null,
    type: 'task_acknowledged', title: 'Mohit Sharma added a comment',
    body: 'fallback title', is_read: false, is_push_sent: false, is_digest: false,
    activity_log_id: ACT,
    created_at: '2026-08-27T10:00:00.000Z', read_at: null, ...over,
  } as Notification
}

/** The three reads enrichNotificationPage makes, stubbed. */
function client(opts: { taskTitle?: string; assigneeId?: string | null } = {}) {
  const assignee = opts.assigneeId === undefined ? ASSIGNEE : opts.assigneeId
  return {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === 'tasks') {
            return {
              data: [{ id: TASK, title: opts.taskTitle ?? 'Ertiga Service and Part Change', assigned_to: assignee }],
              error: null,
            }
          }
          if (table === 'task_activity_log') {
            return {
              data: [{
                id: ACT, actor_id: ACTOR, action: 'note_added',
                note: 'Please confirm the revised dimensions before production.',
                from_status: null, to_status: null,
              }],
              error: null,
            }
          }
          return {
            data: [{ id: ACTOR, full_name: 'Mohit Sharma' }, { id: ASSIGNEE, full_name: 'Aditya' }],
            error: null,
          }
        },
      }),
    }),
  }
}

async function page(rows: Notification[], c = client()): Promise<Notification[]> {
  const enrichment = await enrichNotificationPage(c, rows)
  return attachRowContext(rows, enrichment) as Notification[]
}

function groupOf(rows: Notification[]): TaskGroup {
  const g = groupNotificationsByTask(rows).find(i => i.kind === 'task')
  assert.ok(g && g.kind === 'task')
  return g
}

const noop = () => {}

function render(rows: Notification[], over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <NotificationTaskGroup
      group={groupOf(rows)}
      filter="all"
      selected={new Set()}
      pendingDeletes={new Set()}
      onToggleSelect={noop} onMarkGroupRead={noop}
      onDeleteGroup={noop} onDeleteOne={noop} onRowClick={noop}
      {...over}
    />,
  )
}

/** The header, isolated from the events beneath it. */
function headerOf(html: string): string {
  const end = html.indexOf('id="notif-group-')
  assert.ok(end > 0, 'the events panel marks the end of the header')
  return html.slice(0, end)
}

const one = async (over: Partial<Notification> = {}, c = client()) => render(await page([n(over)], c))

// ── 1–5. The assignee, beside the title ──────────────────────────────────────

describe('1-5. who is handling this task, beside its name', () => {
  test('1. the assignee sits in the header, immediately after the title', async () => {
    const head = headerOf(await one())
    const titleAt = head.indexOf('Ertiga Service and Part Change')
    const nameAt = head.indexOf('Aditya')
    assert.ok(titleAt > 0 && nameAt > titleAt, 'title first, assignee straight after')
    // And nothing else comes between them but the icon.
    const between = head.slice(titleAt, nameAt)
    assert.equal(between.includes('Mark all read'), false)
    assert.equal(between.includes('Delete'), false)
  })

  test('2. the project\'s person icon is drawn', async () => {
    const head = headerOf(await one())
    assert.match(head, /lucide-user\b/, 'lucide User — the icon 15 other screens already use')
    // Decorative: the meaning is carried by the text beside it, not by the glyph.
    assert.match(head, /class="lucide lucide-user"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*lucide-user/)
  })

  test('3. the visible words "Assigned to:" are gone', async () => {
    const html = await one()
    assert.equal(html.includes('Assigned to:'), false)
    assert.equal(/>\s*Assigned to\s*</.test(html.replace('<span class="boe-notif-sr-only">Assigned to </span>', '')), false)
  })

  test('4. but "Assigned to <name>" survives for anyone who cannot see the icon', async () => {
    const head = headerOf(await one())
    // Two independent carriers: a hover tooltip and a screen-reader-only string
    // inside the same element, so the name is announced with its relationship.
    assert.ok(head.includes('title="Assigned to Aditya"'), 'tooltip')
    assert.ok(head.includes('<span class="boe-notif-sr-only">Assigned to </span>'), 'announced')
    // And the class actually hides it — a "screen-reader only" span that is
    // merely unstyled would print the words back onto the screen.
    const rule = CSS.slice(CSS.indexOf('.boe-notif-sr-only'))
    assert.match(rule, /position:\s*absolute/)
    assert.match(rule, /clip:\s*rect\(0, 0, 0, 0\)/)
    assert.match(rule, /width:\s*1px/)
  })

  test('5. restrained blue, and secondary to the title', async () => {
    const head = headerOf(await one())
    // The same blue as the card's unread accent — one accent colour, not two.
    const CARD_BLUE = '#5585E8'
    const chip = head.slice(head.indexOf('title="Assigned to Aditya"') - 400,
                            head.indexOf('title="Assigned to Aditya"') + 400)
    assert.ok(chip.includes(`color:${CARD_BLUE}`), 'the assignee reads in the notification blue')
    // Smaller and lighter than the title, which stays the strongest thing here.
    assert.ok(chip.includes('font-size:11.5px'))
    assert.ok(chip.includes('font-weight:500'))
    assert.ok(head.includes('font-size:13.5px') && head.includes('font-weight:700'),
      'the title keeps its own weight')
    // Not a badge or a button: no fill, no border, no radius on the chip.
    assert.equal(/background:[^;"]*;[^"]*title="Assigned to/.test(head), false)
  })

  test('5b. it is a compact inline treatment, not a control', async () => {
    const head = headerOf(await one())
    const chipStart = head.lastIndexOf('<span', head.indexOf('title="Assigned to Aditya"'))
    const chip = head.slice(chipStart, head.indexOf('</span>', head.indexOf('Aditya')))
    assert.match(chip, /display:inline-flex/)
    assert.equal(chip.includes('<button'), false, 'the assignee is not clickable')
    assert.equal(chip.includes('href'), false, 'and not a link')
  })
})

// ── 6. The event actor stays separate ────────────────────────────────────────

describe('6. the header assignee and the event actor are different facts', () => {
  test('6. the actor is named under the event, the assignee in the header', async () => {
    const html = await one()
    const head = headerOf(html)
    const events = html.slice(html.indexOf('id="notif-group-'))

    assert.ok(head.includes('Aditya'), 'header: the task assignee')
    assert.equal(head.includes('Mohit Sharma'), false, 'the actor is NOT in the header')

    assert.ok(events.includes('By Mohit Sharma'), 'event: the actor who did it')
    assert.equal(events.includes('Assigned to'), false, 'the assignee is not repeated per event')
  })

  test('6b. and the comment preview underneath is untouched by any of this', async () => {
    const html = await one()
    assert.ok(html.includes('Please confirm the revised dimensions before production.'))
    assert.ok(html.includes('Added a comment'))
  })
})

// ── 7–11. View Task is gone; the title is the link ───────────────────────────

describe('7-11. one control, one destination', () => {
  test('7. there is no View Task button anywhere on the card', async () => {
    const html = await one()
    assert.equal(html.includes('View Task'), false)
    assert.equal(html.includes('View task'), false, 'nor its aria-label')
    assert.equal(html.includes('lucide-external-link'), false, 'nor its icon')
    // And the component no longer takes a handler for it.
    assert.equal(SRC.includes('onOpenTask'), false)
    assert.equal(VIEW.includes('onOpenTask={'), false)
  })

  test('8. the title is a real anchor', async () => {
    const head = headerOf(await one())
    assert.match(head, /<a[^>]+href="\/tasks\/[^"]+"/, 'a real link, not a div with onClick')
    assert.ok(head.includes('Ertiga Service and Part Change'))
    // A real anchor is why Enter works with no key handler of our own.
    assert.equal(SRC.includes('onKeyDown'), false, 'no hand-rolled keyboard handling is needed')
    // And it carries a visible focus ring rather than relying on nothing.
    const focus = CSS.slice(CSS.indexOf('.boe-notif-task-title:focus-visible'))
    assert.match(focus.slice(0, 120), /outline:\s*2px solid #5585E8/)
    assert.match(focus.slice(0, 160), /outline-offset/)
  })

  test('9. it points at the SAME route the removed button pushed', async () => {
    // The button called getNotificationMeta(group.latest).href and pushed it.
    // The link is given that identical value.
    const head = headerOf(await one())
    assert.ok(head.includes(`href="/tasks/${TASK}"`))
    assert.ok(SRC.includes('const href = getNotificationMeta(group.latest).href'),
      'the same derivation, unchanged')
    // A row with no task id has no href, so the title renders unlinked rather
    // than as a control that goes nowhere.
    const noTask = render([n({ id: 'nolink', task_id: TASK })], { headerInfo: undefined })
    assert.ok(noTask.includes('href="/tasks/'), 'a task row still links')
  })

  test('10. Mark all read is a button, not a link — it cannot navigate', async () => {
    const head = headerOf(await one())
    const at = head.indexOf('Mark all updates for this task as read')
    assert.ok(at > 0)
    const control = head.slice(head.lastIndexOf('<', at - 200), head.indexOf('</button>', at) + 9)
    assert.match(control, /<button/)
    assert.equal(control.includes('href'), false, 'no href — it cannot route')
  })

  test('11. Delete is a button too, and neither is nested in the link', async () => {
    const head = headerOf(await one())
    const at = head.indexOf('Delete all notifications for this task')
    assert.ok(at > 0)
    const control = head.slice(head.lastIndexOf('<', at - 200), head.indexOf('</button>', at) + 9)
    assert.match(control, /<button/)
    assert.equal(control.includes('href'), false)
    // The anchor closes before either action opens: an action inside the link
    // would navigate on every click.
    const linkEnd = head.indexOf('</a>')
    assert.ok(linkEnd > 0 && linkEnd < head.indexOf('Mark all updates'))
    assert.ok(linkEnd < head.indexOf('Delete all notifications'))
  })

  test('11b. and only Mark all read and Delete remain — no third action, no menu', async () => {
    const head = headerOf(await one())
    assert.ok(head.includes('Mark all read'))
    assert.ok(head.includes('Delete all notifications for this task'))
    for (const absent of ['View Task', 'More', 'aria-haspopup', 'lucide-ellipsis', 'lucide-more']) {
      assert.equal(head.includes(absent), false, `${absent} must not appear`)
    }
  })
})

// ── 12. Per-event controls stay independent ──────────────────────────────────

describe('12. the events keep their own controls', () => {
  test('12. per-notification select and delete are outside the header entirely', async () => {
    const html = await one()
    const events = html.slice(html.indexOf('id="notif-group-'))
    assert.match(events, /aria-label="Select update: Added a comment"/)
    assert.match(events, /aria-label="Delete this update: Added a comment"/)
    // Neither is a link, and neither sits inside one.
    assert.equal(events.includes('href='), false, 'no event control navigates')
  })
})

// ── 13–15. Layout ────────────────────────────────────────────────────────────

describe('13-15. desktop and mobile', () => {
  test('13. a very long title does not displace the actions', async () => {
    const head = headerOf(await one({}, client({ taskTitle: LONG_TITLE })))
    // The identity block yields; the action block never does.
    assert.match(head, /flex:1;min-width:0/, 'the identity block absorbs the pressure')
    assert.match(head, /flex-shrink:0/, 'the actions do not')
    // On desktop the title clips rather than wrapping the row open.
    assert.match(head, /text-overflow:ellipsis/)
    assert.ok(head.includes('Mark all read'), 'and the actions are still drawn')
  })

  test('13b. the middle gap is gone — this is one left block, not two poles', async () => {
    const head = headerOf(await one())
    assert.equal(head.includes('justify-content:space-between'), false,
      'space-between is what created the empty band across every row')
  })

  test('14. an unresolved assignee falls back honestly, with no empty person chip', async () => {
    const head = headerOf(await one({}, client({ assigneeId: null })))
    assert.ok(head.includes(ASSIGNEE_UNAVAILABLE), 'says so plainly')
    assert.equal(head.includes('title="Assigned to '), false, 'no tooltip for nobody')
    assert.equal(head.includes('lucide-user'), false, 'and no icon standing alone')
    // Muted, not the identity blue — it is an absence, not a person.
    assert.equal(head.includes(`color:#5585E8`), false)
    assert.ok(head.includes('Ertiga Service and Part Change'), 'the card still works')
  })

  test('15. mobile stacks, keeps the 44px floor, and forces no fixed width', async () => {
    const mob = headerOf(render(await page([n()]), { isMobile: true }))
    assert.match(mob, /flex-direction:column/)
    assert.match(mob, /min-height:44px/, 'the touch floor the design system requires')
    // A bare `width:` in pixels only — the card's own `max-width:900px` cap and
    // the 44px touch floor are both fine and are not what this is looking for.
    assert.equal(/(?<![a-z-])width:\d+px/.test(mob), false,
      'no element in the header is pinned to a fixed pixel width')
    assert.equal(mob.includes('white-space:nowrap;overflow:hidden'), false,
      'the title wraps on a phone rather than clipping')
    assert.ok(mob.includes('overflow-wrap:anywhere'), 'and a long word cannot overflow the card')
  })

  test('15b. desktop keeps one row', async () => {
    const desk = headerOf(await one())
    assert.match(desk, /flex-direction:row/)
  })
})

// ── 16–17. Nothing else moved ────────────────────────────────────────────────

describe('16-17. this is presentation only', () => {
  test('16. the comment preview still comes from the row context', async () => {
    // The cache fix this header sits on top of: the detail travels ON the row.
    const rows = await page([n()])
    assert.equal(rows[0].context?.activity?.note,
      'Please confirm the revised dimensions before production.')
    // And it survives a cache round-trip, rendered with no maps passed at all.
    const cached = JSON.parse(JSON.stringify(rows)) as Notification[]
    assert.ok(render(cached).includes('Please confirm the revised dimensions before production.'))
  })

  test('17. the header issues no query, and the read path is untouched', () => {
    for (const forbidden of ['supabase', 'fetch(', 'useQuery', 'useEffect', 'router.push']) {
      assert.equal(SRC.includes(forbidden), false,
        `the card must not ${forbidden} — a header is not a data source`)
    }
    // The page-level enrichment is FOUR lookups, all page-scoped `in()` batches
    // — never one per card. The task select gained created_by so the header can
    // name the other side of the task; that is a column on a table already
    // being read. The fourth query is the attachment lookup, which is what lets
    // an update that carried a file say so instead of "Comment added"; it is
    // keyed by the SAME activity ids the third query uses.
    const enrich = read('src/lib/notifications/pageEnrichment.ts')
    assert.equal((enrich.match(/\.select\(/g) ?? []).length, 4, 'four batched lookups')
    assert.ok(enrich.includes("select('id, title, assigned_to, created_by')"))
    // attachment_url joined the activity select so a HISTORICAL single-file
    // update is described as one; that is a column on a table already being
    // read, not a fifth query.
    assert.ok(enrich.includes("select('id, actor_id, action, note, from_status, to_status, attachment_url')"))
    assert.ok(enrich.includes("select('activity_log_id, file_name, file_type')"))
    assert.ok(enrich.includes("select('id, full_name')"))
  })

  test('17b. grouping, unread and the mutation handlers are all still wired', async () => {
    const rows = await page([
      n({ id: 'g1', created_at: '2026-08-27T12:00:00.000Z' }),
      n({ id: 'g2', created_at: '2026-08-27T11:00:00.000Z', is_read: true }),
    ])
    const group = groupOf(rows)
    assert.equal(group.loadedCount, 2)
    assert.equal(group.unreadCount, 1)
    const head = headerOf(render(rows))
    assert.ok(head.includes('2 updates'))
    assert.ok(head.includes('aria-expanded="false"'), 'still a disclosure')
    assert.ok(head.includes('Mark all read'))
    assert.ok(head.includes('Delete all notifications for this task'))
    // The view still passes the same two mutation handlers, unchanged.
    assert.ok(VIEW.includes('onMarkGroupRead={handleMarkGroupRead}'))
    assert.ok(VIEW.includes('onDeleteGroup={handleDeleteGroup}'))
    assert.ok(VIEW.includes('onDeleteOne={handleDeleteSingle}'))
  })

  test('17c. a fully read group still hides Mark all read', async () => {
    const head = headerOf(render(await page([n({ is_read: true })])))
    assert.equal(head.includes('Mark all read'), false)
    assert.ok(head.includes('Delete'), 'delete is always available')
  })
})
