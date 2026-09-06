'use client'

// THE THREE DIALOGS 20261116000000 ADDS TO THE CONFIRMED ORDER.
//
//   ProposeRevisionModal      a revised PI workbook and the reason for it
//   RejectRevisionModal       an admin's reason for refusing one
//   ProductionAlignmentModal  the Head of Manufacturing aligning the Order
//
// EVERY ONE OF THEM IS A FUNCTION OF ITS PROPS. Nothing here uploads, calls an
// RPC or decides authority: the page owns the writes, and the database decides
// again under a row lock whatever the page sent. These draw the question, hold
// the typed answer through a failed attempt, and hand it up validated.
//
// Built on the same OrderModal primitives the amendment dialogs use, so the
// four dialogs on this screen cannot look like four products.

import { useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import {
  OrderModal, OrderField, OrderModalActions, OrderModalError, OrderModalNotice,
} from '@/components/orders/OrderModal'
import {
  APPROVE_REVISION_NOTE,
  REJECT_REVISION_DIALOG_TITLE,
  REVISION_DECISION_REASON_LABEL,
  REVISION_DECISION_REASON_MAX_LENGTH,
  REVISION_FILE_LABEL,
  REVISION_REASON_LABEL,
  REVISION_REASON_MAX_LENGTH,
  REVISION_REASON_PLACEHOLDER,
  UPLOAD_REVISION_CONFIRM_LABEL,
  UPLOAD_REVISION_DIALOG_TITLE,
  UPLOAD_REVISION_NOTE,
  REJECT_REVISION_BUTTON_LABEL,
  APPROVE_REVISION_BUTTON_LABEL,
  piVersionLabel,
  validateRevisionDecisionReason,
  validateRevisionFile,
  validateRevisionReason,
} from '@/lib/orders/orderPiVersions'
import {
  ALIGN_PRODUCTION_BUTTON_LABEL,
  ALIGN_PRODUCTION_CONFIRM,
  ALIGN_PRODUCTION_DIALOG_TITLE,
  ALIGN_PRODUCTION_NOTE_LABEL,
  ALIGN_PRODUCTION_NOTE_MAX_LENGTH,
  ALIGN_PRODUCTION_NOTE_PLACEHOLDER,
  UNALIGN_PRODUCTION_BUTTON_LABEL,
  UNALIGN_PRODUCTION_DIALOG_TITLE,
  validateAlignmentNote,
} from '@/lib/orders/productionAlignment'

const TEXTAREA: React.CSSProperties = {
  padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${colors.border}`, background: colors.base, color: colors.primary,
  fontSize: '13px', width: '100%', boxSizing: 'border-box', outline: 'none',
  minHeight: '64px', resize: 'vertical', fontFamily: 'inherit',
}

// ── Upload revised PI ─────────────────────────────────────────────────────────

export function ProposeRevisionModal({
  orderNumber, nextVersion, saving, failure, onClose, onConfirm,
}: {
  orderNumber: string
  /** The number the revision will take, for the heading — informative only. */
  nextVersion: number
  saving: boolean
  failure: string | null
  onClose: () => void
  onConfirm: (file: File, reason: string) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const fileError = validateRevisionFile(file)
  const reasonCheck = validateRevisionReason(reason)
  const ready = fileError === null && reasonCheck.ok

  return (
    <OrderModal
      title={UPLOAD_REVISION_DIALOG_TITLE}
      subtitle={`Order ${orderNumber} · ${piVersionLabel(nextVersion)}`}
      onClose={onClose}
    >
      <OrderModalNotice>{UPLOAD_REVISION_NOTE}</OrderModalNotice>

      <OrderField label={REVISION_FILE_LABEL} error={touched && fileError ? fileError : undefined}>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={saving}
          onChange={e => { setFile(e.target.files?.[0] ?? null); setTouched(true) }}
          style={{ fontSize: '13px' }}
        />
      </OrderField>

      <OrderField
        label={REVISION_REASON_LABEL}
        error={touched && !reasonCheck.ok ? reasonCheck.message : undefined}
        hint={`${REVISION_REASON_MAX_LENGTH - reason.trim().length} characters left`}
      >
        <textarea
          value={reason}
          onChange={e => { setReason(e.target.value); setTouched(true) }}
          placeholder={REVISION_REASON_PLACEHOLDER}
          maxLength={REVISION_REASON_MAX_LENGTH}
          disabled={saving}
          rows={3}
          style={TEXTAREA}
        />
      </OrderField>

      {failure && <OrderModalError message={failure} />}

      <OrderModalActions
        onClose={onClose}
        onSave={() => {
          setTouched(true)
          if (!ready || !file || !reasonCheck.ok || saving) return
          onConfirm(file, reasonCheck.reason)
        }}
        saving={saving}
        disabled={!ready}
        saveLabel={UPLOAD_REVISION_CONFIRM_LABEL}
      />
    </OrderModal>
  )
}

// ── Approve revised PI ────────────────────────────────────────────────────────

export function ApproveRevisionModal({
  orderNumber, versionNumber, saving, failure, onClose, onConfirm,
}: {
  orderNumber: string
  versionNumber: number
  saving: boolean
  failure: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <OrderModal
      title={APPROVE_REVISION_BUTTON_LABEL}
      subtitle={`Order ${orderNumber} · ${piVersionLabel(versionNumber)}`}
      onClose={onClose}
    >
      <OrderModalNotice tone="warning">{APPROVE_REVISION_NOTE}</OrderModalNotice>
      {failure && <OrderModalError message={failure} />}
      <OrderModalActions
        onClose={onClose}
        onSave={() => { if (!saving) onConfirm() }}
        saving={saving}
        saveLabel={APPROVE_REVISION_BUTTON_LABEL}
      />
    </OrderModal>
  )
}

// ── Reject revised PI ─────────────────────────────────────────────────────────

export function RejectRevisionModal({
  orderNumber, versionNumber, saving, failure, onClose, onConfirm,
}: {
  orderNumber: string
  versionNumber: number
  saving: boolean
  failure: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const check = validateRevisionDecisionReason(reason)

  return (
    <OrderModal
      title={REJECT_REVISION_DIALOG_TITLE}
      subtitle={`Order ${orderNumber} · ${piVersionLabel(versionNumber)}`}
      onClose={onClose}
    >
      <OrderModalNotice>
        The current approved PI stays in force. The rejected revision is kept, with this reason, and the person who proposed it is told.
      </OrderModalNotice>
      <OrderField
        label={REVISION_DECISION_REASON_LABEL}
        error={touched && !check.ok ? check.message : undefined}
      >
        <textarea
          value={reason}
          onChange={e => { setReason(e.target.value); setTouched(true) }}
          maxLength={REVISION_DECISION_REASON_MAX_LENGTH}
          disabled={saving}
          rows={3}
          style={TEXTAREA}
        />
      </OrderField>
      {failure && <OrderModalError message={failure} />}
      <OrderModalActions
        onClose={onClose}
        onSave={() => {
          setTouched(true)
          if (!check.ok || saving) return
          onConfirm(check.reason)
        }}
        saving={saving}
        disabled={!check.ok}
        destructive
        saveLabel={REJECT_REVISION_BUTTON_LABEL}
      />
    </OrderModal>
  )
}

// ── Production alignment ──────────────────────────────────────────────────────

export function ProductionAlignmentModal({
  orderNumber, aligning, saving, failure, onClose, onConfirm,
}: {
  orderNumber: string
  /** True to align, false to take the alignment back. */
  aligning: boolean
  saving: boolean
  failure: string | null
  onClose: () => void
  onConfirm: (note: string | null) => void
}) {
  const [note, setNote] = useState('')
  const check = validateAlignmentNote(note)

  return (
    <OrderModal
      title={aligning ? ALIGN_PRODUCTION_DIALOG_TITLE : UNALIGN_PRODUCTION_DIALOG_TITLE}
      subtitle={`Order ${orderNumber}`}
      onClose={onClose}
    >
      <OrderModalNotice tone={aligning ? 'info' : 'warning'}>
        {aligning
          ? ALIGN_PRODUCTION_CONFIRM
          : 'This takes the Order back to Not Aligned. It changes nothing else about the Order and is recorded on its history.'}
      </OrderModalNotice>
      <OrderField
        label={ALIGN_PRODUCTION_NOTE_LABEL}
        error={!check.ok ? check.message : undefined}
      >
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={ALIGN_PRODUCTION_NOTE_PLACEHOLDER}
          maxLength={ALIGN_PRODUCTION_NOTE_MAX_LENGTH}
          disabled={saving}
          rows={3}
          style={TEXTAREA}
        />
      </OrderField>
      {failure && <OrderModalError message={failure} />}
      <OrderModalActions
        onClose={onClose}
        onSave={() => { if (check.ok && !saving) onConfirm(check.note) }}
        saving={saving}
        disabled={!check.ok}
        destructive={!aligning}
        saveLabel={aligning ? ALIGN_PRODUCTION_BUTTON_LABEL : UNALIGN_PRODUCTION_BUTTON_LABEL}
      />
    </OrderModal>
  )
}
