// Assets & Access — failure classification and reader-facing messages.
//
// One place that decides what a failed asset write MEANS, so a raw PostgREST
// or Postgres string never reaches the screen. Same shape as the Order
// Requests classifier (src/app/orders/requests/components/shared.ts) — this
// module has its own copy rather than importing across module boundaries,
// matching how Finance and Orders each keep their own.
//
// The message a reader gets must tell them what to do next, and the console
// keeps what an engineer needs to place the failure. Neither carries form
// values.

export type AssetErrorLike = {
  message?: string | null
  code?: string | null
  details?: string | null
  hint?: string | null
}

export type AssetFailureKind =
  | 'permission'  // RLS refusal or a SECURITY DEFINER guard
  | 'schema'      // app ↔ database out of step (missing column/table/function)
  | 'validation'  // a value the database refused
  | 'conflict'    // another transaction holds the row
  | 'network'     // the request never reached PostgREST
  | 'unknown'

export function classifyAssetFailure(err: AssetErrorLike): AssetFailureKind {
  const code = err.code ?? ''
  const m = (err.message ?? '').toLowerCase()

  // PostgREST answered from a schema cache without what the app asked for
  // (PGRST202/203 function, 204 column, 205 table), or Postgres itself
  // reported the same mismatch. For this module that means a pending
  // migration — most likely accept_employee_asset not being deployed yet.
  if (['PGRST202', 'PGRST203', 'PGRST204', 'PGRST205'].includes(code)) return 'schema'
  if (code === '42703' || code === '42P01' || code === '42883') return 'schema'
  if (m.includes('schema cache')) return 'schema'

  // No code at all: fetch rejected before PostgREST replied.
  if (!code && (m === '' || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed'))) {
    return 'network'
  }

  // 42501 covers both an RLS refusal and the module's own guards
  // (ASSET_ACCEPT_DENIED, ASSET_DELETE_BLOCKED). A plain INSERT refusal
  // arrives as "new row violates row-level security policy for table
  // \"assets\"" with code 42501.
  if (code === '42501' || m.includes('row-level security') || m.includes('permission denied')) return 'permission'
  if (code === '40001' || code === '55P03') return 'conflict'
  if (['23502', '23503', '23505', '23514', '22P02', '22007', '22003', '22001', 'P0001'].includes(code)) {
    return 'validation'
  }
  return 'unknown'
}

// What the reader was trying to do. Only the permission and validation
// sentences differ per action — the rest are about the system, not the verb.
export type AssetAction =
  | 'create'
  | 'edit'
  | 'assign'
  | 'return'
  | 'mark-lost'
  | 'delete'
  | 'accept'
  | 'request-edit'
  | 'request-remove'
  | 'approve-request'
  | 'reject-request'
  // Lifecycle operations (20260730000000)
  | 'transfer'
  | 'recover'
  | 'send-repair'
  | 'complete-service'
  | 'add-service'
  | 'correct-service'
  | 'retire'
  | 'restore'
  | 'upload-document'
  | 'remove-document'

const PERMISSION_MESSAGE: Record<AssetAction, string> = {
  'create':    'You do not have permission to add assets.',
  'edit':      'You do not have permission to edit assets directly.',
  // One sentence per operation. A refusal must name what the reader actually
  // tried to do — "manage asset assignments" told an Assign click nothing.
  'assign':    'You do not have permission to assign assets.',
  'return':    'You do not have permission to return assets.',
  'mark-lost': 'You do not have permission to mark assets as lost.',
  'delete':    'Only an administrator can permanently delete an asset.',
  'accept':    'This assignment is not yours to accept, or it has already been accepted.',
  'request-edit':    'You do not have permission to request changes to assets.',
  'request-remove':  'You do not have permission to request removal of assets.',
  'approve-request': 'Only an administrator can approve this request.',
  'reject-request':  'Only an administrator can reject this request.',
  'transfer':         'You do not have permission to transfer assets.',
  'recover':          'You do not have permission to recover lost assets.',
  'send-repair':      'You do not have permission to send assets for repair.',
  'complete-service': 'You do not have permission to close a service record.',
  'add-service':      'You do not have permission to add service records.',
  'correct-service':  'Only an administrator can correct a service record.',
  'retire':           'You do not have permission to retire assets.',
  'restore':          'You do not have permission to restore assets.',
  'upload-document':  'You do not have permission to add documents to assets.',
  'remove-document':  'You do not have permission to remove asset documents.',
}

// A second open request of the same type against the same asset trips the
// partial unique index. That is a duplicate, not a bad value, and saying so
// is the difference between "try again" and "you already did this".
const DUPLICATE_REQUEST_MESSAGE: Partial<Record<AssetAction, string>> = {
  'request-edit':   'You already have a pending edit request for this asset.',
  'request-remove': 'You already have a pending removal request for this asset.',
}

const NETWORK_MESSAGE  = 'Could not reach the server. Check your connection and try again.'
const SCHEMA_MESSAGE   = 'This action is not available yet. Please try again after the system update.'
const CONFLICT_MESSAGE = 'This asset is busy right now. Please try again in a moment.'
const UNKNOWN_MESSAGE  = 'Something went wrong. Please try again.'

// Guards that raise their own reader-ready sentence (SECURITY DEFINER
// functions and BEFORE DELETE triggers, 20260722000000). The prefix is a
// machine marker, not something a reader should ever see.
const GUARD_PREFIXES = [
  'ASSET_DELETE_BLOCKED:',
  // Permanent deletion (20260803000000)
  'ASSET_DELETE_DENIED:',
  'ASSET_DELETE_MISSING:',
  'ASSET_ACCEPT_DENIED:',
  'ASSET_ACCEPT_INVALID:',
  'ASSET_ACCEPT_CONFLICT:',
  // Handover acknowledgement (20261029000000). Both write a sentence the
  // reader can act on, and the first is what an out-of-date client sees when
  // it calls accept_employee_asset without the acknowledgement flag.
  'ASSET_ACCEPT_TERMS_REQUIRED:',
  'ASSET_ACCEPT_TERMS_MISSING:',
  'ASSET_REQUEST_FORBIDDEN:',
  'ASSET_REQUEST_REVIEWED:',
  'ASSET_REQUEST_MISSING:',
  'ASSET_REQUEST_ORPHANED:',
  'ASSET_CUSTODY_DENIED:',
  'ASSET_CUSTODY_INVALID:',
  // Lifecycle guards (20260729000000 / 20260730000000)
  'ASSET_SERVICE_DENIED:',
  'ASSET_SERVICE_INVALID:',
  'ASSET_SERVICE_MISSING:',
  'ASSET_DOCUMENT_DENIED:',
  'ASSET_DOCUMENT_INVALID:',
  'ASSET_DOCUMENT_MISSING:',
  'ASSET_TRANSFER_IMMUTABLE:',
  'ASSET_ACTIVITY_IMMUTABLE:',
  'ASSET_CODE_IMMUTABLE:',
]

function guardMessage(err: AssetErrorLike): string | null {
  const raw = (err.message ?? '').trim()
  const prefix = GUARD_PREFIXES.find(p => raw.startsWith(p))
  if (!prefix) return null
  const rest = raw.slice(prefix.length).trim()
  if (!rest) return null
  return rest.endsWith('.') ? rest : `${rest}.`
}

/**
 * The one sentence to show the reader. Never returns a raw driver string:
 * anything unrecognised falls through to a generic sentence, and the real
 * error goes to the console via logAssetFailure.
 */
export function assetErrorMessage(action: AssetAction, err: AssetErrorLike): string {
  const kind = classifyAssetFailure(err)

  // A guard that already wrote a human sentence keeps it — it is more
  // specific than "you do not have permission" (e.g. which asset, and why).
  const guard = guardMessage(err)
  if (guard) return guard

  // 23505 on a request insert is the one-pending-per-asset index, not a bad
  // value, so it must not fall through to the validation sentence.
  if ((err.code ?? '') === '23505' && DUPLICATE_REQUEST_MESSAGE[action]) {
    return DUPLICATE_REQUEST_MESSAGE[action] as string
  }

  switch (kind) {
    case 'permission': return PERMISSION_MESSAGE[action]
    case 'network':    return NETWORK_MESSAGE
    case 'schema':     return SCHEMA_MESSAGE
    case 'conflict':   return CONFLICT_MESSAGE
    case 'validation': return 'One of the values entered is not valid. Check the fields and try again.'
    default:           return UNKNOWN_MESSAGE
  }
}

/**
 * Developer-facing record. Carries the action, the code and the server's own
 * message — no asset names, no form values, no user identifiers.
 */
export function logAssetFailure(action: AssetAction, err: AssetErrorLike): void {
  console.error(`[assets:${action}] failed`, {
    action,
    kind:    classifyAssetFailure(err),
    code:    err.code    ?? null,
    message: err.message ?? null,
    details: err.details ?? null,
    hint:    err.hint    ?? null,
  })
}
