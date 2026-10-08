import {
  BUYING_TIMELINES, CLIENT_TYPES, FOLLOW_UP_FILTERS, LEAD_TYPES, REQUIREMENTS, STATUSES,
  optionValues,
} from './constants'
import {
  dateParam, enumListParam, enumParam, idParam, pageParam, textParam,
  type ListState, type ParamCodec,
} from '@/lib/listState'

// The list's filters, as URL state (shareable, restorable with Back) and as the
// single jsonb argument the database takes. Categories combine with AND, the
// values inside one category with OR — that rule lives in the SQL function
// exhibition_leads_filtered(); this file only says what is being asked.

export const PAGE_SIZE = 25

export const DATE_MODES = ['today', 'date', 'range', 'all'] as const
export type DateMode = (typeof DATE_MODES)[number]

export const ARCHIVE_MODES = ['active', 'archived', 'all'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A list of UUIDs, comma separated. Anything not UUID-shaped is dropped. */
export function uuidListParam(): ParamCodec<string[]> {
  const clean = (values: readonly string[]) =>
    Array.from(new Set(values.map(v => v.trim().toLowerCase()).filter(v => UUID_RE.test(v))))
  return {
    parse: raw => (raw === null ? [] : clean(raw.split(','))),
    serialize: value => (clean(value).length ? clean(value).join(',') : null),
  }
}

/** An exhibition id, or the word "all" (leads across every exhibition). */
export function exParam(): ParamCodec<string> {
  return {
    parse: raw => (raw === 'all' ? 'all' : raw !== null && UUID_RE.test(raw) ? raw.toLowerCase() : ''),
    serialize: value => (value === 'all' ? 'all' : UUID_RE.test(value) ? value.toLowerCase() : null),
  }
}

/** Free-text values (cities). '|' separates, so a comma inside a name survives. */
export function textListParam(): ParamCodec<string[]> {
  const clean = (values: readonly string[]) =>
    Array.from(new Set(values.map(v => v.trim()).filter(Boolean))).slice(0, 20)
  return {
    parse: raw => (raw === null ? [] : clean(raw.split('|'))),
    serialize: value => (clean(value).length ? clean(value).join('|') : null),
  }
}

function listParams(defaultWhen: DateMode) {
  return {
    ex: exParam(),
    lead: idParam(),
    when: enumParam(DATE_MODES, defaultWhen),
    day: dateParam(),
    from: dateParam(),
    to: dateParam(),
    q: textParam(),
    type: enumListParam(optionValues(CLIENT_TYPES)),
    req: enumListParam(optionValues(REQUIREMENTS)),
    city: textListParam(),
    timeline: enumListParam(optionValues(BUYING_TIMELINES)),
    ltype: enumListParam(optionValues(LEAD_TYPES)),
    status: enumListParam(optionValues(STATUSES)),
    follow: enumListParam(optionValues(FOLLOW_UP_FILTERS)),
    collector: uuidListParam(),
    owner: uuidListParam(),
    archived: enumParam(ARCHIVE_MODES, 'active'),
    page: pageParam(),
  }
}

// Module-scope: useListUrlState needs a stable codec map. My Leads opens on
// Today; the Admin list opens on the whole exhibition.
export const MY_LIST_PARAMS = listParams('today')
export const ALL_LIST_PARAMS = listParams('all')

export type ListFilterState = ListState<typeof MY_LIST_PARAMS>

export type RpcFilter = {
  scope: 'mine' | 'all'
  exhibition_id?: string
  date_from?: string
  date_to?: string
  search?: string
  client_types?: string[]
  requirements?: string[]
  cities?: string[]
  timelines?: string[]
  lead_types?: string[]
  statuses?: string[]
  follow_ups?: string[]
  collector_ids?: string[]
  owner_ids?: string[]
  archived?: 'active' | 'archived' | 'all'
}

/** The inclusive IST date window a list state selects, or null for "no limit". */
export function dateWindow(state: ListFilterState, today: string): { from: string; to: string } | null {
  switch (state.when) {
    case 'today': return { from: today, to: today }
    case 'date': return state.day ? { from: state.day, to: state.day } : { from: today, to: today }
    case 'range': {
      if (!state.from && !state.to) return null
      const from = state.from || state.to
      const to = state.to || state.from
      return from <= to ? { from, to } : { from: to, to: from }
    }
    case 'all': return null
  }
}

export function toRpcFilter(
  state: ListFilterState,
  ctx: { scope: 'mine' | 'all'; exhibitionId: string | null; today: string; isAdmin: boolean },
): RpcFilter {
  const f: RpcFilter = { scope: ctx.scope }
  if (ctx.exhibitionId) f.exhibition_id = ctx.exhibitionId
  const w = dateWindow(state, ctx.today)
  if (w) { f.date_from = w.from; f.date_to = w.to }
  if (state.q.trim()) f.search = state.q.trim()
  if (state.type.length) f.client_types = state.type
  if (state.req.length) f.requirements = state.req
  if (state.city.length) f.cities = state.city
  if (state.timeline.length) f.timelines = state.timeline
  if (state.ltype.length) f.lead_types = state.ltype
  if (state.status.length) f.statuses = state.status
  if (state.follow.length) f.follow_ups = state.follow
  // Admin-only filters. The database ignores them for anyone else too.
  if (ctx.isAdmin) {
    if (state.collector.length) f.collector_ids = state.collector
    if (state.owner.length) f.owner_ids = state.owner
    f.archived = state.archived
  }
  return f
}

/** How many filter categories (beyond the date window) are narrowing the list. */
export function activeFilterCount(state: ListFilterState, isAdmin: boolean): number {
  let n = 0
  if (state.q.trim()) n++
  for (const key of ['type', 'req', 'city', 'timeline', 'ltype', 'status', 'follow'] as const) {
    if (state[key].length) n++
  }
  if (isAdmin) {
    if (state.collector.length) n++
    if (state.owner.length) n++
    if (state.archived !== 'active') n++
  }
  return n
}

export const toggleIn = <T extends string>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter(v => v !== value) : [...list, value]
