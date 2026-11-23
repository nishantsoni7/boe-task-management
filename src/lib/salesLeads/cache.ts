import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query'
import { SALES_KEY, type BoardFilter, type BoardPage, type MyDay, type WorkDetail, type WorkLead } from './api'
import type { Stage } from './board'

// What a saved action does to the screens that are already showing (2026-11-23, page speed). Every action the database accepts
// answers with the lead as it is now, so My day, the board's columns and the open popup are corrected from that answer at once,
// and only what could have changed is read again: the totals, My day, the columns the lead was in or went to, and the popup.
// Before this, every action read EVERY mounted query again (each column replaying all its pages one after another), and the screen
// caught up a second or two after the toast. A failed action still reads everything again (useLeadWork.guarded): after a refusal
// nobody knows what the screen should say.

/** A lead the database has just answered for, and the stage it was in before the action (null when that is not known: an undo). */
export type Written = { lead: WorkLead; from: Stage | null }

const CLOSED: readonly Stage[] = ['converted', 'dead']

/**
 * Does the lead no longer belong on My day? Only says yes when it is sure. The database keeps a lead there when it is due, or when
 * nobody has tried it and it did not come from ClickUp (a fact this screen does not hold), so a lead this cannot judge stays and the
 * read that follows corrects it.
 */
export function leavesMyDay(lead: WorkLead, today: string): boolean {
  if (CLOSED.includes(lead.stage)) return true
  return !!lead.next_due_on && lead.next_due_on > today && (lead.stage === 'follow_up_later' || !!lead.first_attempt_at)
}

/** My day after a lead changed: the row is replaced in place, or taken off the list when the lead no longer belongs on it. */
export function patchMyDay(day: MyDay, lead: WorkLead, today: string): MyDay {
  const at = day.rows.findIndex(r => r.id === lead.id)
  if (at < 0) return day
  if (leavesMyDay(lead, today)) return { ...day, rows: day.rows.filter(r => r.id !== lead.id) }
  const rows = day.rows.slice()
  rows[at] = lead
  return { ...day, rows }
}

/** Would the lead be in a column that was read with this filter? A search is judged by the database, so it never says yes. */
export function matchesFilter(lead: WorkLead, f: BoardFilter): boolean {
  if (f.q) return false
  return (!f.holder || lead.assigned_to === f.holder)
    && (!f.market || lead.market === f.market)
    && (!f.segment || lead.segment === f.segment)
    && (!f.temperature || lead.temperature === f.temperature)
    && (!f.source || lead.source === f.source)
}

/**
 * One column after a lead changed. In the lead's own column the card is replaced where it stands (its place is corrected by the
 * read that follows); in another column it is taken out; and when the lead MOVED into this column (`from` differs) and the filter
 * would show it, it appears at the top. Every page carries the column's count, so each is kept in step. The same object comes back
 * when nothing here changed.
 */
export function patchColumn(data: InfiniteData<BoardPage, number>, stage: Stage, lead: WorkLead, from: Stage | null, filter: BoardFilter): InfiniteData<BoardPage, number> {
  let page = -1
  let row = -1
  data.pages.forEach((p, i) => {
    if (page >= 0) return
    const at = p.rows.findIndex(r => r.id === lead.id)
    if (at >= 0) { page = i; row = at }
  })
  const found = page >= 0

  if (lead.stage === stage) {
    if (found) {
      return { ...data, pages: data.pages.map((p, i) => (i === page ? { ...p, rows: p.rows.map((r, j) => (j === row ? lead : r)) } : p)) }
    }
    if (from !== stage && data.pages.length > 0 && matchesFilter(lead, filter)) {
      return { ...data, pages: data.pages.map((p, i) => ({ ...p, n: p.n + 1, rows: i === 0 ? [lead, ...p.rows] : p.rows })) }
    }
    return data
  }
  if (!found) return data
  return { ...data, pages: data.pages.map((p, i) => ({ ...p, n: Math.max(0, p.n - 1), rows: i === page ? p.rows.filter((_, j) => j !== row) : p.rows })) }
}

/** Put the answers into every cached screen. Returns the stages whose columns changed, so those can be read again. */
export function applyWritten(qc: QueryClient, written: readonly Written[], today: string): Set<Stage> {
  const touched = new Set<Stage>()
  for (const { lead, from } of written) {
    qc.setQueryData<MyDay>([SALES_KEY, 'my-day'], d => (d ? patchMyDay(d, lead, today) : d))
    for (const [key, data] of qc.getQueriesData<InfiniteData<BoardPage, number>>({ queryKey: [SALES_KEY, 'board', 'column'] })) {
      if (!data) continue
      const next = patchColumn(data, key[3] as Stage, lead, from, key[4] as BoardFilter)
      if (next !== data) { qc.setQueryData(key, next); touched.add(key[3] as Stage) }
    }
    qc.setQueryData<WorkDetail>([SALES_KEY, 'work', lead.id], d => (d ? { ...d, lead } : d))
  }
  return touched
}

/**
 * After an action the database accepted: show the answer, mark everything else as old (it is read when next opened), and read
 * again only what may have changed and is on screen: My day, the board's totals, the columns that changed, and the open popup.
 */
export function settleWritten(qc: QueryClient, written: readonly Written[], today: string): void {
  const touched = applyWritten(qc, written, today)
  void qc.invalidateQueries({ queryKey: [SALES_KEY], refetchType: 'none' })
  void qc.refetchQueries({ queryKey: [SALES_KEY], predicate: (q: Query) => readAgain(q.queryKey, touched, written) })
}

/** Which queries are read again after an action: see settleWritten. */
export function readAgain(key: readonly unknown[], touched: ReadonlySet<Stage>, written: readonly Written[]): boolean {
  if (key[1] === 'my-day') return true
  // The board's totals have the filter at [2]; a column has 'column' there and its stage at [3].
  if (key[1] === 'board') return key[2] === 'column' ? touched.has(key[3] as Stage) : true
  if (key[1] === 'work') return written.some(w => w.lead.id === key[2])
  return false
}
