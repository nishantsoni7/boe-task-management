'use client'

import type { KeyboardEvent } from 'react'
import { ArrowDown, ChevronRight } from 'lucide-react'
import type { Task } from '@/lib/types'
import { quotationWait, type WaitBand } from '@/lib/tasks/quotationWait'
import styles from './quotationRequests.module.css'

// The Dashboard's Quotation Requests rows, as a table (owner, 2026-11-11, option B):
// Lead, Sales person, Priority, Pending. Every fact has its own column, so how long a
// request has waited, how important it is and who raised it can be read down the page.
// The Dashboard already sorts the rows (longest pending first, then priority); this
// only draws them. Under 520px of card width the row folds to two lines (phones).

const MAX_ROWS = 8

const PRIORITY: Record<string, { label: string; bars: 1 | 2 | 3; cls: string }> = {
  high:   { label: 'High',   bars: 3, cls: styles.priHigh },
  medium: { label: 'Medium', bars: 2, cls: styles.priMedium },
  low:    { label: 'Low',    bars: 1, cls: styles.priLow },
}

const WAIT_CLASS: Record<WaitBand, string> = {
  fresh: styles.waitFresh,
  aging: styles.waitAging,
  late:  styles.waitLate,
}

// A person keeps one colour, so a sales person's requests are easy to find in a column.
const AVATAR_CLASSES = [styles.av0, styles.av1, styles.av2, styles.av3]
export function avatarClass(personId: string): string {
  let sum = 0
  for (let i = 0; i < personId.length; i++) sum += personId.charCodeAt(i)
  return AVATAR_CLASSES[sum % AVATAR_CLASSES.length]
}

/** "Shravi" -> "SH", "Dinesh Reddy" -> "DR". */
export function avatarLetters(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]
  return letters.toUpperCase()
}

/** Three bars; the filled ones are the level, so priority reads without colour. */
function PriorityBars({ level }: { level: 1 | 2 | 3 }) {
  const bar = (x: number, y: number, h: number, n: number) => (
    <rect key={n} x={x} y={y} width="3.4" height={h} rx="1" fill="currentColor" opacity={n <= level ? 1 : 0.28} />
  )
  return (
    <svg width="13" height="12" viewBox="0 0 14 12" aria-hidden="true" focusable="false">
      {bar(0, 7, 5, 1)}{bar(5.3, 3.5, 8.5, 2)}{bar(10.6, 0, 12, 3)}
    </svg>
  )
}

export function QuotationRequestsList({
  tasks,
  userMap,
  onOpen,
  now,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  onOpen: (task: Task) => void
  /** Epoch ms. The page owns the clock, so a render never reads one itself. */
  now: number
}) {
  return (
    <div className={styles.list}>
      <div className={styles.cols} aria-hidden="true">
        <span>Lead</span>
        <span>Sales person</span>
        <span>Priority</span>
        <span className={styles.sorted}>Pending <ArrowDown size={11} strokeWidth={2.4} /></span>
        <span />
      </div>

      {tasks.slice(0, MAX_ROWS).map(task => {
        const lead = task.customer_name ?? task.title
        const person = userMap[task.created_by]
        const priority = task.priority ? PRIORITY[task.priority.toLowerCase()] : undefined
        const wait = quotationWait(task.created_at, now)
        const raised = new Date(task.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

        const open = () => onOpen(task)
        const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            open()
          }
        }

        // The row is one button, so a screen reader hears the whole row as a sentence.
        const spoken = [
          lead,
          person ? `raised by ${person}` : null,
          priority ? `${priority.label} priority` : null,
          wait ? `pending ${wait.label.toLowerCase()}` : null,
        ].filter(Boolean).join(', ')

        return (
          <div
            key={task.id}
            className={styles.row}
            role="button"
            tabIndex={0}
            aria-label={spoken}
            title={`Raised ${raised}`}
            onClick={open}
            onKeyDown={onKeyDown}
          >
            <div className={styles.lead}>{lead}</div>

            <div className={styles.by}>
              {person ? (
                <>
                  <span className={`${styles.av} ${avatarClass(task.created_by)}`} aria-hidden="true">{avatarLetters(person)}</span>
                  <span className={styles.byName}>{person}</span>
                </>
              ) : (
                <span className={styles.none}>—</span>
              )}
            </div>

            <div className={styles.pri}>
              {priority ? (
                <span className={`${styles.chip} ${priority.cls}`}>
                  <PriorityBars level={priority.bars} />
                  {priority.label}
                </span>
              ) : (
                <span className={styles.none}>—</span>
              )}
            </div>

            <div className={`${styles.wait} ${wait ? WAIT_CLASS[wait.band] : ''}`}>
              {wait ? (
                <>
                  <b><span className={styles.pendingWord}>Pending </span>{wait.label}</b>
                  <span className={styles.meter} aria-hidden="true"><i style={{ width: `${Math.round(wait.fill * 100)}%` }} /></span>
                </>
              ) : (
                <span className={styles.none}>—</span>
              )}
            </div>

            <span className={styles.chev} aria-hidden="true"><ChevronRight size={14} /></span>
          </div>
        )
      })}
    </div>
  )
}
