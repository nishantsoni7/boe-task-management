'use client'

// THE ONE PLACE A FABRIC OR FINISH STATUS MOVES.
//
// ONE DIALOG, TWO SEPARATE SIGN-OFFS. Fabric and Finish are edited in the same
// session because they usually move together, but they never share a control
// and they never share a proof: two selectors, two file inputs, and a check
// that refuses the same file for both. That is the rule the database holds as
// well — record_order_approval_event() refuses a screenshot already filed
// against another event — and this states it before the press rather than after.
//
// AS LITTLE TYPING AS POSSIBLE. Two selects and, only where a change needs one,
// a file. There is no reason field: no existing rule asks for one, and a
// mandatory box somebody has to fill to record what a screenshot already proves
// is how a workflow starts collecting the word "done".
//
// IT AUTHORIZES NOTHING. The page decides whether to offer this at all, and the
// RPC decides again under a row lock.

import { useCallback, useMemo, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import {
  APPROVAL_KIND_LABEL,
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABEL,
  EVIDENCE_ACCEPT,
  FABRIC_FINISH_TITLE,
  checkApprovalDraft,
  isChanged,
  needsEvidence,
  type ApprovalDraft,
  type ApprovalKind,
  type ApprovalStanding,
  type ApprovalStatus,
} from '@/lib/orders/orderApprovals'
import { OrderModalShell } from './OrderStatusWorkspace'

export const APPROVAL_MODAL_TITLE = `Update ${FABRIC_FINISH_TITLE}`
export const APPROVAL_SAVE_LABEL = 'Save'
export const APPROVAL_SAVING_LABEL = 'Saving…'
export const APPROVAL_CANCEL_LABEL = 'Cancel'
export const APPROVAL_EVIDENCE_LABEL = 'ERP screenshot'
export const APPROVAL_CHANGED_MARK = 'Changed'

export type ApprovalSubmission = {
  kind: ApprovalKind
  status: ApprovalStatus
  file: File | null
}

export function OrderApprovalModal({ standing, saving, failure, onClose, onConfirm }: {
  standing: ApprovalStanding
  /** True while the uploads and the writes are in flight. */
  saving: boolean
  /** One quiet line from the server, or null. */
  failure: string | null
  onClose: () => void
  onConfirm: (changes: ApprovalSubmission[]) => void
}) {
  // PRE-FILLED WITH WHERE EACH KIND STANDS, so the dialog opens showing the
  // truth and a person changes only what moved.
  const [picked, setPicked] = useState<Record<ApprovalKind, ApprovalStatus>>(() => ({
    fabric: standing.kinds.find(k => k.kind === 'fabric')?.status ?? 'not_approved',
    finish: standing.kinds.find(k => k.kind === 'finish')?.status ?? 'not_approved',
  }))
  const [files, setFiles] = useState<Record<ApprovalKind, File | null>>({
    fabric: null, finish: null,
  })
  const [touched, setTouched] = useState(false)
  const submitted = useRef(false)

  // Stable while `standing` is, so the draft memo below does not rebuild on
  // every keystroke elsewhere in the dialog.
  const current = useCallback(
    (kind: ApprovalKind): ApprovalStatus =>
      standing.kinds.find(k => k.kind === kind)?.status ?? 'not_approved',
    [standing],
  )

  const drafts: ApprovalDraft[] = useMemo(() => (
    (['fabric', 'finish'] as const).map(kind => ({
      kind,
      status: picked[kind],
      current: current(kind),
      file: files[kind]
        ? { name: files[kind]!.name, size: files[kind]!.size, type: files[kind]!.type }
        : null,
    }))
  ), [picked, files, current])

  const check = checkApprovalDraft(drafts)
  const ready = check.ok && !saving

  const submit = () => {
    // TWICE IS NEVER TWICE. A double press, or a press while the first write is
    // still going, does nothing at all.
    if (!ready || submitted.current) { setTouched(true); return }
    submitted.current = true
    onConfirm(
      drafts.filter(isChanged).map(d => ({
        kind: d.kind,
        status: d.status,
        file: needsEvidence(d) ? files[d.kind] : null,
      })),
    )
    // The page owns the outcome. If it fails it clears `saving` and the dialog
    // stays open with its error, so the guard is released for a real retry.
    window.setTimeout(() => { submitted.current = false }, 0)
  }

  return (
    <OrderModalShell title={APPROVAL_MODAL_TITLE} onClose={() => { if (!saving) onClose() }}>
      <div className="order-approval-form">
        {(['fabric', 'finish'] as const).map(kind => {
          const draft = drafts.find(d => d.kind === kind) as ApprovalDraft
          const changed = isChanged(draft)
          const wantsFile = needsEvidence(draft)
          const missing = touched && wantsFile && !files[kind]
          return (
            <fieldset key={kind} className="order-approval-field">
              <legend className="order-approval-legend">
                {APPROVAL_KIND_LABEL[kind]}
                {/* WHICH FIELDS CHANGED, said plainly. */}
                {changed && <span className="order-approval-changed">{APPROVAL_CHANGED_MARK}</span>}
              </legend>

              <label className="order-approval-label" htmlFor={`approval-${kind}`}>
                Status
              </label>
              <select
                id={`approval-${kind}`}
                className="order-approval-select"
                value={picked[kind]}
                disabled={saving}
                onChange={e => {
                  const next = e.target.value as ApprovalStatus
                  setPicked(p => ({ ...p, [kind]: next }))
                  // A status that no longer needs a proof drops the one it had,
                  // so nothing is uploaded for an event that does not want it.
                  if (next === 'not_approved' || next === current(kind)) {
                    setFiles(f => ({ ...f, [kind]: null }))
                  }
                }}
              >
                {APPROVAL_STATUSES.map(status => (
                  <option key={status} value={status}>{APPROVAL_STATUS_LABEL[status]}</option>
                ))}
              </select>

              {/* THE FILE INPUT EXISTS ONLY WHERE A PROOF IS REQUIRED: moving
                  to Not Approved needs none, and an unchanged kind needs none
                  however it stands. */}
              {wantsFile && (
                <div className="order-approval-evidence">
                  <label className="order-approval-label" htmlFor={`evidence-${kind}`}>
                    {APPROVAL_EVIDENCE_LABEL} *
                  </label>
                  <input
                    id={`evidence-${kind}`}
                    type="file"
                    accept={EVIDENCE_ACCEPT}
                    className="order-approval-file"
                    disabled={saving}
                    onChange={e => {
                      setFiles(f => ({ ...f, [kind]: e.target.files?.[0] ?? null }))
                      setTouched(true)
                    }}
                  />
                  {missing && (
                    <p className="order-approval-error" role="alert">
                      Choose the {APPROVAL_KIND_LABEL[kind].toLowerCase()} screenshot.
                    </p>
                  )}
                </div>
              )}
            </fieldset>
          )
        })}

        {/* The one blocking reason, once, under both fields. */}
        {touched && !check.ok && (
          <p className="order-approval-error" role="alert">{check.message}</p>
        )}
        {failure && <p className="order-approval-error" role="alert">{failure}</p>}

        <div className="order-approval-actions">
          <button
            type="button"
            className="boe-btn boe-btn-ghost order-status-action"
            onClick={onClose}
            disabled={saving}
          >
            {APPROVAL_CANCEL_LABEL}
          </button>
          <button
            type="button"
            className="boe-btn boe-btn-primary order-status-action"
            onClick={submit}
            disabled={!ready}
            aria-disabled={!ready}
          >
            <Upload size={13} strokeWidth={2} aria-hidden="true" />
            {saving ? APPROVAL_SAVING_LABEL : APPROVAL_SAVE_LABEL}
          </button>
        </div>
      </div>
    </OrderModalShell>
  )
}
