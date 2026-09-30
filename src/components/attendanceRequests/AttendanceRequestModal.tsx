'use client'

// The dialog used to CORRECT an earlier attendance request: opened with
// `original`, it pre-fills and submits a replacement that points at the
// original, so the first submission stays in the audit trail.
//
// A NEW request is no longer made here — it has its own page,
// /my-attendance/request, which is easier to use on a phone (room for the
// keyboard, a Submit button that stays in reach, and a confirmation the person
// can read). Both render the same AttendanceRequestForm.

import { PayrollModal } from '@/components/payroll/PayrollModal'
import { AttendanceRequestForm, type RequestPayload, type ShiftContext } from './AttendanceRequestForm'
import type { AttendanceRequestRow } from '@/lib/attendance/requests'

export type { RequestPayload }

export function AttendanceRequestModal({
  original, shift, onClose, onSubmit,
}: {
  original?: AttendanceRequestRow | null
  shift?: ShiftContext | null
  onClose: () => void
  /** Resolves to an error message, or null when saved. */
  onSubmit: (payload: RequestPayload) => Promise<string | null>
}) {
  return (
    <PayrollModal
      title={original ? 'Correct attendance request' : 'Attendance request'}
      subtitle={original ? 'Your original request stays in the history.' : 'Tell us before your shift starts if you can.'}
      onClose={onClose}
      width={520}
    >
      <AttendanceRequestForm
        original={original}
        shift={shift}
        variant="modal"
        onSubmit={onSubmit}
        onSubmitted={onClose}
        onCancel={onClose}
      />
    </PayrollModal>
  )
}
