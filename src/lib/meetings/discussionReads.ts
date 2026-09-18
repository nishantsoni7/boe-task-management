// Reading the order-discussion workflow back.
//
// Five indexed reads, batched — never one query per issue and never one per
// meeting. A six-meeting issue costs the same as a one-meeting issue, which is
// what keeps a live review responsive:
//
//   1. this meeting's agenda            appearances by meeting_id
//   2. the issues on it                 items by id
//   3. every appearance of those issues by discussion_item_id   (the whole thread)
//   4. the meetings those sit in        meetings by id          (RLS narrows this)
//   5. the trail and the images         events + evidence by the ids above
//
// RLS decides what comes back at every step, so nothing here re-implements
// visibility. A meeting the reader may not see simply does not arrive, and
// groupDiscussionHistory() renders that group as "a meeting you cannot see"
// rather than inventing a title for it.
//
// Every read is paged through fetchAllRows: PostgREST caps a response at 1000
// rows SILENTLY, and an issue that has run for a year is exactly the shape that
// starts losing its oldest updates without an error.

import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  MEETING_DISCUSSION_APPEARANCE_COLUMNS, MEETING_DISCUSSION_EVENT_COLUMNS,
  MEETING_DISCUSSION_ITEM_COLUMNS,
  type MeetingDiscussionAppearance, type MeetingDiscussionEvent, type MeetingDiscussionItem,
} from './discussion'
import { MEETING_EVIDENCE_COLUMNS, type MeetingOrderEvidence } from './types'

/**
 * The app's browser client, as useMeetings() provides it — the same alias
 * OrderDiscussion.tsx uses. A runtime-built column list cannot be checked against
 * the generic SupabaseClient's select parser, so these reads never take that type.
 */
type MeetingsClient = ReturnType<typeof createClient>

export type DiscussionMeetingRef = {
  id: string
  title: string
  meeting_date: string
  created_at: string
}

export type MeetingDiscussionData = {
  /** This meeting's agenda, in whatever order the database returned. */
  appearances: MeetingDiscussionAppearance[]
  items: MeetingDiscussionItem[]
  /** Every appearance of these issues, in every meeting the reader can see. */
  allAppearances: MeetingDiscussionAppearance[]
  /** The meetings those appearances sit in. */
  meetings: DiscussionMeetingRef[]
  events: MeetingDiscussionEvent[]
  evidence: MeetingOrderEvidence[]
}

const EMPTY: MeetingDiscussionData = {
  appearances: [], items: [], allAppearances: [], meetings: [], events: [], evidence: [],
}

/** Null on any failure, so a screen shows "could not load" rather than "none". */
export async function fetchMeetingDiscussion(
  supabase: MeetingsClient,
  meetingId: string,
): Promise<MeetingDiscussionData | null> {
  const agenda = await fetchAllRows<MeetingDiscussionAppearance>((from, to) =>
    supabase
      .from('meeting_discussion_appearances')
      .select(MEETING_DISCUSSION_APPEARANCE_COLUMNS)
      .eq('meeting_id', meetingId)
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!agenda.ok || agenda.truncated) {
    console.error('[meetings:discussion] agenda load failed', agenda)
    return null
  }
  if (agenda.rows.length === 0) return EMPTY

  const itemIds = [...new Set(agenda.rows.map(row => row.discussion_item_id))]

  const [items, allAppearances] = await Promise.all([
    fetchAllRows<MeetingDiscussionItem & { creator?: { full_name: string } | null; resolver?: { full_name: string } | null }>((from, to) =>
      supabase
        .from('meeting_discussion_items')
        .select(`${MEETING_DISCUSSION_ITEM_COLUMNS}, creator:users!created_by(full_name), resolver:users!resolved_by(full_name)`)
        .in('id', itemIds)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<MeetingDiscussionAppearance>((from, to) =>
      supabase
        .from('meeting_discussion_appearances')
        .select(MEETING_DISCUSSION_APPEARANCE_COLUMNS)
        .in('discussion_item_id', itemIds)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])
  if (!items.ok || items.truncated || !allAppearances.ok || allAppearances.truncated) {
    console.error('[meetings:discussion] item load failed', { items, allAppearances })
    return null
  }

  const meetingIds     = [...new Set(allAppearances.rows.map(row => row.meeting_id))]
  const appearanceIds  = allAppearances.rows.map(row => row.id)

  const [meetings, events, evidence] = await Promise.all([
    fetchAllRows<DiscussionMeetingRef>((from, to) =>
      supabase
        .from('meetings')
        .select('id, title, meeting_date, created_at')
        .in('id', meetingIds)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<MeetingDiscussionEvent & { actor?: { full_name: string } | null }>((from, to) =>
      supabase
        .from('meeting_discussion_events')
        .select(`${MEETING_DISCUSSION_EVENT_COLUMNS}, actor:users!actor_id(full_name)`)
        .in('discussion_item_id', itemIds)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<MeetingOrderEvidence & { uploader?: { full_name: string } | null }>((from, to) =>
      supabase
        .from('meeting_order_evidence')
        .select(`${MEETING_EVIDENCE_COLUMNS}, uploader:users!uploaded_by(full_name)`)
        .in('discussion_appearance_id', appearanceIds)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])
  if (!meetings.ok || meetings.truncated || !events.ok || events.truncated
      || !evidence.ok || evidence.truncated) {
    console.error('[meetings:discussion] thread load failed', { meetings, events, evidence })
    return null
  }

  return {
    appearances: agenda.rows,
    items: items.rows.map(({ creator, resolver, ...row }) => ({
      ...row,
      created_by_name: creator?.full_name ?? null,
      resolved_by_name: resolver?.full_name ?? null,
    })),
    allAppearances: allAppearances.rows,
    meetings: meetings.rows,
    events: events.rows.map(({ actor, ...row }) => ({ ...row, actor_name: actor?.full_name ?? null })),
    evidence: evidence.rows.map(({ uploader, ...row }) => ({ ...row, uploader_name: uploader?.full_name ?? null })),
  }
}

/**
 * The Meeting Inbox: OPEN issues with no appearance on ANY meeting.
 *
 * There is no inbox table, and that is the design. An issue waiting for a meeting
 * is simply an issue no meeting has yet claimed, so nothing can be lost from the
 * Inbox, nothing has to be swept out of it, and the source task link cannot be
 * dropped on the way.
 *
 * DECIDED BY THE DATABASE, NOT HERE. A browser only receives the appearances on
 * meetings it may open, so "open issues minus the appearances I can see" would
 * list an issue that sits on somebody else's agenda as waiting — and invite a
 * second placement. list_meeting_discussion_inbox() tests for an appearance
 * anywhere, with RLS bypassed for that test only, and returns just the issues this
 * reader may see. Automatic carry-forward reads the same condition inside the
 * transaction that creates a meeting.
 *
 * Null on any failure, so the screen says "could not load" rather than "empty".
 */
export async function fetchMeetingInbox(
  supabase: MeetingsClient,
): Promise<MeetingDiscussionItem[] | null> {
  const inbox = await fetchAllRows<MeetingDiscussionItem>((from, to) =>
    supabase
      .rpc('list_meeting_discussion_inbox')
      .range(from, to),
  )
  if (!inbox.ok || inbox.truncated) {
    console.error('[meetings:inbox] load failed', inbox)
    return null
  }
  return inbox.rows
}
