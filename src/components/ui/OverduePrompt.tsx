'use client'

import { useState } from 'react'
import type { Task } from '@/lib/types'
import { formatShortDate } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'

// ─── Types ────────────────────────────────────────────────────────────────────

export type OverdueAction =
  | { type: 'continue';  note: string }
  | { type: 'blocked';   reason: string }
  | { type: 'waiting';   reason: string }
  | { type: 'completed' }

type ActionChoice = 'continue' | 'blocked' | 'waiting' | 'completed' | null

// ─── OverduePrompt ────────────────────────────────────────────────────────────
// Pure UI — no Supabase. Dashboard owns all DB writes.
//
// tasks      — pending overdue tasks (shrinks as user resolves each one)
// currentIdx — always 0; kept as prop so counter label works
// saving     — true while parent is writing to DB
// onAction   — called with the task + chosen action

type OverduePromptProps = {
  tasks:      Task[]
  currentIdx: number
  saving:     boolean
  onAction:   (task: Task, action: OverdueAction) => void
}

export function OverduePrompt({
  tasks,
  currentIdx,
  saving,
  onAction,
}: OverduePromptProps) {
  const [choice,     setChoice]     = useState<ActionChoice>(null)
  const [noteText,   setNoteText]   = useState('')
  const [reasonText, setReasonText] = useState('')

  const task  = tasks[currentIdx]
  const total = tasks.length

  // key={task.id} on the parent resets this state when task changes
  if (!task) return null

  const canSubmit = (() => {
    if (saving)  return false
    if (!choice) return false
    if (choice === 'blocked' || choice === 'waiting') {
      return reasonText.trim().length > 0
    }
    return true
  })()

  const handleSubmit = () => {
    if (!choice || !canSubmit) return
    if (choice === 'continue') {
      onAction(task, { type: 'continue', note: noteText.trim() })
    } else if (choice === 'blocked') {
      onAction(task, { type: 'blocked', reason: reasonText.trim() })
    } else if (choice === 'waiting') {
      onAction(task, { type: 'waiting', reason: reasonText.trim() })
    } else if (choice === 'completed') {
      onAction(task, { type: 'completed' })
    }
  }

  const ACTION_DEFS = [
    {
      key:   'continue'  as const,
      icon:  '▶',
      label: 'Continue Working',
      hint:  'Still in progress — add an optional note',
    },
    {
      key:   'blocked'   as const,
      icon:  '⛔',
      label: 'Mark Blocked',
      hint:  'Something is stopping this task',
    },
    {
      key:   'waiting'   as const,
      icon:  '⏳',
      label: 'Mark Waiting',
      hint:  'Waiting on someone external',
    },
    {
      key:   'completed' as const,
      icon:  '✓',
      label: 'Mark Completed',
      hint:  'This task is done',
    },
  ]

  return (
    <div className="boe-modal-overlay">
      <div className="boe-modal-sheet">

        {/* Header */}
        <div className="boe-modal-header">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}>
            <span
              className="boe-modal-counter"
              style={{
                color: colors.red,
                background: 'rgba(217,79,79,0.08)',
                padding: '2px 7px',
                borderRadius: '3px',
                border: '1px solid rgba(217,79,79,0.15)',
              }}
            >
              Overdue · {currentIdx + 1} of {total}
            </span>
            <span style={{
              fontSize: '10px',
              fontFamily: font.mono,
              color: colors.muted,
            }}>
              Action required
            </span>
          </div>

          <p style={{
            color: colors.primary,
            fontSize: '14px',
            fontWeight: 600,
            lineHeight: 1.4,
            marginBottom: '6px',
          }}>
            {task.title}
          </p>

          <div style={{
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}>
            {task.due_date && (
              <span style={{
                fontSize: '10px',
                fontFamily: font.mono,
                color: colors.red,
                background: 'rgba(217,79,79,0.07)',
                padding: '2px 6px',
                borderRadius: '3px',
              }}>
                Due {formatShortDate(task.due_date)}
              </span>
            )}
            <span style={{
              fontSize: '10px',
              color: colors.tertiary,
              fontFamily: font.mono,
              textTransform: 'capitalize',
            }}>
              {task.priority} priority · {task.status}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="boe-modal-body">

          <p style={{ fontSize: '12px', color: colors.secondary }}>
            This task is overdue. Choose what to do before continuing.
          </p>

          {/* Action choice buttons */}
          {ACTION_DEFS.map(a => (
            <button
              key={a.key}
              className={`boe-modal-action${choice === a.key ? ' selected' : ''}`}
              onClick={() => {
                setChoice(a.key)
                setNoteText('')
                setReasonText('')
              }}
            >
              <span className="boe-modal-action-icon">{a.icon}</span>
              <span>
                <span className="boe-modal-action-label">{a.label}</span>
                <span className="boe-modal-action-hint">{a.hint}</span>
              </span>
            </button>
          ))}

          {/* Continue Working — optional note */}
          {choice === 'continue' && (
            <div>
              <label className="boe-input-label">
                Progress note (optional)
              </label>
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="e.g. Awaiting revised quote from client, following up tomorrow"
                rows={2}
                className="boe-input"
                style={{ resize: 'none' }}
                autoFocus
              />
            </div>
          )}

          {/* Mark Blocked — required reason */}
          {choice === 'blocked' && (
            <div>
              <label className="boe-input-label">
                Who or what is blocking this? *
              </label>
              <textarea
                value={reasonText}
                onChange={e => setReasonText(e.target.value)}
                placeholder="e.g. Waiting for client to confirm fabric selection"
                rows={2}
                className="boe-input"
                style={{ resize: 'none' }}
                autoFocus
              />
              {reasonText.trim().length === 0 && (
                <p style={{ fontSize: '11px', color: colors.amber, marginTop: '4px' }}>
                  Required — who or what is blocking this task?
                </p>
              )}
            </div>
          )}

          {/* Mark Waiting — required reason */}
          {choice === 'waiting' && (
            <div>
              <label className="boe-input-label">
                What are you waiting on? *
              </label>
              <textarea
                value={reasonText}
                onChange={e => setReasonText(e.target.value)}
                placeholder="e.g. Waiting for factory dispatch confirmation"
                rows={2}
                className="boe-input"
                style={{ resize: 'none' }}
                autoFocus
              />
              {reasonText.trim().length === 0 && (
                <p style={{ fontSize: '11px', color: colors.amber, marginTop: '4px' }}>
                  Required — what are you waiting on?
                </p>
              )}
            </div>
          )}

          {/* Submit — only appears after a choice is made */}
          {choice && (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="boe-btn boe-btn-primary"
              style={{
                width: '100%',
                justifyContent: 'center',
                padding: '13px',
                fontSize: '13px',
                marginTop: '4px',
              }}
            >
              {saving
                ? 'Saving...'
                : total > 1
                ? 'Save & Next →'
                : 'Save & Continue'}
            </button>
          )}

          <div style={{ height: '8px' }} />

        </div>
      </div>
    </div>
  )
}