// Assets & Access notifications — who is told what, decided in one place.
//
// The recipient rules are the part of a notification system that is easy to get
// wrong and impossible to notice going wrong: nobody reports a notification
// they never received. So they live here as pure functions, tested directly,
// and /api/assets/notify only resolves ids and writes rows.
//
// TWO RULES GOVERN EVERYTHING BELOW:
//
//   1. The actor is never notified about their own action. Someone who just
//      clicked "Mark Returned" does not need to be told an asset was returned.
//      Filtering happens at the API boundary (one place, not per event) so a
//      new event cannot forget it.
//   2. Only changes to OWNERSHIP, ASSIGNMENT, TRANSFERS, REQUESTS, STATUS,
//      LOSS, RECOVERY, RETURN, REPAIR or WARRANTY EXPIRY produce a
//      notification. Editing a serial number or a description does not — those
//      are metadata corrections, they are already in the activity history, and
//      notifying on them would train people to ignore the bell.

export const ASSET_NOTIFICATION_EVENTS = [
  'asset_request_submitted',
  'asset_request_approved',
  'asset_request_rejected',
  'asset_edit_request_submitted',
  'asset_edit_request_approved',
  'asset_edit_request_rejected',
  'asset_assigned',
  'asset_transferred',
  'asset_transfer_acknowledged',
  'asset_returned',
  'asset_lost',
  'asset_recovered',
  'asset_repair_sent',
  'asset_repair_returned',
  'asset_warranty_expiring',
  // Added 20260802000000 — see that migration for why each exists.
  'asset_edited',
  'asset_warranty_updated',
  'asset_service_added',
  'asset_document_uploaded',
  'asset_retired',
  'asset_disposed',
  'asset_restored',
  'access_granted',
  'access_updated',
  'access_revoked',
  'access_restored',
] as const

export type AssetNotifyEvent = typeof ASSET_NOTIFICATION_EVENTS[number]

export function isAssetNotifyEvent(value: unknown): value is AssetNotifyEvent {
  return typeof value === 'string' && (ASSET_NOTIFICATION_EVENTS as readonly string[]).includes(value)
}

/** Who a given event is sent to, expressed as roles rather than ids. */
export type RecipientRole =
  /** Every administrator. */
  | 'admins'
  /** The person who now holds the asset. */
  | 'new_custodian'
  /** The person who held it before this event. */
  | 'previous_custodian'
  /** Whoever raised the change request. */
  | 'requester'
  /** Whoever opened the assignment being acknowledged. */
  | 'assigner'
  /** The employee an access record belongs to. */
  | 'access_holder'

export type AssetNotifyContext = {
  /** Asset name, for the notification title. */
  assetName: string
  /** Asset code, so the record can be located from the title alone. */
  assetCode?: string | null
  /** Display name of the person taking custody, when there is one. */
  toName?: string | null
  /** Display name of the person losing custody, when there is one. */
  fromName?: string | null
  /** Where the asset went, when it went to a place rather than a person. */
  toLocation?: string | null
  /** Vendor for a repair event. */
  vendor?: string | null
  /** Days until warranty expiry, for the warranty reminder. */
  daysToExpiry?: number | null
  /** 'edit' | 'remove' — which kind of change request this is about. */
  requestType?: string | null
  /** Free-text note an admin left when rejecting. */
  note?: string | null
  /** 'invoice' | 'warranty_card' | 'other' — which document was attached. */
  documentKind?: string | null
  /** The system an access record is for, e.g. "Canva". */
  accessLabel?: string | null
  /** Display name of the person taking the action, for access events. */
  actorName?: string | null
}

/** Document type → the words used in a notification title. */
const DOCUMENT_KIND_LABEL: Record<string, string> = {
  invoice:       'Invoice',
  warranty_card: 'Warranty card',
  other:         'Supporting document',
}

/** The access record's subject line: the system, named. */
function accessSubject(ctx: AssetNotifyContext): string {
  const label = ctx.accessLabel?.trim()
  return label && label !== '' ? label : 'A company system'
}

function subject(ctx: AssetNotifyContext): string {
  return ctx.assetCode ? `${ctx.assetName} (${ctx.assetCode})` : ctx.assetName
}

/**
 * The recipients and the title for one event.
 *
 * A title always names the ASSET, because the reader's first question is
 * "which one" — and always states what happened in the past tense, because it
 * already has.
 */
export function assetNotification(
  event: AssetNotifyEvent,
  ctx: AssetNotifyContext,
): { recipients: RecipientRole[]; title: string } {
  const s = subject(ctx)

  switch (event) {
    // ── Change requests ─────────────────────────────────────────────────────
    case 'asset_request_submitted':
      return {
        recipients: ['admins'],
        title: `Removal requested for ${s}.`,
      }
    case 'asset_edit_request_submitted':
      return {
        recipients: ['admins'],
        title: `Edit requested for ${s}.`,
      }
    case 'asset_request_approved':
      return { recipients: ['requester'], title: `Your removal request for ${s} was approved.` }
    case 'asset_request_rejected':
      return { recipients: ['requester'], title: `Your removal request for ${s} was rejected.` }
    case 'asset_edit_request_approved':
      return { recipients: ['requester'], title: `Your edit request for ${s} was approved.` }
    case 'asset_edit_request_rejected':
      return { recipients: ['requester'], title: `Your edit request for ${s} was rejected.` }

    // ── Custody ─────────────────────────────────────────────────────────────
    case 'asset_assigned':
      // Only the new holder. Nobody else has an action to take, and the person
      // who assigned it is the actor.
      return { recipients: ['new_custodian'], title: `${s} was assigned to you. Please accept it.` }

    case 'asset_transferred':
      // Both sides: one person has gained accountability, the other has lost
      // it, and both need to know without asking.
      return {
        recipients: ['new_custodian', 'previous_custodian'],
        title: ctx.toName
          ? `${s} was transferred to ${ctx.toName}.`
          : ctx.toLocation
            ? `${s} was transferred to ${ctx.toLocation}.`
            : `${s} was transferred.`,
      }

    case 'asset_transfer_acknowledged':
      // The person who handed it over is the one waiting to hear this.
      return {
        recipients: ['assigner'],
        title: ctx.fromName
          ? `${ctx.fromName} accepted ${s}.`
          : `${s} was accepted by its new custodian.`,
      }

    case 'asset_returned':
      return { recipients: ['previous_custodian'], title: `${s} was recorded as returned.` }

    case 'asset_lost':
      // Loss is an accountability event: the last holder AND administration.
      return { recipients: ['previous_custodian', 'admins'], title: `${s} was marked lost.` }

    case 'asset_recovered':
      return {
        recipients: ['new_custodian', 'admins'],
        title: `${s} was recovered${ctx.toName ? ` and is now with ${ctx.toName}` : ''}.`,
      }

    // ── Service ─────────────────────────────────────────────────────────────
    case 'asset_repair_sent':
      return {
        recipients: ['new_custodian', 'admins'],
        title: ctx.vendor
          ? `${s} was sent for service to ${ctx.vendor}.`
          : `${s} was sent for service.`,
      }

    case 'asset_repair_returned':
      return { recipients: ['new_custodian', 'admins'], title: `${s} came back from service.` }

    // ── Warranty ────────────────────────────────────────────────────────────
    case 'asset_warranty_expiring': {
      const days = ctx.daysToExpiry
      const when =
        days === null || days === undefined ? 'soon'
        : days <= 0 ? 'today'
        : `in ${days} day${days === 1 ? '' : 's'}`
      return { recipients: ['admins'], title: `Warranty for ${s} expires ${when}.` }
    }

    // ── Master details ──────────────────────────────────────────────────────
    // The CURRENT CUSTODIAN only. An edit that moved this asset's status,
    // location, department, condition or warranty dates changes what the person
    // holding it is accountable for; nobody else has an action to take, and
    // broadcasting master-data edits to every admin is exactly how a bell stops
    // being read. An asset nobody holds resolves to no recipient and writes
    // nothing — which is correct, not a gap.
    case 'asset_edited':
      return { recipients: ['new_custodian'], title: `${s} was updated.` }

    case 'asset_warranty_updated':
      return { recipients: ['new_custodian'], title: `Warranty details for ${s} were updated.` }

    // ── Service history ─────────────────────────────────────────────────────
    case 'asset_service_added':
      return {
        recipients: ['new_custodian'],
        title: ctx.vendor
          ? `A service record was added for ${s} (${ctx.vendor}).`
          : `A service record was added for ${s}.`,
      }

    // ── Documents ───────────────────────────────────────────────────────────
    case 'asset_document_uploaded': {
      const kind = DOCUMENT_KIND_LABEL[ctx.documentKind ?? ''] ?? 'Document'
      return { recipients: ['new_custodian'], title: `${kind} added to ${s}.` }
    }

    // ── End of life ─────────────────────────────────────────────────────────
    // 'admins', preserving the module's existing responsibility model rather
    // than inventing an assignment one: BOE has no designated-reviewer column,
    // any admin may act on these, and retirement is blocked while an assignment
    // is open — so there is no custodian left to tell.
    case 'asset_retired':
      return { recipients: ['admins'], title: `${s} was retired.` }

    case 'asset_disposed':
      return { recipients: ['admins'], title: `${s} was disposed.` }

    case 'asset_restored':
      return { recipients: ['admins'], title: `${s} was restored to service.` }

    // ── Access Register ─────────────────────────────────────────────────────
    // One recipient throughout: the employee whose access it is. Nobody else is
    // directly related to someone else's credentials.
    case 'access_granted':
      return { recipients: ['access_holder'], title: `${accessSubject(ctx)} access was assigned to you.` }

    case 'access_updated':
      return { recipients: ['access_holder'], title: `Your ${accessSubject(ctx)} access details were updated.` }

    case 'access_revoked':
      return {
        recipients: ['access_holder'],
        title: ctx.actorName
          ? `Your ${accessSubject(ctx)} access was revoked by ${ctx.actorName}.`
          : `Your ${accessSubject(ctx)} access was revoked.`,
      }

    case 'access_restored':
      return { recipients: ['access_holder'], title: `Your ${accessSubject(ctx)} access was restored.` }
  }
}

/**
 * The second line of the notification row — context, never a repeat of the
 * title. Returns null when there is nothing worth adding, which the shared
 * list renders as a single-line row rather than a blank second line.
 */
export function assetNotificationBody(
  event: AssetNotifyEvent,
  ctx: AssetNotifyContext,
): string | null {
  switch (event) {
    case 'asset_transferred':
      return ctx.fromName ? `Previously held by ${ctx.fromName}` : null
    case 'asset_returned':
      return ctx.toLocation ? `Now at ${ctx.toLocation}` : null
    case 'asset_edit_request_rejected':
    case 'asset_request_rejected':
      return ctx.note ? `Reason: ${ctx.note}` : null
    case 'asset_repair_returned':
      return ctx.vendor ? `Serviced by ${ctx.vendor}` : null
    case 'asset_edited':
      // Names the fields that moved, so the reader knows whether it concerns
      // them without opening the record.
      return ctx.note ? `Changed: ${ctx.note}` : null
    case 'access_granted':
      return ctx.toName ? `Username: ${ctx.toName}` : null
    default:
      return null
  }
}

/**
 * The final recipient list for one notification: real ids, actor removed,
 * each person once.
 *
 * Extracted from /api/assets/notify so the three rules that decide whether a
 * person is told anything can be asserted directly. All three are the kind that
 * fail silently — a duplicate sends two rows nobody reports, and a missing
 * actor-exclusion sends someone a notification about their own click, which
 * reads as a bug in the app rather than in this list.
 *
 * ORDER IS PRESERVED (first occurrence wins) so a notification's recipients are
 * deterministic and a test can assert them without sorting.
 *
 * The actor is compared BY ID. Never by name: two employees share a display
 * name far more often than two share a uuid, and a name comparison would
 * silently drop a real recipient.
 */
export function resolveRecipients(
  candidates: readonly (string | null | undefined)[],
  actorUserId: string | null | undefined,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of candidates) {
    if (!id) continue                 // null, undefined and '' are not people
    if (actorUserId && id === actorUserId) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * The value to store in notifications.entity_id, or null when there is no
 * record to point at.
 *
 * entity_id is a UUID column. An empty string is therefore not "no entity" to
 * Postgres — it is a malformed uuid, and it fails the whole INSERT with a
 * 22P02, losing the notification for every recipient in the batch. Callers
 * legitimately produce one: an approved REMOVAL request nulls asset_id, and
 * `row.asset_id ?? ''` then sends ''.
 *
 * Whitespace is trimmed rather than passed through, because ' <uuid> ' is
 * equally malformed and equally silent.
 */
export function normalizeNotificationEntityId(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Does this change deserve a notification at all?
 *
 * The metadata-edit rule, as a function. Called by the client before it posts,
 * so an edit that only touched a description never reaches the API — and the
 * rule is assertable rather than being an unwritten convention about which
 * call sites remembered to skip.
 */
const NOTIFIABLE_FIELDS = new Set([
  'status', 'location', 'department', 'condition',
  'warranty_expiry_date', 'warranty_start_date',
])

export function editDeservesNotification(changedFields: readonly string[]): boolean {
  return changedFields.some(f => NOTIFIABLE_FIELDS.has(f))
}

/** The master-detail columns the Edit Asset form can move. */
export type AssetEditableValues = {
  asset_type: string
  asset_name: string
  serial_no: string | null
  specifications: string | null
  brand: string | null
  model: string | null
  description: string | null
  condition: string | null
  location: string | null
}

/**
 * Which columns this edit actually moved, by DATABASE field name.
 *
 * Database names, not form names, because editDeservesNotification is expressed
 * in database columns — two vocabularies for the same fact is how a rule about
 * `condition` ends up never matching a form field called `conditionAfter`.
 *
 * A field absent from `before` counts as null, so an asset row that predates a
 * column reads as "was empty, now set" rather than as unchanged.
 */
export function changedAssetFields(
  before: Partial<Record<keyof AssetEditableValues, string | null | undefined>>,
  next: AssetEditableValues,
): string[] {
  return (Object.keys(next) as (keyof AssetEditableValues)[])
    .filter(key => (before[key] ?? null) !== (next[key] ?? null))
}

/** Notification-worthy field name → the words the notification body uses. */
const FIELD_LABEL: Record<string, string> = {
  status: 'Status', location: 'Location', department: 'Department', condition: 'Condition',
  warranty_expiry_date: 'Warranty expiry', warranty_start_date: 'Warranty start',
}

/**
 * The body line for an edit notification: the notification-worthy fields that
 * moved, named for a reader. Null when none of them did — which is also when
 * editDeservesNotification says not to notify at all, so the two agree.
 *
 * Fields that changed but are NOT notification-worthy are deliberately left
 * out: the body explains why the reader was told, and "Brand" never is.
 */
export function assetEditSummary(changedFields: readonly string[]): string | null {
  const named = changedFields.filter(f => FIELD_LABEL[f]).map(f => FIELD_LABEL[f])
  return named.length > 0 ? named.join(', ') : null
}
