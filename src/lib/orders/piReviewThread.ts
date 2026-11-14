// THE PI REVIEW THREAD (owner, 2026-11-14): every hop of the loop between Operations, the approver and Sales,
// in order, with the round it belongs to, so nothing in the back and forth is missed or has to be pieced
// together from the Order's long history.
//
// Pure: it reads the Order history the page already holds (order_activity_log rows) and writes nothing. The
// events are the ones the database writes at each hop (20261229000000, 20270422000000, 20270619000000,
// 20270718000000). A ROUND starts when Operations flags a version (or withdraws an acceptance); a version's
// first review is round 0 and everything before its first flag belongs to it.

import type { OperationsHandoffTone } from './operationsHandoff'

type HistoryRow = { event_type: string; payload: Record<string, unknown>; created_at: string; actor_name?: string }

export type ThreadKind = 'sent_for_review' | 'flagged' | 'withdrawn' | 'sent_to_sales' | 'reply' | 'passed_to_operations' | 'accepted'

export type ThreadEntry = {
  key: string
  atIso: string
  versionNumber: number | null
  /** 0 before the version's first flag; 1 from the first flag; and so on. */
  round: number
  kind: ThreadKind
  tone: OperationsHandoffTone
  /** Who did it, as the history names them. */
  actor: string | null
  /** One line: who did what. */
  title: string
  /** What they wrote (Operations' reason, the approver's comment, the reply, the note). */
  text: string | null
}

const KIND_OF: Record<string, ThreadKind> = {
  operations_handoff_recorded: 'sent_for_review',
  operations_handoff_clarification_needed: 'flagged',
  operations_handoff_acceptance_withdrawn: 'withdrawn',
  operations_handoff_sent_to_sales: 'sent_to_sales',
  operations_handoff_clarification_answered: 'reply',
  operations_handoff_returned_to_operations: 'passed_to_operations',
  operations_handoff_accepted: 'accepted',
}

const TONE_OF: Record<ThreadKind, OperationsHandoffTone> = {
  sent_for_review: 'neutral', flagged: 'red', withdrawn: 'red', sent_to_sales: 'amber',
  reply: 'amber', passed_to_operations: 'amber', accepted: 'green',
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function describe(kind: ThreadKind, actor: string | null, v: string, p: Record<string, unknown>): { title: string; text: string | null } {
  switch (kind) {
    case 'sent_for_review': return { title: `${v} sent to Operations for review`, text: null }
    case 'flagged': return { title: `${actor ?? 'Operations'} cannot accept ${v}`, text: str(p.reason) }
    case 'withdrawn': return { title: `${actor ?? 'Operations'} withdrew the acceptance of ${v}`, text: str(p.reason) }
    case 'sent_to_sales': return { title: `${actor ?? 'The approver'} sent ${v} to the salesperson`, text: str(p.comment) }
    case 'reply': return { title: `${actor ?? 'The salesperson'} replied to the approver: PI unchanged`, text: str(p.response) }
    case 'passed_to_operations':
      return { title: `${actor ?? 'The approver'} passed ${v} to Operations${p.reply_forwarded === true ? ' with the reply' : ''}`, text: str(p.note) }
    case 'accepted': return { title: `${actor ?? 'Operations'} accepted ${v} for production`, text: str(p.note) }
  }
}

/** The loop as a list, oldest first. Entries of events this thread does not draw are left out. */
export function buildReviewThread(history: readonly HistoryRow[]): { entries: ThreadEntry[]; rounds: number } {
  const rows = history
    .map((e, i) => ({ e, i, kind: KIND_OF[e.event_type] }))
    .filter((x): x is { e: HistoryRow; i: number; kind: ThreadKind } => !!x.kind)
    .sort((a, b) => Date.parse(a.e.created_at) - Date.parse(b.e.created_at) || a.i - b.i)
  const roundOf = new Map<string, number>()
  let rounds = 0
  const entries = rows.map(({ e, i, kind }): ThreadEntry => {
    const handoff = typeof e.payload?.handoff_id === 'string' ? e.payload.handoff_id : `row-${i}`
    if (kind === 'flagged' || kind === 'withdrawn') roundOf.set(handoff, (roundOf.get(handoff) ?? 0) + 1)
    const round = roundOf.get(handoff) ?? 0
    rounds = Math.max(rounds, round)
    const version = typeof e.payload?.version_number === 'number' ? e.payload.version_number : null
    const actor = e.actor_name?.trim() || null
    const { title, text } = describe(kind, actor, version === null ? 'the PI' : `PI V${version}`, e.payload ?? {})
    return { key: `${e.event_type}-${e.created_at}-${i}`, atIso: e.created_at, versionNumber: version, round, kind, tone: TONE_OF[kind], actor, title, text }
  })
  return { entries, rounds }
}
