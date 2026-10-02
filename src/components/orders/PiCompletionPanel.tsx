'use client'

// ── Complete PI details: one place to finish a PI, then submit it ────────────
//
// This replaces four separate prompts that used to sit in different cards (the
// readiness list in the workflow panel, the Internal order details card, the
// Client PO / Design Files box and the middleman warning in the summary). It is
// presentation only: every field is still saved by the editor and the RPC that
// already owns it, and every requirement it names is one the code and database
// already enforce (see piCompletion.ts). It decides nothing about authority —
// `canEdit` and `locked` come from the page's own answers and each RPC re-derives
// them.

import { ClipboardCheck, Lock, Pencil, Send, Upload } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { RequiredMark } from './PiFormParts'
import {
  type CompletionFact,
  type CompletionItem,
} from '@/lib/orders/piCompletion'

export const COMPLETION_TITLE = 'Complete PI details'
export const COMPLETION_LOCKED_TITLE = 'PI details'
export const COMPLETION_LOCKED_HINT = 'Locked while this PI is with management.'

/**
 * One read-out group (the client) with its single edit control.
 *
 * Each fact is a label and its value on one line — the label bold on the left,
 * the value regular beside it — so the values of a row start at the same place.
 * The first three facts share the top row and the addresses the second; the
 * grid answers to the section's own width (see .pi-client-facts in globals.css).
 */
export function PiCompletionFacts({ title, facts, editLabel, canEdit, locked, onEdit }: {
  title: string
  facts: readonly CompletionFact[]
  editLabel: string
  canEdit: boolean
  locked: boolean
  onEdit: () => void
}) {
  return (
    <section aria-label={title} className="pi-client-facts">
      <div className="pi-section-head">
        <h3 className="pi-section-title">{title}</h3>
        {(canEdit || locked) && (
          <button
            type="button"
            className="boe-btn boe-btn-ghost pi-section-action"
            style={locked ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
            disabled={locked}
            title={locked ? COMPLETION_LOCKED_HINT : undefined}
            onClick={onEdit}
            aria-haspopup="dialog"
          >
            <Pencil size={12} aria-hidden="true" /> {editLabel}
          </button>
        )}
      </div>
      <dl className="pi-client-facts-grid">
        {facts.map(fact => (
          <div key={fact.key} data-fact={fact.key} className="pi-client-fact">
            <dt>
              {fact.label}
              {fact.need === 'submission' && <RequiredMark />}
            </dt>
            <dd data-empty={fact.value ? undefined : 'true'} data-required={!fact.value && fact.need === 'submission' ? 'true' : undefined}>
              {fact.value ?? (fact.need === 'submission' ? 'Not added yet' : 'Not given')}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * THE AREA. Header first, then the grouped sections separated by thin rules, and
 * the action last — directly under the last field, which on a phone is where the
 * thumb already is.
 *
 * What stops Submit is said beside the Submit control, by name, and each name
 * takes the person to the editor that owns it. There is no banner and no
 * checklist: the fields themselves show what is missing.
 *
 * Locked: the same fields, legible and read-only, the editing controls muted and
 * disabled, and the submit/upload actions replaced by the one route back —
 * Request change.
 */
export function PiCompletionPanel({
  completion, locked, checklistDisabled, onFix, groups, submit, onChangePi, requestChange,
}: {
  completion: { requiredMissing: readonly CompletionItem[] }
  locked: boolean
  checklistDisabled: boolean
  onFix: ((item: CompletionItem) => void) | null
  /** The grouped fields: the facts, the supporting details and the internal order details. */
  groups: React.ReactNode
  /** The Submit control's state — omitted when the viewer cannot submit. */
  submit: { label: string; disabled: boolean; reason: string | null; issues: boolean; onSubmit: () => void } | null
  onChangePi: (() => void) | null
  /** Request change, when this viewer may ask — locked PIs only. */
  requestChange: (() => void) | null
}) {
  const title = locked ? COMPLETION_LOCKED_TITLE : COMPLETION_TITLE
  const missing = locked ? [] : completion.requiredMissing
  return (
    <section
      id="pi-complete-details"
      aria-label={title}
      data-locked={locked ? 'true' : 'false'}
      className="pi-completion"
    >
      <div className="pi-completion-head">
        {locked
          ? <Lock size={16} aria-hidden="true" style={{ color: colors.secondary }} />
          : <ClipboardCheck size={16} aria-hidden="true" style={{ color: colors.blue }} />}
        <h2 className="pi-completion-title">{title}</h2>
      </div>

      <div className="pi-completion-groups">{groups}</div>

      {(submit || requestChange) && (
        <div className="pi-completion-actions">
          {(submit?.issues || missing.length > 0) && (
            <span data-testid="pi-submit-reason" className="pi-submit-reason">
              {submit?.issues && <>Fix the issues in the PI first.{missing.length > 0 ? ' ' : ''}</>}
              {missing.length > 0 && (
                <>
                  Needed to submit:{' '}
                  {missing.map((item, i) => (
                    <span key={item.key}>
                      {i > 0 && ', '}
                      {onFix && item.where !== 'products' ? (
                        <button type="button" className="pi-submit-reason-item" disabled={checklistDisabled} onClick={() => onFix(item)}>
                          {item.label}
                        </button>
                      ) : item.label}
                      {item.needsReimport ? ' (a corrected workbook is needed)' : ''}
                    </span>
                  ))}
                  .
                </>
              )}
            </span>
          )}
          {onChangePi && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={onChangePi} disabled={checklistDisabled}>
              <Upload size={13} strokeWidth={2} aria-hidden="true" /> Change PI
            </button>
          )}
          {submit && (
            <button type="button" className="boe-btn boe-btn-primary" onClick={submit.onSubmit} disabled={submit.disabled}
              title={submit.reason ?? undefined}>
              <Send size={13} strokeWidth={2} aria-hidden="true" /> {submit.label}
            </button>
          )}
          {requestChange && (
            <button type="button" className="boe-btn boe-btn-primary" onClick={requestChange} aria-haspopup="dialog">
              Request change
            </button>
          )}
        </div>
      )}
    </section>
  )
}


/**
 * THE STATUS NOTICE for a PI that is with management: prominent, plain, and with
 * the one route back. Shown to everybody who opens it — a reviewer reads it as
 * "this is locked for its owner", the owner as "ask management to unlock it".
 */
export function PiLockedNotice({ title, body, onRequestChange }: {
  title: string
  body: string
  onRequestChange: (() => void) | null
}) {
  return (
    <div
      role="status"
      data-testid="pi-locked-notice"
      style={{
        display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap',
        border: '1px solid rgba(85,133,232,0.45)', background: colors.blueTint,
        borderRadius: '12px', padding: '12px 16px',
      }}
    >
      <Lock size={18} aria-hidden="true" style={{ color: colors.blue, flexShrink: 0 }} />
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{title}</div>
        <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>{body}</div>
      </div>
      {onRequestChange && (
        <button type="button" className="boe-btn boe-btn-primary" onClick={onRequestChange} aria-haspopup="dialog">
          Request change
        </button>
      )}
    </div>
  )
}
