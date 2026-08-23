// Clearing a MODULE: what it means, what it says, and what it is allowed to be
// asked for.
//
// WHY A MODULE AND NOT A CHAIN
// ----------------------------
// Test Data Cleanup (20260706000000) removes one Order, Order Request or
// payment with everything that belongs to it. That is the right shape for
// retiring a finished test transaction, and it stays.
//
// It is the wrong shape for the thing the testers actually do. Orders, PI
// Drafts, payments and allocations reference each other through eleven NO
// ACTION foreign keys; clearing a module one chain at a time means meeting
// those keys one at a time, in an order nobody can derive from the screen. And
// a standalone PI Draft — the commonest piece of test debris — is not a chain
// root at all, so until now it had no route out.
//
// NOTHING HERE IS AUTHORIZATION, AND NOTHING HERE IS A GATE. Every rule below
// decides what to RENDER and what to ASK FOR. begin_order_finance_test_reset()
// re-derives the admin check, the enabled flag, the scope, the reason, the
// exact phrase and the plan hash inside the database, under a lock, before
// anything is frozen — so a hidden control is a courtesy and a defeated one
// gets a refusal from Postgres.

// ── The two scopes ────────────────────────────────────────────────────────────

export const RESET_SCOPES = ['finance_module', 'order_finance_module'] as const
export type ResetScope = (typeof RESET_SCOPES)[number]

export function isResetScope(value: unknown): value is ResetScope {
  return typeof value === 'string' && (RESET_SCOPES as readonly string[]).includes(value)
}

/**
 * The words that have to be typed, and they are DIFFERENT ON PURPOSE.
 *
 * A single phrase for both scopes would mean the sentence somebody reads while
 * clearing Finance is the same sentence that clears every Order in the system.
 * The database checks these too — a phrase enforced only in the browser is a
 * label, not a gate — and it checks the one that belongs to the scope it was
 * asked for, so the Finance words cannot begin a full reset.
 */
export const RESET_CONFIRMATION: Record<ResetScope, string> = {
  finance_module:       'DELETE FINANCE TEST DATA',
  order_finance_module: 'DELETE ALL ORDER AND FINANCE TEST DATA',
}

export const RESET_TITLE: Record<ResetScope, string> = {
  finance_module:       'Clear All Finance Data',
  order_finance_module: 'Clear All Order and Finance Data',
}

/**
 * What each scope removes, in the words the card shows.
 *
 * IT SAYS "EVERY", AND MEANS IT. An earlier form of this feature scoped both
 * actions to records carrying is_test_data and described them as clearing the
 * module — so an administrator read one sentence, typed a phrase confirming it,
 * and got something narrower without being told. A destructive control that
 * quietly under-delivers is worse than one that refuses, because the operator
 * now believes the module is empty. These lists and the SQL behind them say the
 * same thing.
 */
export const RESET_REMOVES: Record<ResetScope, readonly string[]> = {
  finance_module: [
    'Every payment — confirmed, awaiting verification, needing clarification and rejected',
    'Every allocation of those payments, to Confirmed Orders and to PI Drafts',
    'Their proof files, their activity history and their direct Order and PI links',
    'Order and Finance notifications about them',
  ],
  order_finance_module: [
    'Everything Clear All Finance Data removes',
    'Every Confirmed Order, with its activity, amendments and generated documents',
    'Every PI Draft, with its product lines, images, activity and correction requests',
    'Retired Order Request records and their attachments',
    'The workbooks, product images, Order documents and proof files in private storage',
  ],
}

/** What each scope leaves alone, said explicitly because absence is invisible. */
export const RESET_RETAINS: Record<ResetScope, readonly string[]> = {
  finance_module: [
    'Every Confirmed Order and every PI Draft, whole',
    'Their payment figures return to zero, because the rows behind them are gone',
    'Users, permissions, Access Control and module configuration',
    'Payroll, attendance, tasks, assets and showroom data',
  ],
  order_finance_module: [
    'Users, profiles, permissions, Access Control and module configuration',
    'Payroll, attendance, tasks, assets and showroom data',
    'System settings and the migration history',
    'The cleanup claims, the durable cleanup audit and the Order-number reset audit —'
      + ' this facility never deletes its own record of what it did',
  ],
}

/**
 * Whether the Confirmed Order number series can even be OFFERED for this scope.
 *
 * Never for Finance-only. Clearing payments does not free a number, and a
 * control that appears where it cannot apply is a control somebody will one day
 * tick by reflex.
 */
export function canOfferNumberReset(scope: ResetScope): boolean {
  return scope === 'order_finance_module'
}

export const RESET_NUMBERING_NOTE: Record<ResetScope, string> = {
  finance_module:
    'Order numbering is unchanged. Clearing Finance data frees no Order number.',
  order_finance_module:
    'Order numbering is unchanged unless you tick the separate option below, which is'
    + ' refused unless every Order and every reserved number is already gone.',
}

// ── The stages, as the screen shows them ──────────────────────────────────────

/**
 * WHAT IS HAPPENING, IN ORDER. Not decoration: an interrupted reset is resumed
 * by reopening the page, and "the last stage it completed" is the one fact that
 * tells an administrator whether files are already gone.
 *
 * `frozen`, `storage_removed` and `completed` are the database's own words for
 * test_data_cleanup_claims.stage; the rest are this screen's view of a request
 * in flight.
 */
export const RESET_STAGES = [
  'preparing', 'freezing', 'removing_files',
  'removing_finance', 'removing_orders', 'verifying', 'completed',
] as const
export type ResetStage = (typeof RESET_STAGES)[number]

export const RESET_STAGE_LABEL: Record<ResetStage, string> = {
  preparing:        'Preparing cleanup',
  freezing:         'Freezing writes',
  removing_files:   'Removing files',
  removing_finance: 'Removing Finance records',
  removing_orders:  'Removing Orders and PI Drafts',
  verifying:        'Verifying cleanup',
  completed:        'Completed',
}

/** The stages this scope actually passes through. */
export function stagesFor(scope: ResetScope): readonly ResetStage[] {
  return scope === 'finance_module'
    ? ['preparing', 'freezing', 'removing_files', 'removing_finance', 'verifying', 'completed']
    : RESET_STAGES
}

/** The database's stored stage, in the same vocabulary the screen uses. */
export function stageFromClaim(stage: string | null | undefined): ResetStage {
  switch (stage) {
    case 'frozen':          return 'freezing'
    case 'storage_removed': return 'removing_files'
    case 'completed':       return 'completed'
    default:                return 'preparing'
  }
}

// ── The census ────────────────────────────────────────────────────────────────

/**
 * The counts the preview shows, in the order it shows them.
 *
 * ONE LIST, so the card, the final dialog and the result summary cannot drift
 * into naming different things. A key the server did not send is simply absent
 * from the screen rather than rendered as zero — "0 payments" and "we did not
 * ask about payments" are different sentences.
 */
export const RESET_COUNT_ORDER: readonly string[] = [
  'payments', 'payment_allocations', 'payment_proofs', 'payment_activity',
  'orders', 'order_documents', 'order_change_requests', 'order_activity',
  'order_submissions', 'order_submission_items', 'order_submission_item_images',
  'order_submission_activity', 'correction_requests',
  'order_requests', 'order_request_attachments', 'order_request_activity',
  'notifications', 'storage_objects',
]

export const RESET_COUNT_LABEL: Record<string, string> = {
  payments:                     'Payments',
  payment_allocations:          'Payment allocations',
  payment_proofs:               'Payment proof files',
  payment_activity:             'Payment activity records',
  orders:                       'Confirmed Orders',
  order_documents:              'Generated Order documents',
  order_change_requests:        'Order amendment requests',
  order_activity:               'Order activity records',
  order_submissions:            'PI Drafts',
  order_submission_items:       'PI product lines',
  order_submission_item_images: 'PI product images',
  order_submission_activity:    'PI activity records',
  correction_requests:          'Correction requests',
  order_requests:               'Retired Order Requests',
  order_request_attachments:    'Order Request attachments',
  order_request_activity:       'Order Request activity',
  notifications:                'Notifications',
  storage_objects:              'Files in storage',
}

export type ResetCounts = Record<string, number | null>

export type ResetPreview = {
  scope: ResetScope
  counts: ResetCounts
  blocking: { kind: string; label?: string; reason?: string }[]
  retained: Record<string, number>
  planHash: string
  /** Bytes, when storage could be measured. Null is "not measured", never zero. */
  storageBytes: number | null
}

/** Every count worth showing, in the fixed order, skipping what is absent. */
export function orderedCounts(counts: ResetCounts): { key: string; label: string; value: number }[] {
  return RESET_COUNT_ORDER
    .map(key => ({ key, label: RESET_COUNT_LABEL[key] ?? key, value: counts[key] }))
    .filter((row): row is { key: string; label: string; value: number } =>
      typeof row.value === 'number' && row.value > 0)
}

/** Whether this preview describes anything at all to delete. */
export function previewIsEmpty(counts: ResetCounts): boolean {
  return orderedCounts(counts).length === 0
}

/**
 * A size a person can read. Bytes are what storage reports and nobody thinks in.
 *
 * NULL IS NOT ZERO. A preview that could not measure storage says so, because
 * "0 B" would read as "there are no files" — which is the one wrong answer.
 */
export function formatStorageSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'not measured'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

// ── What the admin has to do ──────────────────────────────────────────────────

export const RESET_ACKNOWLEDGEMENT =
  'I understand this permanently deletes ALL of the records listed above from the'
  + ' connected project — verified payments included — and that it cannot be undone.'

export const NUMBER_RESET_ACKNOWLEDGEMENT =
  'I also want the Confirmed Order number series to restart at 0001.'

export type ResetIntent = {
  scope: ResetScope | null
  acknowledged: boolean
  typed: string
  reason: string
  planHash: string | null
}

/**
 * Whether the destructive button may be live at all.
 *
 * FOUR THINGS, ALL OF THEM, and the phrase is compared exactly — not trimmed to
 * fit, not case-folded, not "close enough". The database checks it again; this
 * is only what stops the button being pressable before it can possibly work.
 */
export function readyToRun(intent: ResetIntent): boolean {
  if (!intent.scope || !isResetScope(intent.scope)) return false
  if (!intent.acknowledged) return false
  if (!intent.planHash) return false
  if (intent.reason.trim() === '') return false
  return intent.typed === RESET_CONFIRMATION[intent.scope]
}

// ── Failures ──────────────────────────────────────────────────────────────────

/**
 * The stable codes the route returns, and nothing else ever reaches the screen.
 *
 * THE DATABASE MESSAGE IS NEVER SHOWN RAW. A Postgres error carries the
 * statement's own text — column names, ids, occasionally a value — and none of
 * it is anything an administrator can act on. The route reads which marker the
 * error contains and returns one of these.
 */
export type ResetFailureCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'DISABLED'
  | 'SCOPE_INVALID'
  | 'REASON_REQUIRED'
  | 'CONFIRMATION_INVALID'
  | 'PLAN_STALE'
  | 'BLOCKED'
  | 'IN_PROGRESS'
  | 'CLAIM_INVALID'
  | 'STORAGE_FAILED'
  | 'SCOPE_CHANGED'
  | 'NUMBER_RESET_REFUSED'
  | 'RESET_FAILED'

const FAILURE_COPY: Record<ResetFailureCode, { message: string; retryable: boolean }> = {
  UNAUTHORIZED: {
    message: 'Your session has expired. Sign in again and try once more.', retryable: false },
  FORBIDDEN: {
    message: 'Only an active administrator can clear Order and Finance data.', retryable: false },
  DISABLED: {
    message: 'Test Data Cleanup has been permanently disabled on this project. Nothing can be cleared.',
    retryable: false },
  SCOPE_INVALID: {
    message: 'That is not a cleanup action.', retryable: false },
  REASON_REQUIRED: {
    message: 'Enter why this data is being cleared.', retryable: false },
  CONFIRMATION_INVALID: {
    message: 'The confirmation phrase does not match exactly. Nothing was deleted.', retryable: false },
  // NOT AN ERROR, AND THE COMMONEST ONE: somebody left the page open while
  // records changed. The numbers are re-read and shown again.
  PLAN_STALE: {
    message: 'The records in scope changed since this preview was taken. The counts have been'
      + ' refreshed — review them and confirm again.', retryable: true },
  // A COMPLETENESS FAILURE, not a classification one. The scope is the module,
  // so nothing inside it can refuse a delete — this fires when something names a
  // record in scope and is not itself in the list, which a correct census makes
  // impossible and a future schema change would make possible.
  BLOCKED: {
    message: 'Something outside this cleanup still refers to a record inside it, so nothing was cleared.',
    retryable: false },
  IN_PROGRESS: {
    message: 'A cleanup is already running. Wait for it to finish, or reopen this page to resume it.',
    retryable: false },
  CLAIM_INVALID: {
    message: 'This cleanup is no longer valid. Start again from the preview.', retryable: false },
  // TRUTHFUL RATHER THAN REASSURING. Object removal is idempotent, so running it
  // again converges instead of compounding — which is what makes the retry safe.
  STORAGE_FAILED: {
    message: 'Some files could not be removed, so no record was deleted. This cleanup is reserved —'
      + ' run it again to finish it.', retryable: true },
  SCOPE_CHANGED: {
    message: 'The records in scope are no longer the ones that were frozen. Nothing was deleted.',
    retryable: true },
  NUMBER_RESET_REFUSED: {
    message: 'The records were cleared, but the Order number series was left unchanged because'
      + ' something that uses a number still exists.', retryable: false },
  RESET_FAILED: {
    message: 'The cleanup did not complete. Nothing was deleted — please try again.', retryable: true },
}

/** The markers the RPCs raise, longest-first where one contains another. */
const RPC_MARKERS: readonly { marker: string; code: ResetFailureCode }[] = [
  { marker: 'CLEANUP_CONFIRMATION_INVALID', code: 'CONFIRMATION_INVALID' },
  { marker: 'CLEANUP_REASON_REQUIRED',      code: 'REASON_REQUIRED' },
  { marker: 'CLEANUP_DISABLED',             code: 'DISABLED' },
  { marker: 'RESET_CLAIMED_BY_OTHER',       code: 'IN_PROGRESS' },
  { marker: 'RESET_CLAIM_RELEASED',         code: 'CLAIM_INVALID' },
  { marker: 'RESET_CLAIM_INVALID',          code: 'CLAIM_INVALID' },
  { marker: 'RESET_STORAGE_INCOMPLETE',     code: 'STORAGE_FAILED' },
  { marker: 'RESET_SCOPE_CHANGED',          code: 'SCOPE_CHANGED' },
  { marker: 'RESET_SCOPE_INVALID',          code: 'SCOPE_INVALID' },
  { marker: 'RESET_PLAN_STALE',             code: 'PLAN_STALE' },
  { marker: 'RESET_BLOCKED',                code: 'BLOCKED' },
  { marker: 'RESET_FORBIDDEN',              code: 'FORBIDDEN' },
  { marker: 'ORDER_NUMBER_RESET_',          code: 'NUMBER_RESET_REFUSED' },
  { marker: 'Authentication required',      code: 'UNAUTHORIZED' },
]

export function classifyResetError(error: unknown): ResetFailureCode {
  const raw = typeof error === 'string'
    ? error
    : String((error as { message?: unknown } | null)?.message ?? '')
  return RPC_MARKERS.find(entry => raw.includes(entry.marker))?.code ?? 'RESET_FAILED'
}

export function isResetFailureCode(value: unknown): value is ResetFailureCode {
  return typeof value === 'string' && value in FAILURE_COPY
}

export type ResetFailure = { code: ResetFailureCode; message: string; retryable: boolean }

export function describeResetFailure(code: unknown, detail?: unknown): ResetFailure {
  const known: ResetFailureCode = isResetFailureCode(code) ? code : 'RESET_FAILED'
  const copy = FAILURE_COPY[known]
  if (known !== 'BLOCKED') return { code: known, ...copy }
  const reasons = Array.isArray(detail)
    ? detail
        .map(entry => (entry as { label?: unknown; reason?: unknown } | null))
        .map(entry => typeof entry?.reason === 'string' ? entry.reason : null)
        .filter((reason): reason is string => reason !== null)
    : []
  return reasons.length === 0
    ? { code: known, ...copy }
    : { code: known, ...copy, message: `${copy.message} ${[...new Set(reasons)].join(' ')}` }
}

// ── The project this is pointed at ────────────────────────────────────────────

/**
 * The Supabase project reference, and NOTHING ELSE about the connection.
 *
 * WHY THIS IS ON SCREEN AT ALL. This facility empties a module. An
 * administrator who has three environments open needs to see which one they are
 * about to clear without reading a URL bar, and "the connected project" is not
 * an answer.
 *
 * WHY IT IS ONLY THE REF. The ref names the project and authorizes nothing —
 * it is in every public URL the app already serves. The host, the region, the
 * anon key and the service key are none of a screen's business, and the route
 * derives this server-side so no key ever travels to produce it.
 *
 * Returns null rather than guessing when the URL is not the shape it expects,
 * and the screen fails closed on null: an environment that cannot be identified
 * is not one to run this against.
 */
export function projectRefFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const match = /^https:\/\/([a-z0-9-]{8,})\.supabase\.(co|in|net)\/?$/i.exec(url.trim())
  return match ? match[1].toLowerCase() : null
}
