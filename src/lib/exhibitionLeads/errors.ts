// Turning what the database or the network says into something a person at a
// stand can act on. The database raises "EXHIBITION_LEADS_<KIND>: <sentence>";
// the sentence is written for people and is passed through for INVALID.

export type LeadErrorKind =
  | 'auth'          // session gone — preserve the work and sign in again
  | 'forbidden'
  | 'not_found'
  | 'archived'
  | 'duplicate_phone'
  | 'restore_conflict'
  | 'follow_up_date'
  | 'invalid'
  | 'conflict'      // same submission id, different details
  | 'uncertain'     // the request may or may not have landed — retry is safe
  | 'unknown'

export type LeadError = { kind: LeadErrorKind; message: string }

type Raw = { message?: string; code?: string; status?: number } | null | undefined

const AFTER_PREFIX = /^EXHIBITION_LEADS_[A-Z_]+:\s*/

export function classifyLeadError(err: Raw): LeadError {
  const message = (err?.message ?? '').trim()
  const code = err?.code ?? ''

  if (/JWT|not authenticated|Auth session missing/i.test(message) || code === 'PGRST301' || err?.status === 401) {
    return { kind: 'auth', message: 'Your session has expired. Sign in again — what you entered is kept.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_FORBIDDEN') || code === '42501') {
    return { kind: 'forbidden', message: 'You do not have access to this.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_NOT_FOUND')) {
    return { kind: 'not_found', message: 'This lead is not available to you.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_ARCHIVED')) {
    return { kind: 'archived', message: 'An archived lead cannot be changed. Ask Admin to restore it.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_DUPLICATE_PHONE')) {
    return { kind: 'duplicate_phone', message: 'Another active lead already has this mobile number.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_RESTORE_CONFLICT')) {
    return { kind: 'restore_conflict', message: 'Cannot restore: another active lead already has this mobile number.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_FOLLOW_UP_DATE_REQUIRED')) {
    return { kind: 'follow_up_date', message: 'Choose the next follow-up date for a Follow-up lead.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_SUBMISSION_CONFLICT')) {
    return { kind: 'conflict', message: 'This entry was already saved with different details. Nothing was changed — check My Leads, or start a new entry.' }
  }
  if (message.startsWith('EXHIBITION_LEADS_INVALID')) {
    return { kind: 'invalid', message: message.replace(AFTER_PREFIX, '') || 'Check the details and try again.' }
  }
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i.test(message) || err?.status === 0) {
    return { kind: 'uncertain', message: 'Could not confirm the save. Nothing is lost — tap Save again.' }
  }
  return { kind: 'unknown', message: 'Something went wrong. Nothing was confirmed saved — try again.' }
}
