'use client'

// ── Order Request inline editing ──────────────────────────────────────────────
// Editing a request happens ON the record, not in a dialog: the reader stays on
// /orders/requests/[id], the fields they may change turn into controls in
// place, and Save commits them. There is no second copy of the record to keep
// in sync and no context switch.
//
// One editor, three submit targets — exactly the three the database offers:
//   edit     — a correction. edit_order_request; status untouched.
//   resubmit — a request sent back for clarification. resubmit_order_request
//              applies the edits and returns it to 'submitted' in one statement.
//   reapply  — a rejected request. reapply_order_request, same shape.
//
// Every path is gated server-side by the same rule the button uses: the RPCs
// re-check ownership/assignment and the exact source status, and
// order_requests_guard_converted refuses all three once the request has been
// converted. Nothing here decides access — it only renders the controls the
// database would accept.

import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { notifyOrders } from '@/lib/notify'
import {
  editRequestErrorMessage,
  logRpcFailure,
  validateAmount,
  type EditRequestResult,
  type OrderRequest,
  type RequestForm,
} from './shared'

export type RequestEditMode = 'edit' | 'resubmit' | 'reapply'

// ── Staged attachment changes ─────────────────────────────────────────────────
// Nothing here touches Storage or the database. A staged change is a local
// intention that exists only until Save Changes succeeds or Cancel discards it —
// which is what makes Cancel a true no-op on the stored files.
//
// There is deliberately NO "remove the Main PI" shape. The only way the Main PI
// leaves is by being REPLACED, so a finalized request can never be saved without
// one. The database backstops the same invariant independently.
export type StagedAttachment = {
  localId:      string
  displayName:  string
  /** The prepared bytes that will be uploaded. Null until preparation finishes. */
  file:         File | null
  contentType:  string | null
  originalSize: number
  finalSize:    number | null
  compressed:   boolean
  status:       'preparing' | 'ready' | 'error'
  error:        string | null
  /** Set when this addition supersedes an existing reference (a Replace). */
  replacesId?:   string
  replacesName?: string
}

export type AttachmentEdits = {
  mainPi:       StagedAttachment | null
  addRefs:      StagedAttachment[]
  /** Existing reference rows staged for removal (includes ones being replaced). */
  removeRefIds: string[]
}

export const EMPTY_ATTACHMENT_EDITS: AttachmentEdits = {
  mainPi: null, addRefs: [], removeRefIds: [],
}

export function hasAttachmentEdits(e: AttachmentEdits): boolean {
  return e.mainPi !== null || e.addRefs.length > 0 || e.removeRefIds.length > 0
}

// Refuses a save that would send a half-prepared or invalid file. Returns the
// first problem as a sentence, or null. The route and the RPC each re-validate
// independently; this only avoids a pointless upload.
export function validateAttachmentEdits(e: AttachmentEdits): string | null {
  if (e.mainPi) {
    if (e.mainPi.status === 'preparing') return 'The replacement Main PI is still being prepared.'
    if (e.mainPi.status === 'error' || !e.mainPi.file) {
      return e.mainPi.error ?? 'The replacement Main PI could not be used. Choose a different file.'
    }
  }
  for (const a of e.addRefs) {
    if (a.status === 'preparing') return `“${a.displayName}” is still being prepared.`
    if (a.status === 'error' || !a.file) {
      return a.error ?? `“${a.displayName}” could not be used. Remove it or choose a different file.`
    }
  }
  return null
}

// The exact request the attachment-edit route receives. Split out from the page
// so what the client SENDS is assertable without a browser or a server: the
// field names the route reads ('mainPi', 'references', 'removeIds'), one
// 'references' entry per staged addition, and removeIds as a JSON array.
//
// Only PREPARED files are attached, which is why validateAttachmentEdits() must
// run first: a staged file with no bytes would otherwise be dropped here in
// silence while its staged REMOVAL still travelled, turning a Replace into a
// deletion. The caller refuses that save; this function assumes it did.
export function buildAttachmentEditForm(requestId: string, e: AttachmentEdits): FormData {
  const fd = new FormData()
  fd.append('requestId', requestId)
  if (e.mainPi?.file) fd.append('mainPi', e.mainPi.file, e.mainPi.file.name)
  for (const a of e.addRefs) {
    if (a.file) fd.append('references', a.file, a.file.name)
  }
  fd.append('removeIds', JSON.stringify(e.removeRefIds))
  return fd
}

// One-line summary of what will be applied, shown before the user commits.
export function describeAttachmentEdits(e: AttachmentEdits): string | null {
  const parts: string[] = []
  if (e.mainPi) parts.push('Main PI replaced')
  if (e.addRefs.length > 0) parts.push(`${e.addRefs.length} reference file${e.addRefs.length !== 1 ? 's' : ''} added`)
  const plainRemovals = e.removeRefIds.filter(
    id => !e.addRefs.some(a => a.replacesId === id)
  ).length
  if (plainRemovals > 0) parts.push(`${plainRemovals} removed`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export const REQUEST_EDIT_META: Record<RequestEditMode, { submit: string; saving: string; started: string }> = {
  edit:     { submit: 'Save Changes',        saving: 'Saving…',       started: 'Editing request' },
  resubmit: { submit: 'Update and Resubmit', saving: 'Resubmitting…', started: 'Updating for resubmission' },
  reapply:  { submit: 'Update and Reapply',  saving: 'Reapplying…',   started: 'Updating to reapply' },
}

// The record, as the form sees it. Every value is a string because these are
// form controls; empty string is the canonical "not set", converted back to
// null on the way to the RPC.
export function formFromRequest(r: OrderRequest): RequestForm {
  return {
    client_name:         r.client_name,
    assigned_to:         r.assigned_to ?? '',
    confirm_date:        r.confirm_date ?? '',
    due_date:            r.due_date ?? '',
    total_product_value: r.total_product_value != null ? String(r.total_product_value) : '',
    total_value:         r.total_value != null ? String(r.total_value) : '',
    lead_source:         r.lead_source ?? '',
    notes:               r.notes ?? '',
  }
}

// Client-side checks, in the same order the form modal applied them. Returns
// the first problem as a sentence, or null. The database enforces these rules
// independently; this only avoids a round trip.
export function validateRequestForm(form: RequestForm): string | null {
  if (!form.client_name.trim()) return 'Client name is required.'
  return validateAmount('Total Product Value', form.total_product_value)
    ?? validateAmount('Total Order Value', form.total_value)
}

// The exact arguments the three form RPCs receive. Split out from
// persistRequestForm so what the client SENDS is assertable without a database:
// the RPC decides what changed by comparing THESE values against the stored row
// with `is distinct from`, so any normalisation mismatch here — a number that
// round-trips as a different string, an empty control that travels as '' rather
// than NULL — would be recorded as a field edit that never happened.
//
// The rules, each mirroring how the column is stored:
//   * every optional control sends NULL when empty, never '' — the columns are
//     nullable and NULL is what "not set" IS, so an untouched empty field
//     compares equal to the stored NULL;
//   * amounts are parsed to numbers, so '400000' compares equal to numeric
//     400000 rather than as text;
//   * notes travels RAW. The RPC trims and nullifies it, and comparing its own
//     normalised result against the stored value is what makes the record show
//     the value actually written. Doing it twice, differently, is how the two
//     would drift.
//
// A browser File is never part of this payload: attachments travel as multipart
// form data to their own route and are never serialised into an RPC argument.
export function buildRequestFormPayload(orderRequestId: string, form: RequestForm) {
  return {
    p_order_request_id:    orderRequestId,
    p_client_name:         form.client_name,
    p_assigned_to:         form.assigned_to  || null,
    p_confirm_date:        form.confirm_date || null,
    p_due_date:            form.due_date     || null,
    p_total_value:         form.total_value  ? parseFloat(form.total_value) : null,
    p_total_product_value: form.total_product_value ? parseFloat(form.total_product_value) : null,
    p_lead_source:         form.lead_source  || null,
    p_notes:               form.notes,
  }
}

// Commits the form through the RPC that matches the mode, and raises the
// notifications each path owes. Returns an error sentence, or null on success.
//
// notifyOrders never throws: it swallows and logs its own failures and is
// deliberately not awaited, so a notification outage can never turn a committed
// save into a visible failure.
export async function persistRequestForm({
  supabase, mode, request, form,
}: {
  supabase: ReturnType<typeof createClient>
  mode: RequestEditMode
  request: OrderRequest
  form: RequestForm
}): Promise<string | null> {
  const payload = buildRequestFormPayload(request.id, form)

  if (mode === 'edit') {
    // NOT a direct table update — public.order_requests has no UPDATE policy
    // for any role, so a plain `.update()` matches zero rows and fails for
    // everyone, admins included. The RPC (20260708) re-checks admin-or-assignee,
    // the converted lock, and assignee eligibility server-side.
    const { data, error: rpcErr } = await supabase.rpc('edit_order_request', payload)
    if (rpcErr) {
      logRpcFailure('edit_order_request', rpcErr)
      return editRequestErrorMessage(rpcErr)
    }

    // Reassignment notification, keyed off COMMITTED database state
    // (assignee_changed is computed inside the RPC from the pre-update row)
    // rather than pre-save form values, so it fires exactly when assigned_to
    // actually moved — never on a no-op save, never on a plain field edit.
    const result = data as EditRequestResult | null
    if (result?.assignee_changed && result.assigned_to) {
      void notifyOrders({
        event:         'order_reassigned',
        requestNumber: request.request_number,
        entityId:      request.id,
        clientName:    form.client_name.trim(),
        assignedTo:    result.assigned_to,
      })
    }
    return null
  }

  const { error: rpcErr } = await supabase.rpc(
    mode === 'resubmit' ? 'resubmit_order_request' : 'reapply_order_request',
    payload,
  )
  if (rpcErr) {
    if (rpcErr.message?.includes('Assignee must be')) return rpcErr.message
    return mode === 'resubmit'
      ? 'Could not resubmit this request. It may have already changed. Please refresh and try again.'
      : 'Could not reapply this request. It may have already changed. Please refresh and try again.'
  }

  // Only a hand-back to the reviewers' queue is announced. An in-place edit of
  // an already-submitted request changes no state anyone is waiting on, so it
  // raises no notification.
  void notifyOrders({
    event: 'order_resubmitted',
    requestNumber: request.request_number,
    entityId: request.id,
    clientName: form.client_name.trim(),
  })
  return null
}

// What saving will and will not do, stated before the reader commits. An edit
// never moves status, so it names the status the request will STILL be in
// rather than implying a review hand-back.
export function editModeNotice(mode: RequestEditMode, status: string): string {
  if (mode === 'resubmit') return 'Saving applies your changes and sends this request back for review.'
  if (mode === 'reapply')  return 'Saving applies your changes and submits this request for review again.'
  return status === 'needs_clarification'
    ? 'Saving updates the details only. This request still needs clarification — use Update and Resubmit to send it back for review.'
    : status === 'rejected'
      ? 'Saving updates the details only. This request stays rejected — use Update and Reapply to submit it again.'
      : 'Saving updates the details only. This request stays under review.'
}

// ── Field primitives ──────────────────────────────────────────────────────────
// Deliberately the same row rhythm as the read-only DetailRow, so switching
// into edit mode changes the CONTROLS, not the layout — nothing jumps.

export const editInputStyle: React.CSSProperties = {
  padding: '6px 9px', borderRadius: '6px',
  border: `1px solid ${colors.borderSoft}`,
  background: colors.base, color: colors.primary,
  fontSize: '13px', width: '100%', boxSizing: 'border-box',
  outline: 'none', fontFamily: 'inherit',
}

export function EditRow({ label, htmlFor, children, hint, last }: {
  label: string
  htmlFor: string
  children: React.ReactNode
  hint?: string
  last?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
      padding: '7px 0', borderBottom: last ? 'none' : `1px solid ${colors.border}`,
    }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase',
          letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0,
        }}
      >
        {label}
      </label>
      <div style={{ flex: '0 1 230px', minWidth: 0 }}>
        {children}
        {hint && (
          <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '3px', lineHeight: 1.4 }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  )
}
