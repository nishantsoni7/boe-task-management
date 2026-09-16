// THE ASSIGNEE LOOKUP — batched, bounded, and never the latest actor.
//
// Run:
//   npx tsx --test src/lib/notifications/taskAssignees.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectTaskIds,
  collectActivityIds,
  assigneeLabel,
  taskTitleFor,
  enrichNotificationPage,
  ASSIGNEE_UNAVAILABLE,
} from './pageEnrichment'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const T1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const U1 = 'cccccccc-3333-4333-8333-cccccccccccc'

/** Records every query so the test can count round trips. */
function stubClient(
  rows: { tasks?: unknown[]; users?: unknown[]; task_activity_log?: unknown[]; task_attachments?: unknown[] },
  errors: { tasks?: string; users?: string; task_activity_log?: string; task_attachments?: string } = {},
) {
  const calls: { table: string; ids: readonly string[] }[] = []

  // PostgREST answers `assignee:assigned_to(full_name)` by following the foreign
  // key and attaching the row, so the stub does the same: a fixture still lists
  // its people under `users`, and they arrive WITH the task or activity row.
  // A person with no `users` fixture embeds as null — a deleted employee.
  const people = new Map<string, { full_name: unknown }>(
    ((rows.users ?? []) as { id?: unknown; full_name?: unknown }[])
      .filter(u => typeof u.id === 'string')
      .map(u => [u.id as string, { full_name: u.full_name }]))
  const person = (id: unknown) => (typeof id === 'string' ? people.get(id) ?? null : null)
  const embed = (table: string, row: unknown) => {
    if (!row || typeof row !== 'object') return row
    const r = row as Record<string, unknown>
    if (table === 'tasks') return { ...r, assignee: person(r.assigned_to), creator: person(r.created_by) }
    if (table === 'task_activity_log') return { ...r, actor: person(r.actor_id) }
    return r
  }

  const client = {
    from(table: 'tasks' | 'users' | 'task_activity_log' | 'task_attachments') {
      return {
        select() {
          return {
            in(_col: string, ids: readonly string[]) {
              calls.push({ table, ids })
              const err = errors[table]
              return Promise.resolve({
                data: err ? null : (rows[table] ?? []).map(r => embed(table, r)),
                error: err ? { message: err } : null,
              })
            },
          }
        },
      }
    },
  }
  return { client, calls }
}

// ── 11. No per-group request ─────────────────────────────────────────────────

describe('11. the lookup is batched, never one request per group', () => {
  test('twenty tasks cost exactly one query', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${T1.slice(0, -2)}${String(i).padStart(2, '0')}`)
    const { client, calls } = stubClient({
      tasks: ids.map(id => ({ id, title: 't', assigned_to: U1 })),
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    await enrichNotificationPage(client, ids.map(id => ({ task_id: id })))
    assert.equal(calls.length, 1, 'one tasks query — regardless of count, names included')
    assert.deepEqual(calls.map(c => c.table), ['tasks'])
    assert.equal(calls[0].ids.length, 20, 'all ids in ONE in() filter')
  })

  test('no tasks means no query at all', async () => {
    const { client, calls } = stubClient({})
    assert.deepEqual(await enrichNotificationPage(client, []), { taskHeaders: {}, activityDetails: {} })
    assert.equal(calls.length, 0)
  })

  test('tasks sharing an assignee still cost one query, and both resolve', async () => {
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'a', assigned_to: U1 }, { id: T2, title: 'b', assigned_to: U1 }],
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    const { taskHeaders: map } = await enrichNotificationPage(client, [{ task_id: T1 }, { task_id: T2 }])
    assert.equal(calls.length, 1, 'no people query to repeat')
    assert.equal(map[T1].assigneeName, 'Nishant')
    assert.equal(map[T2].assigneeName, 'Nishant')
  })

  test('the id set is bounded by the page, and de-duplicated', () => {
    const page = [
      { task_id: T1 }, { task_id: T1 }, { task_id: T2 },
      { task_id: null }, { task_id: '' },
    ]
    assert.deepEqual(collectTaskIds(page).sort(), [T1, T2].sort())
  })

  test('and the route asks for it once per page, not per card', () => {
    const route = read('src/app/api/notifications/route.ts')
    assert.equal((route.match(/enrichNotificationPage\(/g) ?? []).length, 1)
    assert.ok(route.includes('enrichNotificationPage(supabase, notifications)'))
    // Only on the Task feed — the other categories have no task to describe.
    assert.ok(route.includes("categoryResult.category === 'task'"))
  })
})

// ── 2. The assignee, not the actor ───────────────────────────────────────────

describe('2. the header people come from the task, never from an event', () => {
  test('the names are read from tasks.assigned_to / created_by → users.full_name', async () => {
    // BOTH SIDES ARE FETCHED NOW. The header names the person the reader is
    // dealing with, and when the reader IS the assignee that is the creator —
    // see headerCounterpart. Both names are EMBEDDED on the task row, so the
    // second side costs neither a query nor a wait.
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'test task', assigned_to: U1, created_by: U2 }],
      users: [{ id: U1, full_name: 'Nishant' }, { id: U2, full_name: 'Shravi' }],
    })
    const { taskHeaders: map } = await enrichNotificationPage(client, [{ task_id: T1 }])
    assert.deepEqual(map[T1], {
      title: 'test task',
      assigneeName: 'Nishant', assigneeId: U1,
      creatorName: 'Shravi',   creatorId: U2,
    })
    assert.deepEqual(calls.map(c => c.table), ['tasks'],
      'both names came back with the task row, in one query')
  })

  test('a task whose creator is also its assignee resolves one person, embedded', async () => {
    // Names arrive WITH the rows that carry the ids, so there is no people
    // query left to deduplicate — and none to wait for.
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'a', assigned_to: U1, created_by: U1 }],
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    const { taskHeaders: map } = await enrichNotificationPage(client, [{ task_id: T1 }])
    assert.equal(map[T1].assigneeName, 'Nishant')
    assert.equal(map[T1].creatorName, 'Nishant')
    assert.equal(calls.some(c => c.table === 'users'), false, 'no second wave for names')
    const src = read('src/lib/notifications/pageEnrichment.ts')
    assert.equal((src.match(/from\('users'\)/g) ?? []).length, 0)
  })

  test('the module reads no notification field that could carry an actor', () => {
    const src = read('src/lib/notifications/pageEnrichment.ts')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const field of ['n.title', 'notification.title', 'getNotificationMeta', 'headingIsActor']) {
      assert.equal(src.includes(field), false, `must not consult ${field}`)
    }
  })

  test('the select names exactly the columns needed, and nothing personal', () => {
    const src = read('src/lib/notifications/pageEnrichment.ts')
    // created_by joined assigned_to: one more RELATIONSHIP column on a table
    // the page already reads, and no additional query. Still nothing about a
    // person beyond the display name the reader already sees on the task.
    assert.ok(src.includes("select('id, title, assigned_to, created_by, assignee:assigned_to(full_name), creator:created_by(full_name)')"))
    // The person columns are EMBEDS through the foreign keys, so a name costs
    // no query of its own — and still nothing but the display name travels.
    assert.equal(src.includes("select('id, full_name')"), false)
    // attachment_url is the LEGACY single-file column. It is read so a
    // historical update can be described as an attachment rather than a bare
    // comment — a column on a table already being read, NOT a fifth query — and
    // it is consumed server-side; the behavioural test below proves the value
    // never reaches the client.
    assert.ok(src.includes("select('id, actor_id, action, note, from_status, to_status, attachment_url, actor:actor_id(full_name)')"))
    // The attachment lookup names the LINK and the two display columns, and
    // deliberately not `url` or `storage_path`: it decides one word in a
    // sentence ("attached a document"), and a reference that locates the object
    // in storage has no reason to reach a notification card.
    assert.ok(src.includes("select('activity_log_id, file_name, file_type')"))
    const selects = [...src.matchAll(/select\('([^']*)'\)/g)].map(m => m[1])
    assert.deepEqual(selects, [
      'id, title, assigned_to, created_by, assignee:assigned_to(full_name), creator:created_by(full_name)',
      'id, actor_id, action, note, from_status, to_status, attachment_url, actor:actor_id(full_name)',
      'activity_log_id, file_name, file_type',
    ], 'exactly three selects, exactly these columns')
    for (const column of ['url', 'storage_path', 'attachment_storage_path']) {
      assert.equal(selects.some(sel => sel.split(/,\s*/).includes(column)), false,
        `the lookup must not select ${column}`)
    }
    for (const column of ['email', 'phone', 'salary', 'role', 'employee_code', '*']) {
      assert.equal(selects.some(sel => sel.includes(column)), false,
        `the lookup must not select ${column}`)
    }
  })
})

// ── 12. Missing data renders safely ──────────────────────────────────────────

describe('12. every missing case has one honest answer', () => {
  test('no entry at all', () => {
    assert.equal(assigneeLabel(undefined), ASSIGNEE_UNAVAILABLE)
  })

  test('an unassigned task', async () => {
    const { client } = stubClient({ tasks: [{ id: T1, title: 'x', assigned_to: null }] })
    const { taskHeaders: map } = await enrichNotificationPage(client, [{ task_id: T1 }])
    assert.equal(map[T1].assigneeName, null)
    assert.equal(assigneeLabel(map[T1]), ASSIGNEE_UNAVAILABLE)
  })

  test('a deleted or unreadable employee record', async () => {
    const { client } = stubClient({
      tasks: [{ id: T1, title: 'x', assigned_to: U1 }],
      users: [], // the row is gone
    })
    const { taskHeaders: map } = await enrichNotificationPage(client, [{ task_id: T1 }])
    assert.equal(map[T1].assigneeName, null)
    assert.equal(assigneeLabel(map[T1]), ASSIGNEE_UNAVAILABLE)
  })

  test('a blank name is treated as missing, not rendered as empty space', () => {
    assert.equal(assigneeLabel({ title: 'x', assigneeName: '   ' }), ASSIGNEE_UNAVAILABLE)
  })

  test('a person with no readable row still yields titles, and never throws', async () => {
    // Nothing embeds for them, exactly as the old lookup returned no row.
    const { client } = stubClient({ tasks: [{ id: T1, title: 'test task', assigned_to: U1 }], users: [] })
    const { taskHeaders: map } = await enrichNotificationPage(client, [{ task_id: T1 }])
    assert.equal(map[T1].title, 'test task')
    assert.equal(assigneeLabel(map[T1]), ASSIGNEE_UNAVAILABLE)
  })

  test('a failed tasks query yields an empty map, and never throws', async () => {
    const { client } = stubClient({}, { tasks: 'connection reset' })
    assert.deepEqual((await enrichNotificationPage(client, [{ task_id: T1 }])).taskHeaders, {})
  })

  test('the title falls back to whatever the group already derived', () => {
    assert.equal(taskTitleFor(undefined, 'from the notification'), 'from the notification')
    assert.equal(taskTitleFor({ title: '  ', assigneeName: null }, 'fallback'), 'fallback')
    assert.equal(taskTitleFor({ title: 'authoritative', assigneeName: null }, 'fallback'), 'authoritative')
  })
})

// ── 13-18. The linked activity batch ─────────────────────────────────────────

const ACT1 = 'dddddddd-4444-4444-8444-dddddddddddd'
const ACT2 = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const U2   = 'ffffffff-6666-4666-8666-ffffffffffff'

describe('13-18. linked activity detail', () => {
  test('13. a linked comment returns its note', async () => {
    const { client } = stubClient({
      tasks: [{ id: T1, title: 'test task', assigned_to: U1 }],
      task_activity_log: [{ id: ACT1, actor_id: U2, action: 'note_added', note: 'Please confirm the dimensions.', from_status: null, to_status: null }],
      users: [{ id: U1, full_name: 'Nishant' }, { id: U2, full_name: 'Dhruv' }],
    })
    const { activityDetails } = await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    assert.equal(activityDetails[ACT1].note, 'Please confirm the dimensions.')
    assert.equal(activityDetails[ACT1].actorName, 'Dhruv')
  })

  test('14. a linked status change returns BOTH values from the exact row', async () => {
    const { client } = stubClient({
      tasks: [{ id: T1, title: 'test task', assigned_to: U1 }],
      task_activity_log: [{ id: ACT2, actor_id: U1, action: 'status_changed', note: null, from_status: 'working', to_status: 'waiting' }],
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    const { activityDetails } = await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT2 }])
    assert.equal(activityDetails[ACT2].fromStatus, 'working')
    assert.equal(activityDetails[ACT2].toStatus, 'waiting')
  })

  test('15. assignees AND actors resolve in the SAME wave, with no people query', async () => {
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'a', assigned_to: U1 }, { id: T2, title: 'b', assigned_to: U2 }],
      task_activity_log: [
        { id: ACT1, actor_id: U1, action: 'note_added', note: 'x', from_status: null, to_status: null },
        { id: ACT2, actor_id: U2, action: 'note_added', note: 'y', from_status: null, to_status: null },
      ],
      users: [{ id: U1, full_name: 'Nishant' }, { id: U2, full_name: 'Dhruv' }],
    })
    await enrichNotificationPage(client, [
      { task_id: T1, activity_log_id: ACT1 },
      { task_id: T2, activity_log_id: ACT2 },
    ])
    assert.equal(calls.filter(c => c.table === 'users').length, 0, 'no people query at all')
    assert.deepEqual(calls.map(c => c.table).sort(), ['task_activity_log', 'task_attachments', 'tasks'],
      'three reads, one wave: the names ride along with the rows that name them')
  })

  test('16. only ids taken from the caller\'s own rows are ever requested', async () => {
    const UNRELATED = '99999999-9999-4999-8999-999999999999'
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'a', assigned_to: U1 }],
      task_activity_log: [{ id: ACT1, actor_id: U1, action: 'note_added', note: 'x', from_status: null, to_status: null }],
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    const activityCall = calls.find(c => c.table === 'task_activity_log')!
    assert.deepEqual(activityCall.ids, [ACT1])
    assert.equal(activityCall.ids.includes(UNRELATED), false)
    // Nothing outside the page can enter: the ids come only from the rows.
    assert.deepEqual(collectActivityIds([{ activity_log_id: ACT1 }, { activity_log_id: null }]), [ACT1])
  })

  test('17. a failed activity query leaves the feed intact with empty detail', async () => {
    const { client } = stubClient(
      { tasks: [{ id: T1, title: 'test task', assigned_to: U1 }], users: [{ id: U1, full_name: 'Nishant' }] },
      { task_activity_log: 'connection reset' })
    const out = await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    assert.deepEqual(out.activityDetails, {}, 'no detail')
    assert.equal(out.taskHeaders[T1].assigneeName, 'Nishant', 'but the header still resolved')
  })

  test('18. the query count is bounded: three, whatever the page holds', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      task_id: `${T1.slice(0, -2)}${String(i).padStart(2, '0')}`,
      activity_log_id: `${ACT1.slice(0, -2)}${String(i).padStart(2, '0')}`,
    }))
    const { client, calls } = stubClient({ tasks: [], task_activity_log: [], users: [] })
    await enrichNotificationPage(client, many)
    // tasks + activity + attachments; no people resolved, so no users query.
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map(c => c.table).sort(),
      ['task_activity_log', 'task_attachments', 'tasks'])
  })

  test('a page with no links asks nothing of the activity or attachment tables', async () => {
    const { client, calls } = stubClient({ tasks: [{ id: T1, title: 'a', assigned_to: null }] })
    await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: null }])
    assert.equal(calls.some(c => c.table === 'task_activity_log'), false)
    assert.equal(calls.some(c => c.table === 'task_attachments'), false)
  })

  test('the attachment lookup is scoped by the SAME activity ids, never widened', async () => {
    const { client, calls } = stubClient({ tasks: [], task_activity_log: [], users: [] })
    await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    const activity = calls.find(c => c.table === 'task_activity_log')
    const attachments = calls.find(c => c.table === 'task_attachments')
    assert.deepEqual(attachments?.ids, activity?.ids,
      'it can only describe files on an update this reader was notified about')
  })

  test('a failed attachment lookup leaves the rest of the page intact', async () => {
    const { client } = stubClient(
      {
        tasks: [{ id: T1, title: 'test task', assigned_to: U1 }],
        task_activity_log: [{ id: ACT1, actor_id: U1, action: 'note_added', note: 'See attached' }],
        users: [{ id: U1, full_name: 'Nishant' }],
      },
      { task_attachments: 'connection reset' })
    const out = await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    assert.deepEqual(out.activityDetails[ACT1].attachments, [], 'no files known')
    assert.equal(out.activityDetails[ACT1].note, 'See attached', 'the comment still resolved')
    assert.equal(out.taskHeaders[T1].assigneeName, 'Nishant', 'and so did the header')
  })

  test('files are grouped onto the update that carried them', async () => {
    const { client } = stubClient({
      tasks: [],
      task_activity_log: [{ id: ACT1, actor_id: null, action: 'note_added', note: null }],
      task_attachments: [
        { activity_log_id: ACT1, file_name: 'po.pdf', file_type: 'PDF' },
        { activity_log_id: ACT1, file_name: 'site.jpg', file_type: 'Image' },
      ],
    })
    const out = await enrichNotificationPage(client, [{ task_id: null, activity_log_id: ACT1 }])
    assert.deepEqual(out.activityDetails[ACT1].attachments, [
      { fileType: 'PDF', name: 'po.pdf' },
      { fileType: 'Image', name: 'site.jpg' },
    ])
  })
})

// ── The LEGACY single-file column ────────────────────────────────────────────
//
// Before `task_attachments`, an update's one file lived in
// `task_activity_log.attachment_url`. Task Detail has always counted it, so it
// said "ABC attached a document" for those rows while the notification card
// said "Comment added" for the very same event. These pin the parity, and pin
// that closing it did NOT put a storage reference into the payload.

describe('a historical single-file update is described, not shipped', () => {
  const LEGACY_PDF = 'https://xyz.supabase.co/storage/v1/object/public/task-attachments/tasks/9/po.pdf'
  const legacyRow = (url: string) => ({
    tasks: [],
    task_activity_log: [{ id: ACT1, actor_id: null, action: 'note_added', note: null, attachment_url: url }],
  })

  test('a legacy attachment is classified, so the card no longer says "Comment added"', async () => {
    const { client } = stubClient(legacyRow(LEGACY_PDF))
    const out = await enrichNotificationPage(client, [{ task_id: null, activity_log_id: ACT1 }])
    assert.deepEqual(out.activityDetails[ACT1].attachments, [{ fileType: 'PDF', name: null }])
  })

  test('THE URL NEVER REACHES THE CLIENT — only the word it classified to', async () => {
    const { client } = stubClient(legacyRow(LEGACY_PDF))
    const out = await enrichNotificationPage(client, [{ task_id: null, activity_log_id: ACT1 }])
    // The whole payload, the way the route serialises it to the browser.
    const wire = JSON.stringify(out)
    assert.equal(wire.includes(LEGACY_PDF), false, 'no attachment URL')
    assert.equal(wire.includes('task-attachments'), false, 'no bucket name')
    assert.equal(wire.includes('tasks/9'), false, 'no storage path')
    assert.equal(wire.includes('attachment_url'), false, 'not even the column')
  })

  test('an image is still an image, and a canonical storage:// ref classifies too', async () => {
    for (const [url, expected] of [
      ['https://x.co/storage/v1/object/public/task-attachments/tasks/9/site.JPG', 'Image'],
      ['storage://tasks/9/scan.pdf', 'PDF'],
      ['https://x.co/a/b/sheet.xlsx?token=abc', 'Excel'],
    ] as const) {
      const { client } = stubClient(legacyRow(url))
      const out = await enrichNotificationPage(client, [{ task_id: null, activity_log_id: ACT1 }])
      assert.equal(out.activityDetails[ACT1].attachments?.[0]?.fileType, expected, url)
    }
  })

  test('a modern multi-file update is untouched by the fallback', async () => {
    // Presence of ANY linked row wins outright: this cannot de-duplicate by
    // path without selecting storage_path, which it deliberately does not.
    const { client } = stubClient({
      ...legacyRow(LEGACY_PDF),
      task_attachments: [{ activity_log_id: ACT1, file_name: 'new.png', file_type: 'Image' }],
    })
    const out = await enrichNotificationPage(client, [{ task_id: null, activity_log_id: ACT1 }])
    assert.deepEqual(out.activityDetails[ACT1].attachments, [{ fileType: 'Image', name: 'new.png' }])
  })

  test('a row with neither source still reports no files', async () => {
    const { client } = stubClient({
      tasks: [],
      task_activity_log: [{ id: ACT1, actor_id: null, action: 'note_added', note: 'Just text', attachment_url: null }],
    })
    const out = await enrichNotificationPage(client, [{ task_id: null, activity_log_id: ACT1 }])
    assert.deepEqual(out.activityDetails[ACT1].attachments, [])
  })
})

// ── The embedded person ──────────────────────────────────────────────────────

describe('embedded people, in both shapes PostgREST can answer', () => {
  test('a to-one embed returned as an ARRAY still resolves the name', async () => {
    const client = {
      from: (table: string) => ({
        select: () => ({
          in: async () => {
            if (table === 'tasks') {
              return {
                data: [{ id: T1, title: 'x', assigned_to: U1, created_by: U1,
                  assignee: [{ full_name: 'Nishant' }], creator: [{ full_name: 'Nishant' }] }],
                error: null,
              }
            }
            if (table === 'task_activity_log') {
              return {
                data: [{ id: ACT1, actor_id: U1, action: 'note_added', note: 'x',
                  from_status: null, to_status: null, actor: [{ full_name: 'Nishant' }] }],
                error: null,
              }
            }
            return { data: [], error: null }
          },
        }),
      }),
    }
    const out = await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    assert.equal(out.taskHeaders[T1].assigneeName, 'Nishant')
    assert.equal(out.taskHeaders[T1].creatorName, 'Nishant')
    assert.equal(out.activityDetails[ACT1].actorName, 'Nishant')
  })

  test('one person missing leaves the other intact, and the card keeps its fallbacks', async () => {
    // U2 has no readable row: nothing embeds for them, exactly as the old
    // lookup returned no row for a deleted employee.
    const { client } = stubClient({
      tasks: [{ id: T1, title: 'x', assigned_to: U1, created_by: U2 }],
      users: [{ id: U1, full_name: 'Nishant' }],
      task_activity_log: [{ id: ACT1, actor_id: U2, action: 'note_added', note: 'x', from_status: null, to_status: null }],
    })
    const out = await enrichNotificationPage(client, [{ task_id: T1, activity_log_id: ACT1 }])
    assert.equal(out.taskHeaders[T1].assigneeName, 'Nishant')
    assert.equal(out.taskHeaders[T1].creatorName, null)
    assert.equal(out.activityDetails[ACT1].actorName, null)
    assert.equal(assigneeLabel(out.taskHeaders[T1]), 'Nishant')
    assert.equal(out.activityDetails[ACT1].note, 'x', 'the event itself still renders')
  })

  test('a blank embedded name renders as unavailable, never as empty space', async () => {
    const { client } = stubClient({ tasks: [{ id: T1, title: 'x', assigned_to: U1 }], users: [{ id: U1, full_name: '   ' }] })
    const out = await enrichNotificationPage(client, [{ task_id: T1 }])
    assert.equal(assigneeLabel(out.taskHeaders[T1]), ASSIGNEE_UNAVAILABLE)
  })
})
