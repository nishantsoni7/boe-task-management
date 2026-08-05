// Meetings — failure classification and reader-facing messages.
//
// One place that decides what a failed meeting write MEANS, so a raw PostgREST
// or Postgres string never reaches the screen. Same shape as
// src/lib/assets/errors.ts; this module keeps its own copy rather than
// importing across a module boundary, matching how Finance, Orders and Assets
// each keep theirs.

export type MeetingErrorLike = {
  message?: string | null
  code?: string | null
  details?: string | null
  hint?: string | null
}

export type MeetingFailureKind =
  | 'permission'  // RLS refusal or a SECURITY DEFINER guard
  | 'schema'      // app ↔ database out of step — most likely an unapplied migration
  | 'validation'
  | 'conflict'
  | 'network'
  | 'unknown'

export function classifyMeetingFailure(err: MeetingErrorLike): MeetingFailureKind {
  const code = err.code ?? ''
  const m = (err.message ?? '').toLowerCase()

  if (['PGRST202', 'PGRST203', 'PGRST204', 'PGRST205'].includes(code)) return 'schema'
  if (code === '42703' || code === '42P01' || code === '42883') return 'schema'
  if (m.includes('schema cache')) return 'schema'

  if (!code && (m === '' || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed'))) {
    return 'network'
  }

  if (code === '42501' || m.includes('row-level security') || m.includes('permission denied')) return 'permission'
  if (code === '40001' || code === '55P03') return 'conflict'
  if (['23502', '23503', '23505', '23514', '22023', '22P02', '22007', '22003', '22001', 'P0001'].includes(code)) {
    return 'validation'
  }
  return 'unknown'
}

export type MeetingAction =
  | 'create-meeting'
  | 'edit-meeting'
  | 'delete-meeting'
  | 'set-status'
  | 'add-order'
  | 'update-order'
  | 'remove-order'
  | 'add-item'
  | 'update-item'
  | 'create-task'
  | 'import'
  | 'attendees'

const PERMISSION_MESSAGE: Record<MeetingAction, string> = {
  'create-meeting': 'You do not have permission to schedule meetings.',
  'edit-meeting':   'You do not have permission to change this meeting.',
  'delete-meeting': 'You do not have permission to delete this meeting.',
  'set-status':     'You do not have permission to complete or reopen this meeting.',
  'add-order':      'You do not have permission to add orders to this meeting.',
  'update-order':   'You do not have permission to record updates in this meeting.',
  'remove-order':   'You do not have permission to remove orders from this meeting.',
  'add-item':       'You do not have permission to add products to this meeting.',
  'update-item':    'You do not have permission to record updates in this meeting.',
  'create-task':    'You do not have permission to create tasks from this meeting.',
  'import':         'You do not have permission to import into this meeting.',
  'attendees':      'You do not have permission to change who attended this meeting.',
}

const NETWORK_MESSAGE  = 'Could not reach the server. Check your connection and try again.'
const SCHEMA_MESSAGE   = 'This action is not available yet. Please try again after the system update.'
const CONFLICT_MESSAGE = 'Someone else is editing this right now. Please try again in a moment.'
const UNKNOWN_MESSAGE  = 'Something went wrong. Please try again.'

// Guards that already raise a reader-ready sentence (migration
// 20260814000000). The prefix is a machine marker a reader must never see.
const GUARD_PREFIXES = [
  'MEETING_MISSING:',
  'MEETING_FORBIDDEN:',
  'MEETING_COMPLETED:',
  'MEETING_HAS_CONTENT:',
  'MEETING_STATUS_INVALID:',
  'MEETING_TRANSITION_INVALID:',
  'MEETING_ORDER_MISSING:',
  'MEETING_ORDER_NUMBER_REQUIRED:',
  'MEETING_ORDER_TYPE_INVALID:',
  'MEETING_ORDER_DUPLICATE:',
  'MEETING_ORDER_HAS_HISTORY:',
  'MEETING_ORDER_HAS_TASKS:',
  'MEETING_ITEM_MISSING:',
  'MEETING_ITEM_DUPLICATE:',
  'MEETING_ITEM_FIELDS_REQUIRED:',
  'MEETING_ITEM_STATUS_INVALID:',
  'MEETING_POSITION_INVALID:',
  'MEETING_TASK_MISSING:',
  'MEETING_TASK_NOT_LINKABLE:',
  'MEETING_IMPORT_INVALID:',
  'MEETING_IMPORT_ROW_INVALID:',
  'MEETING_IMPORT_TYPE_INVALID:',
]

function guardMessage(err: MeetingErrorLike): string | null {
  const raw = (err.message ?? '').trim()
  const prefix = GUARD_PREFIXES.find(p => raw.startsWith(p))
  if (!prefix) return null
  const rest = raw.slice(prefix.length).trim()
  if (!rest) return null
  return rest.endsWith('.') ? rest : `${rest}.`
}

/**
 * The one sentence to show the reader. Never returns a raw driver string:
 * anything unrecognised falls through to a generic sentence, and the real error
 * goes to the console via logMeetingFailure.
 */
export function meetingErrorMessage(action: MeetingAction, err: MeetingErrorLike): string {
  // A guard that already wrote a human sentence keeps it — it names the actual
  // order or SKU, which "you do not have permission" cannot.
  const guard = guardMessage(err)
  if (guard) return guard

  switch (classifyMeetingFailure(err)) {
    case 'permission': return PERMISSION_MESSAGE[action]
    case 'network':    return NETWORK_MESSAGE
    case 'schema':     return SCHEMA_MESSAGE
    case 'conflict':   return CONFLICT_MESSAGE
    case 'validation': return 'One of the values entered is not valid. Check the fields and try again.'
    default:           return UNKNOWN_MESSAGE
  }
}

/** Developer-facing record. No order numbers, no form values, no user ids. */
export function logMeetingFailure(action: MeetingAction, err: MeetingErrorLike): void {
  console.error(`[meetings:${action}] failed`, {
    action,
    kind:    classifyMeetingFailure(err),
    code:    err.code    ?? null,
    message: err.message ?? null,
    details: err.details ?? null,
    hint:    err.hint    ?? null,
  })
}
