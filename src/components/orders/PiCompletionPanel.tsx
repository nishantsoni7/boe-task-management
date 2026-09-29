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

import { AlertTriangle, CheckCircle2, ClipboardCheck, Lock, Pencil, Send, Upload } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  COMPLETION_NEED_LABEL,
  joinItemNames,
  type CompletionFact,
  type CompletionItem,
  type CompletionNeed,
  type PiCompletion,
} from '@/lib/orders/piCompletion'

export const COMPLETION_TITLE = 'Complete PI details'
export const COMPLETION_LOCKED_TITLE = 'PI details'
export const COMPLETION_LOCKED_HINT = 'Locked while this PI is with management.'
export const COMPLETION_READY_TEXT = 'Every required detail is in. You can submit this PI for approval.'

const HINT: React.CSSProperties = { fontSize: '11.5px', color: colors.secondary, lineHeight: 1.45 }

const NEED_TONE: Record<CompletionNeed, { color: string; background: string }> = {
  submission: { color: '#9A6212', background: 'rgba(232,160,48,0.12)' },
  later: { color: '#2F5BB7', background: 'rgba(85,133,232,0.10)' },
  optional: { color: '#6b7384', background: '#eef0f4' },
}

/** The label beside every field: Required for submission, Required later…, or Optional. */
export function NeedBadge({ need }: { need: CompletionNeed }) {
  return (
    <span data-need={need} style={{
      display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: '999px',
      fontSize: '10.5px', fontWeight: 600, whiteSpace: 'nowrap', ...NEED_TONE[need],
    }}>
      {COMPLETION_NEED_LABEL[need]}
    </span>
  )
}

/**
 * THE LIVE CHECKLIST: what blocks Submit, what is only needed later, and what is
 * optional and still empty. It is the same list the Submit sequence reads.
 *
 * Only a required item can hold the action, and only a required item has an
 * "Add" — the later and optional ones are listed so nobody is surprised by
 * them, never as a demand.
 */
export function PiCompletionChecklist({ completion, onFix, disabled }: {
  completion: PiCompletion
  onFix: ((item: CompletionItem) => void) | null
  disabled: boolean
}) {
  const { requiredMissing, laterMissing, optionalMissing } = completion
  return (
    <div data-testid="pi-completion-checklist" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {requiredMissing.length === 0 ? (
        <div role="status" style={{ display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12.5px', fontWeight: 600, color: '#166534' }}>
          <CheckCircle2 size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
          {COMPLETION_READY_TEXT}
        </div>
      ) : (
        <div style={{
          padding: '9px 12px', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '5px',
          border: '1px solid rgba(232,160,48,0.35)', background: colors.amberTint,
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
            {requiredMissing.length === 1 ? '1 required item left' : `${requiredMissing.length} required items left`}
            <span style={{ fontWeight: 500, color: colors.secondary }}> — Submit for approval waits for these</span>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {requiredMissing.map(item => (
              <li key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12.5px', color: colors.primary }}>
                <AlertTriangle size={12} aria-hidden="true" style={{ color: colors.amber, flexShrink: 0 }} />
                <span>{item.label}{item.needsReimport ? ' — a corrected workbook is needed' : ''}</span>
                {/* An incomplete product line is counted, not listed, so an
                    "Add" would have to guess which row; the products section
                    and Edit PI own those. */}
                {onFix && item.where !== 'products' && (
                  <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '2px 10px', fontSize: '11.5px' }}
                    disabled={disabled} onClick={() => onFix(item)}>
                    {item.needsReimport ? 'Change PI' : 'Add'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {laterMissing.length > 0 && (
        <div style={HINT}>
          <NeedBadge need="later" /> <span>Not needed to submit: {joinItemNames(laterMissing)}.</span>
        </div>
      )}
      {optionalMissing.length > 0 && (
        <div style={HINT}>
          <NeedBadge need="optional" /> <span>Not filled: {joinItemNames(optionalMissing)}.</span>
        </div>
      )}
    </div>
  )
}

/** One read-out group (client, or the PI's own terms) with its single edit control. */
export function PiCompletionFacts({ title, facts, editLabel, canEdit, locked, onEdit }: {
  title: string
  facts: readonly CompletionFact[]
  editLabel: string
  canEdit: boolean
  locked: boolean
  onEdit: () => void
}) {
  return (
    <section aria-label={title} style={{
      border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.base,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: colors.primary }}>{title}</h3>
        {(canEdit || locked) && (
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            style={{ marginLeft: 'auto', ...(locked ? { opacity: 0.55, cursor: 'not-allowed' } : null) }}
            disabled={locked}
            title={locked ? COMPLETION_LOCKED_HINT : undefined}
            onClick={onEdit}
            aria-haspopup="dialog"
          >
            <Pencil size={12} aria-hidden="true" /> {editLabel}
          </button>
        )}
      </div>
      <dl style={{ margin: 0, display: 'grid', gap: '9px 14px', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {facts.map(fact => (
          <div key={fact.key} data-fact={fact.key} style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
            <dt style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11.5px', fontWeight: 600, color: colors.secondary }}>
              {fact.label}
              <NeedBadge need={fact.need} />
            </dt>
            <dd style={{
              margin: 0, fontSize: '13px', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              fontWeight: fact.value ? 600 : 500,
              color: fact.value ? colors.primary : fact.need === 'submission' ? '#8a4b12' : colors.muted,
            }}>
              {fact.value ?? (fact.need === 'submission' ? 'Not added yet' : 'Not given')}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * THE AREA. Header and checklist first, the grouped fields in the middle, and
 * the action last — directly under the last field, which on a phone is where the
 * thumb already is.
 *
 * Locked: the same fields, legible and read-only, the editing controls muted and
 * disabled, and the submit/upload actions replaced by the one route back —
 * Request change.
 */
export function PiCompletionPanel({
  completion, locked, checklistDisabled, onFix, groups, submit, onChangePi, requestChange,
}: {
  completion: PiCompletion
  locked: boolean
  checklistDisabled: boolean
  onFix: ((item: CompletionItem) => void) | null
  /** The grouped fields: the facts, the internal order details, the documents, the highlight. */
  groups: React.ReactNode
  /** The Submit control's state — omitted when the viewer cannot submit. */
  submit: { label: string; disabled: boolean; reason: string | null; onSubmit: () => void } | null
  onChangePi: (() => void) | null
  /** Request change, when this viewer may ask — locked PIs only. */
  requestChange: (() => void) | null
}) {
  const title = locked ? COMPLETION_LOCKED_TITLE : COMPLETION_TITLE
  return (
    <section
      id="pi-complete-details"
      aria-label={title}
      data-locked={locked ? 'true' : 'false'}
      className="pi-completion"
      style={{
        border: `1px solid ${locked ? colors.border : 'rgba(85,133,232,0.35)'}`, borderRadius: '12px',
        background: locked ? colors.raised : colors.base,
        padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0,
        scrollMarginTop: '80px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {locked
          ? <Lock size={15} aria-hidden="true" style={{ color: colors.secondary }} />
          : <ClipboardCheck size={15} aria-hidden="true" style={{ color: colors.blue }} />}
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: colors.primary }}>{title}</h2>
        {locked && <span style={HINT}>{COMPLETION_LOCKED_HINT}</span>}
      </div>

      {!locked && <PiCompletionChecklist completion={completion} onFix={onFix} disabled={checklistDisabled} />}

      <div className="pi-completion-groups">{groups}</div>

      {(submit || requestChange) && (
        <div className="pi-completion-actions" style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end',
          borderTop: `1px solid ${colors.border}`, paddingTop: '12px',
        }}>
          {submit?.reason && (
            <span data-testid="pi-submit-reason" style={{ ...HINT, marginRight: 'auto', color: '#8a4b12' }}>{submit.reason}</span>
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
