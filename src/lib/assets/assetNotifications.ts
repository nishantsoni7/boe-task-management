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
    default:
      return null
  }
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
