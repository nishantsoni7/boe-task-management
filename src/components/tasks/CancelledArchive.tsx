'use client'

/**
 * The look of the two cancelled-task archives (/tasks/cancelled and
 * /tasks/assigned-by-me/cancelled), kept in one place so they cannot drift.
 *
 * Presentation only. Each page still owns its read (paged, uniquely ordered),
 * its filters, its load-error banner and its empty-state branch: those are
 * pinned per page by src/app/tasks/archiveListBounds.test.ts.
 */

import React, { useState } from 'react'
import { ChevronRight, Ban, Search, Star } from 'lucide-react'
import type { Task } from '@/lib/types'
import { colors } from '@/lib/tokens'

const PRIORITY: Record<string, { label: string; dot: string }> = {
  high:   { label: 'High', dot: '#A12438'    },
  medium: { label: 'Med',  dot: '#805B0D'    },
  low:    { label: 'Low',  dot: colors.muted },
}

export type ArchivePerson = {
  label: string
  /** 'self' = you assigned it to yourself; 'other' = a colleague assigned it; 'assignee' = the person you delegated to. */
  tone: 'self' | 'other' | 'assignee'
  title: string
}

const PERSON_TONE: Record<ArchivePerson['tone'], { color: string; background: string }> = {
  self:     { color: colors.secondary, background: '#EEECE8'        },
  other:    { color: colors.blue,      background: colors.blueTint  },
  assignee: { color: colors.green,     background: colors.greenTint },
}

const FIELD_HEIGHT = 40

// ─── Heading, note, toolbar ───────────────────────────────────────────────────
export function ArchiveHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, color: colors.primary, letterSpacing: '-0.02em', lineHeight: 1.25 }}>{title}</div>
      <div style={{ fontSize: '13px', color: colors.muted, marginTop: '2px' }}>{subtitle}</div>
    </div>
  )
}

export function ArchiveNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '10px',
      background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '10px',
      padding: '10px 14px', marginBottom: '12px', fontSize: '13px', lineHeight: 1.5, color: colors.secondary,
    }}>
      <Ban size={15} color={colors.muted} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

export function ArchiveToolbar({ searchInput, onSearch, onSearchBlur, children }: {
  searchInput: string
  onSearch: (value: string) => void
  onSearchBlur: () => void
  children: React.ReactNode
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
      <label style={{
        flex: 1, minWidth: '200px', display: 'flex', alignItems: 'center', gap: '8px',
        minHeight: FIELD_HEIGHT, padding: '0 12px', background: colors.base, cursor: 'text',
        border: `1.5px solid ${focused ? colors.brand : colors.borderInput}`, borderRadius: '10px',
        boxShadow: focused ? `0 0 0 3px ${colors.brandTint}` : 'none',
      }}>
        <Search size={15} color={colors.muted} style={{ flexShrink: 0 }} aria-hidden="true" />
        <input
          type="text"
          placeholder="Search by task name or reason"
          aria-label="Search cancelled tasks"
          value={searchInput}
          onChange={e => onSearch(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); onSearchBlur() }}
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: '13px', color: colors.primary }}
        />
      </label>
      {children}
    </div>
  )
}

export function ArchiveSelect({ value, onChange, label, children }: {
  value: string
  onChange: (value: string) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={e => onChange(e.target.value)}
      style={{
        minHeight: FIELD_HEIGHT, minWidth: '140px', padding: '0 12px', background: colors.base,
        border: `1.5px solid ${colors.borderInput}`, borderRadius: '10px', fontSize: '13px',
        color: value ? colors.primary : colors.secondary, cursor: 'pointer',
      }}
    >
      {children}
    </select>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
export function ArchiveEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', gap: '6px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '12px' }}>
      <span style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#E4DED7', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '4px' }}>
        <Ban size={16} color={colors.muted} aria-hidden="true" />
      </span>
      <span style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>{title}</span>
      <span style={{ fontSize: '13px', color: colors.muted }}>{hint}</span>
    </div>
  )
}

// ─── List ─────────────────────────────────────────────────────────────────────
const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
const MONTH_FORMAT: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' }

function cancelledOn(task: Task): Date | null {
  const raw = task.cancelled_at ?? task.last_update_at
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Tasks arrive newest-first; consecutive ones in the same month share a heading. */
function groupByMonth(tasks: Task[]): { label: string; tasks: Task[] }[] {
  const groups: { label: string; tasks: Task[] }[] = []
  for (const task of tasks) {
    const d = cancelledOn(task)
    const label = d ? d.toLocaleDateString('en-IN', MONTH_FORMAT) : 'Date unknown'
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.tasks.push(task)
    else groups.push({ label, tasks: [task] })
  }
  return groups
}

const COLUMNS = '22px minmax(0, 1fr) 132px 84px 112px 28px'

function ArchiveRow({ task, person, first, selected, isMobile, onOpen }: {
  task: Task
  person: ArchivePerson
  first: boolean
  selected: boolean
  isMobile: boolean
  onOpen: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [ringed,  setRinged]  = useState(false)

  const priority = PRIORITY[task.priority] ?? PRIORITY.low
  const d        = cancelledOn(task)
  const dateText = d ? d.toLocaleDateString('en-IN', DATE_FORMAT) : 'Unknown'
  const tone     = PERSON_TONE[person.tone]

  const personChip = (
    <span title={person.title} style={{
      display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize: '12px', fontWeight: 600, padding: '2px 10px', borderRadius: '99px', color: tone.color, background: tone.background,
    }}>{person.label}</span>
  )
  const priorityCell = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 600, color: colors.secondary }}>
      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: priority.dot }} aria-hidden="true" />
      {priority.label}
    </span>
  )
  const dateCell = (
    <span style={{ fontSize: '12.5px', color: colors.secondary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{dateText}</span>
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${task.title}`}
      aria-pressed={selected}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={e => setRinged(e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setRinged(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '18px minmax(0, 1fr) 28px' : COLUMNS,
        alignItems: 'center', columnGap: '12px', rowGap: '6px',
        padding: isMobile ? '12px' : '12px 14px', minHeight: '64px', cursor: 'pointer',
        background: selected ? colors.brandTint : hovered ? colors.raised : 'transparent',
        borderTop: first ? 'none' : `1px solid ${colors.border}`,
        outline: ringed ? `2px solid ${colors.brand}` : 'none', outlineOffset: '-2px',
        transition: 'background 0.12s',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center' }}>
        {task.is_urgent && <Star size={13} fill="#B7892A" color="#B7892A" aria-label="Urgent" />}
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: '14px', fontWeight: 600, color: colors.primary, letterSpacing: '-0.01em',
          ...(isMobile ? {} : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
        }}>{task.title}</div>
        {task.cancellation_reason && (
          <div style={{ fontSize: '12.5px', color: colors.muted, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: colors.secondary, fontWeight: 500 }}>Reason:</span> {task.cancellation_reason}
          </div>
        )}
      </div>

      {isMobile ? (
        <>
          <span style={{ display: 'flex', justifyContent: 'center', color: colors.muted }}><ChevronRight size={16} aria-hidden="true" /></span>
          <div style={{ gridColumn: '2 / 3', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', minWidth: 0 }}>
            {personChip}{priorityCell}{dateCell}
          </div>
        </>
      ) : (
        <>
          <div style={{ minWidth: 0 }}>{personChip}</div>
          <div>{priorityCell}</div>
          <div>{dateCell}</div>
          <span style={{ display: 'flex', justifyContent: 'center', color: hovered ? colors.primary : colors.muted }}><ChevronRight size={16} aria-hidden="true" /></span>
        </>
      )}
    </div>
  )
}

export function ArchiveList({ tasks, selectedId, personHeader, personFor, isMobile, onOpen }: {
  tasks: Task[]
  selectedId: string | null
  /** Column title for the person each task is tied to, e.g. "Assigned by". */
  personHeader: string
  personFor: (task: Task) => ArchivePerson
  isMobile: boolean
  onOpen: (task: Task) => void
}) {
  const groups = groupByMonth(tasks)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {groups.map(group => (
        <section key={group.label} aria-label={group.label}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '0 2px 8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.muted }}>{group.label}</span>
            <span style={{ fontSize: '12px', color: colors.muted }}>· {group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''}</span>
            <span style={{ flex: 1, height: '1px', background: colors.border }} />
          </div>
          <div style={{ background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '12px', overflow: 'hidden' }}>
            {!isMobile && (
              <div style={{
                display: 'grid', gridTemplateColumns: COLUMNS, columnGap: '12px', padding: '8px 14px',
                background: colors.raised, borderBottom: `1px solid ${colors.border}`,
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.muted,
              }}>
                <span /><span>Task</span><span>{personHeader}</span><span>Priority</span><span>Cancelled</span><span />
              </div>
            )}
            {group.tasks.map((task, i) => (
              <ArchiveRow
                key={task.id}
                task={task}
                person={personFor(task)}
                first={i === 0 && isMobile}
                selected={task.id === selectedId}
                isMobile={isMobile}
                onOpen={() => onOpen(task)}
              />
            ))}
          </div>
        </section>
      ))}
      <div style={{ fontSize: '13px', color: colors.muted, padding: '0 2px' }}>
        {tasks.length} task{tasks.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}
