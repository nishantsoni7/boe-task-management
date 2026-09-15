import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getNotificationCategoryFilter, resolveNotificationCategory, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'
import { canReadNotificationCategory, CATEGORY_FORBIDDEN } from '@/lib/notificationAccess'
import { isValidUUID } from '@/lib/ui'
import { NOTIFICATION_PAGE_SIZE, NOTIFICATION_MAX_ROWS } from '@/lib/notificationPaging'
import { attachRowContext, enrichNotificationPage } from '@/lib/notifications/pageEnrichment'
import { resolveViewAsSubject, isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'
import {
  APPROVAL_NOTIFICATION_TITLE_PATTERN, QUOTATION_TASK_TYPE, TASK_FEED_TASK_EMBED, TASK_FEED_TASK_TYPE_COLUMN,
  mutateInChunks, selectVisibleTaskNotificationIds, stripTaskFeedEmbed,
} from '@/lib/notifications/taskNotificationPolicy'

/**
 * Clamp a caller-supplied `?limit=` into [1, NOTIFICATION_MAX_ROWS].
 *
 * Absent / non-numeric / out of range all resolve to a usable bound rather
 * than an error: the worst a bad value can do is show the first page.
 */
function clampNotificationLimit(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return NOTIFICATION_PAGE_SIZE
  return Math.min(Math.floor(n), NOTIFICATION_MAX_ROWS)
}

// Lists the authenticated user's notifications (newest first), or — with
// `?count=1` — returns only the unread count for the sidebar badge.
// `?category=task|finance|order` narrows either path to one module's own rows
// (see getNotificationCategoryFilter). An absent category defaults to `task`
// for backward compatibility; a present-but-unrecognized value is rejected
// with 400 rather than silently falling back (see resolveNotificationCategory).
// Reads go through the service-role key so the feature does not depend on
// client-side RLS; every query is explicitly scoped to the caller's user id.
export async function GET(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const categoryResult = resolveNotificationCategory(req.nextUrl.searchParams.get('category'))
  if (!categoryResult.ok) {
    return NextResponse.json({ error: categoryResult.error }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Some feeds are management information, not self-service (see
  // ADMIN_ONLY_CATEGORIES). Checked before the filter is even built, and on the
  // count path as well as the list path — an unread number is itself a fact
  // about how many colleagues have disputed their pay.
  if (!(await canReadNotificationCategory(supabase, user.id, categoryResult.category))) {
    return NextResponse.json({ error: CATEGORY_FORBIDDEN }, { status: 403 })
  }

  // ── WHOSE NOTIFICATIONS? ────────────────────────────────────────────────────
  //
  // The DISPLAY SUBJECT's. Normally that is the caller and every query below is
  // scoped exactly as it always was. While an administrator previews an
  // employee, the badge and the list must show THAT employee's notifications —
  // an admin checking Dhruv's screen learns nothing from their own unread count
  // sitting under Dhruv's name.
  //
  // `?subjectUserId=` names the employee; it is NOT authorization.
  // resolveViewAsSubject reads the CALLER's own row from the database and
  // refuses unless they are an active administrator and the employee is
  // eligible. An invented id gets 403; an absent one resolves to the caller.
  //
  // The category gate above deliberately still asks about `user.id`: whether a
  // feed like attendance_payroll may be read AT ALL is a question about the
  // authenticated caller, not about whose screen is being drawn. An admin
  // previewing an employee is still an admin, and an ordinary employee cannot
  // use this parameter at all.
  //
  // THE ORDINARY READ DOES NOT QUEUE BEHIND THIS CHECK. Measured in production
  // (September 2026) every server-side round trip from this function costs
  // ~0.45 s, and the list was five of them in a row. When no other employee is
  // named, the subject can only ever be the caller, so the notification query
  // starts at once — scoped to `user.id` — while the check runs beside it. The
  // decision is still AWAITED BEFORE ANYTHING IS RETURNED OR ENRICHED: a refused
  // caller receives the refusal, and the rows read on their behalf (their own,
  // never anybody else's) are discarded. A preview still waits for the check
  // before reading, because its query names somebody else.
  const requestedSubjectId = req.nextUrl.searchParams.get('subjectUserId')
  const subjectCheck = resolveViewAsSubject(supabase, user.id, requestedSubjectId)
  let subjectId = user.id
  if (requestedSubjectId && requestedSubjectId !== user.id) {
    const decision = await subjectCheck
    if (!decision.allowed) {
      return NextResponse.json({ error: decision.reason }, { status: decision.status })
    }
    subjectId = decision.subjectId
  }
  const refusal = async (): Promise<NextResponse | null> => {
    const decision = await subjectCheck
    if (!decision.allowed) {
      return NextResponse.json({ error: decision.reason }, { status: decision.status })
    }
    if (decision.subjectId !== subjectId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return null
  }

  const activityFilter = getNotificationCategoryFilter(categoryResult.category)

  // THE TASK FEED'S TWO SILENT EVENTS. Quotation requests (by tasks.task_type,
  // joined through task_id) and approvals are not announced, and rows written
  // before that rule stay hidden rather than deleted. Applied to the count and
  // the list alike, BEFORE counting and paging, so a hidden row can neither
  // hold the badge up nor turn a page into an empty one. See
  // src/lib/notifications/taskNotificationPolicy.ts.
  const isTaskFeed = categoryResult.category === 'task'

  // Lightweight badge path: just the unread count.
  if (req.nextUrl.searchParams.get('count') === '1') {
    let countQuery = supabase
      .from('notifications')
      .select(isTaskFeed ? `id, ${TASK_FEED_TASK_EMBED}` : 'id', { count: 'exact', head: true })
      .eq('user_id', subjectId)
      .eq('is_read', false)
      .or(activityFilter)
      .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
    if (isTaskFeed) {
      countQuery = countQuery
        .neq(TASK_FEED_TASK_TYPE_COLUMN, QUOTATION_TASK_TYPE)
        .not('title', 'like', APPROVAL_NOTIFICATION_TITLE_PATTERN)
    }
    const [refused, { count, error }] = await Promise.all([refusal(), countQuery])
    if (refused) return refused
    if (error) {
      console.error('[notifications] count failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ unreadCount: count ?? 0 })
  }

  // BOUNDED, ALWAYS. `?limit=` lets the page ask for a further block when the
  // reader presses "Load older"; it is clamped to NOTIFICATION_MAX_ROWS, so no
  // request — crafted or accidental — can ever pull the full history down. A
  // missing or unparseable value falls back to the first page rather than 400ing:
  // this is a display bound, not a business input.
  const limit = clampNotificationLimit(req.nextUrl.searchParams.get('limit'))

  // One extra row than asked for, purely to answer "is there anything older?".
  // It is dropped before the response, so the client still receives exactly
  // `limit` rows and `hasMore` costs no second query.
  const columns = 'id, user_id, task_id, entity_id, type, title, body, is_read, is_push_sent, is_digest, created_at, read_at, activity_log_id'
  let listQuery = supabase
    .from('notifications')
    .select(isTaskFeed ? `${columns}, ${TASK_FEED_TASK_EMBED}` : columns)
    .eq('user_id', subjectId)
    .or(activityFilter)
    .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
  if (isTaskFeed) {
    listQuery = listQuery
      .neq(TASK_FEED_TASK_TYPE_COLUMN, QUOTATION_TASK_TYPE)
      .not('title', 'like', APPROVAL_NOTIFICATION_TITLE_PATTERN)
  }
  const [refused, { data, error }] = await Promise.all([refusal(), listQuery
    .order('created_at', { ascending: false })
    // DETERMINISTIC TIEBREAK. `created_at` is not unique — a batch insert
    // (every admin notified of one objection, the warranty sweep) writes many
    // rows on the same transaction timestamp. Ordering by it alone leaves ties
    // in whatever order the plan happens to produce, so two requests for
    // overlapping windows can disagree about which side of the LIMIT a tied row
    // falls on, and "Load older" could come back missing a row it had already
    // shown. `id` is the primary key, so this makes the sort total.
    .order('id', { ascending: false })
    .limit(limit + 1)])

  // Before enrichment, before the response: a refused caller gets nothing else.
  if (refused) return refused
  if (error) {
    console.error('[notifications] list failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // The select string is chosen at runtime (with or without the task embed), so
  // the client cannot infer a row type from it; the rows are exactly the columns
  // named above, as they always were. The embed existed only to filter and never
  // leaves the server.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetched = (data ?? []) as any[]
  const rows = isTaskFeed ? stripTaskFeedEmbed(fetched) : fetched
  const hasMore = rows.length > limit
  const notifications = hasMore ? rows.slice(0, limit) : rows

  // ── Task header facts: title and assignee, for the whole page at once ──
  //
  // TWO QUERIES, NOT ONE PER CARD. The ids come from `notifications`, which is
  // already clamped to NOTIFICATION_MAX_ROWS and already scoped to this caller,
  // so both lookups are bounded by the page and can only describe tasks this
  // person is being notified about. A failure returns an empty map and the
  // cards say "Assignee unavailable" — a notification list is more useful
  // without an assignee than absent. See src/lib/notifications/taskAssignees.ts
  // for why the newest event's ACTOR is not an acceptable substitute.
  const enrichment = categoryResult.category === 'task'
    ? await enrichNotificationPage(supabase, notifications)
    : { taskHeaders: {}, activityDetails: {} }
  const { taskHeaders, activityDetails } = enrichment

  // ── THE DETAIL TRAVELS ON THE ROW, NOT BESIDE IT ──
  //
  // The maps are still returned — they are the enrichment's own contract and
  // several callers read them — but the CARD reads the copy attached here.
  //
  // Returning the detail only as a sibling map is what made a correctly linked
  // comment render as a bare "Comment added": the client kept the maps in
  // component state and the rows in the React Query cache, and those two go out
  // of step the moment a cached page is served without the query function
  // running (30s staleTime), a mutation writes rows back directly, or a second
  // observer shares the fetch. Attached to the row, the context is the same
  // object the cache holds — there is no second store to fall behind.
  //
  // Composition over data already fetched: no extra query, per row or otherwise.
  const enrichedRows = attachRowContext(notifications, enrichment)
  // Unread among the rows returned. NOT the category's total unread — that is
  // what `?count=1` is for, and the badge reads it from there. Kept in the
  // response because callers have always had it.
  const unreadCount = notifications.filter(n => !n.is_read).length
  return NextResponse.json({ notifications: enrichedRows, unreadCount, hasMore, limit, taskHeaders, activityDetails })
}

// Deletes ONE module's notifications for the authenticated user —
// `?category=task|finance|order`, defaulting to `task` when absent (same rule
// as GET; a present-but-unrecognized value is rejected with 400). Always
// scoped to a single module's filter so "Delete all" on one module's page can
// never remove another module's rows.
// Also scoped strictly to user_id = caller — no other user's rows are touched.
//
// `?taskId=<uuid>` narrows the same operation to ONE task: "Delete all
// notifications for this task". It belongs here rather than on
// /delete-selected because this route ALREADY carries the category filter and
// the system-type exclusion that a group action needs, and /delete-selected is
// deliberately id-only (it takes ids the caller already holds, so it needs no
// category — see attendancePayrollNotifications.test.ts).
//
// WHY NOT DRIVE IT FROM LOADED IDS. The page is bounded to the newest N. A
// group delete built from loaded ids leaves older rows for that task on the
// server, so the group reappears the moment somebody presses "Load older" and
// the unread badge stays wrong in the meantime. The task id lets the DATABASE
// decide the set.
//
// IT DELETES NOTIFICATION ROWS AND NOTHING ELSE. No task, no activity record,
// no comment, no attachment: this statement names one table.
export async function DELETE(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const categoryResult = resolveNotificationCategory(req.nextUrl.searchParams.get('category'))
  if (!categoryResult.ok) {
    return NextResponse.json({ error: categoryResult.error }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Same gate as GET: a category nobody may read is a category nobody may
  // empty. Without this, "Delete all" would be a write path into a feed the
  // read path refuses.
  if (!(await canReadNotificationCategory(supabase, user.id, categoryResult.category))) {
    return NextResponse.json({ error: CATEGORY_FORBIDDEN }, { status: 403 })
  }

  // A PREVIEW MAY NOT DELETE. The scope below is `user.id` — the ADMIN's own
  // rows — so a preview could never have reached the employee's notifications;
  // what this refuses is the other mistake, an administrator inspecting somebody
  // else's inbox and silently emptying their own. Trusting the header is safe
  // because it can only ever take authority away: a caller who omits it gets no
  // more than they already had as themselves. See src/lib/viewAs.ts.
  if (isPreviewRequest(req.headers)) {
    return NextResponse.json({ error: PREVIEW_WRITE_REFUSED }, { status: 403 })
  }

  // Optional narrowing to one task. Validated before Postgres sees it: a
  // malformed value would otherwise surface as a 22P02 cast error dressed up as
  // a 500 rather than the 400 it is.
  const taskId = req.nextUrl.searchParams.get('taskId')
  if (taskId !== null && !isValidUUID(taskId)) {
    return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })
  }

  const activityFilter = getNotificationCategoryFilter(categoryResult.category)
  // `.select('id, is_read')` so the response reports BOTH how many of the
  // caller's rows were removed and how many of those were unread — the exact
  // number the badge must drop by. Both come from the DELETE itself, so there
  // is no count-then-delete window in which the two could disagree.
  //
  // A category (or task) with nothing in it deletes 0 rows and is still a
  // success — an accurate idempotent result, not a failure.
  let data: { id: string; is_read: boolean }[] | null = null
  let error: { message: string } | null = null
  // Some chunks committed before another failed: rows ARE gone, so the refusal
  // must say how many rather than read as "nothing happened".
  let partial = false

  if (categoryResult.category === 'task') {
    // THE TASK FEED DELETES WHAT IT SHOWS, AND NOTHING IT HIDES. Quotation
    // requests and approvals are kept out of this feed by a filter on the
    // embedded task, which PostgREST refuses on a DELETE — so the visible set
    // is resolved with the list's own predicate first and removed by id. A
    // hidden row is history the reader never saw; "Delete all" must not erase
    // it. Each chunk still reports its own deleted rows, so `unreadAffected`
    // comes from the deletes themselves; chunks run a few at a time, and a
    // failure part-way is reported with what was already removed
    // (mutateInChunks). See taskNotificationPolicy.ts.
    const visible = await selectVisibleTaskNotificationIds(supabase, { userId: user.id, taskId })
    error = visible.error
    if (!error) {
      const applied = await mutateInChunks<{ id: string; is_read: boolean }>(visible.ids, ids => supabase
        .from('notifications')
        .delete()
        .eq('user_id', user.id)
        .in('id', ids)
        .select('id, is_read'))
      data = applied.rows
      error = applied.error
      partial = applied.error !== null && applied.completedChunks > 0
    }
  } else {
    let deleteQuery = supabase
      .from('notifications')
      .delete()
      .eq('user_id', user.id)
      .or(activityFilter)
      .not('type', 'in', SYSTEM_TYPE_EXCLUSION)
    // An EXTRA condition on top of the caller, category and system filters —
    // never a replacement for any of them.
    if (taskId !== null) deleteQuery = deleteQuery.eq('task_id', taskId)

    const res = await deleteQuery.select('id, is_read')
    data = res.data
    error = res.error
  }

  const deleted = data ?? []
  if (error) {
    // Message only — never the deleted rows, whose titles/bodies carry task
    // titles and client names.
    console.error('[notifications/delete-all] failed:', error.message)
    if (partial) {
      // PART OF IT HAPPENED. Still a failure, but with the exact counts, so the
      // client re-reads instead of restoring rows that are gone. Retrying is
      // safe: every chunk deletes by id.
      return NextResponse.json({
        error: 'Some notifications could not be deleted. Please try again.',
        partial: true,
        category: categoryResult.category,
        deletedCount: deleted.length,
        unreadAffected: deleted.filter(r => !r.is_read).length,
      }, { status: 500 })
    }
    return NextResponse.json({ error: 'Could not delete notifications' }, { status: 500 })
  }
  return NextResponse.json({
    success: true,
    category: categoryResult.category,
    taskId: taskId ?? undefined,
    deletedCount: deleted.length,
    // Exact, from the same statement. The client subtracts this rather than
    // counting the unread rows it happened to have loaded, which for a bounded
    // page is only ever a lower bound.
    unreadAffected: deleted.reduce((acc, r) => (r.is_read ? acc : acc + 1), 0),
  })
}
