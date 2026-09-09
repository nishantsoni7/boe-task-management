// ORDER UPDATE NOTIFICATIONS — who is told, and what the sentence says.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// Two decisions, both pure, both testable without a database:
//
//   WHO   resolveOrderUpdateRecipients — the user ids a given Order event goes
//         to, after the configured categories and the actor-exclusion rule.
//   WHAT  describeOrderUpdate — one sentence naming the Order, what moved and
//         who moved it.
//
// NOTHING HERE AUTHORIZES ANYTHING, AND NOTHING HERE READS. The route hands in
// the candidates it read and the configuration it read; this decides. Enabling
// a category cannot show anybody an Order they could not already see: RLS
// decides that, on the Order itself, exactly as before.
//
// THE EVENT SOURCE IS `order_activity_log`, NOT A DIFF. Every action that
// matters already writes an audit row naming itself, its actor and its
// payload — status_changed, order_amended, production_alignment_changed,
// payment_verified and the rest. This module reads THOSE. There is deliberately
// no "updated_at moved, so something happened" path: a timestamp is not an
// event, and neither is a background correction or a read-state change.

import { AMENDABLE_FIELD_LABEL, describeAmendment, type AmendedActivityPayload } from './amendments'

// ── The four recipient categories ─────────────────────────────────────────────

/**
 * The closed set. The same four are the primary key of
 * `order_notification_recipients`, and a test reads the migration against this.
 *
 * WHY THESE FOUR, AND HOW EACH RESOLVES:
 *
 *   super_admin   users.designation_level = 'super_admin' — the organisational
 *                 rung, not a permission. See designationLevels.ts: a level
 *                 grants nothing, and this does not change that.
 *   admin         users.role = 'admin' — system administration.
 *   salesperson   orders.assigned_to — the ONE person named on the Order.
 *                 Required at confirmation since 20261201000000.
 *   bdm           users.team = 'bdm' — the BDM DEPARTMENT.
 *
 * THE HONEST NOTE ABOUT `bdm`. Unlike the other three this is not per-Order:
 * no column on `orders` has ever recorded a BDM and no code path has ever
 * written one, so there is no such thing as "the BDM of this Order" to resolve.
 * The department is what this database knows, so that is what the category
 * means, and the Control Center control says so in those words rather than
 * implying an association that does not exist.
 */
export const ORDER_UPDATE_RECIPIENT_ROLES = ['super_admin', 'admin', 'salesperson', 'bdm'] as const

export type OrderUpdateRecipientRole = typeof ORDER_UPDATE_RECIPIENT_ROLES[number]

export function isOrderUpdateRecipientRole(value: unknown): value is OrderUpdateRecipientRole {
  return typeof value === 'string' && (ORDER_UPDATE_RECIPIENT_ROLES as readonly string[]).includes(value)
}

/**
 * What an administrator reads beside each switch.
 *
 * `bdm` IS NAMED "BDM DEPARTMENT" AND NOT "BDM", on purpose. An administrator
 * reading a list beside "Salesperson on the Order" will read a bare "BDM" as
 * the matching per-Order person, and switch it on expecting one recipient. It
 * is the whole department, so the label says the whole department.
 */
export const ORDER_UPDATE_RECIPIENT_LABEL: Record<OrderUpdateRecipientRole, string> = {
  super_admin: 'Super Admin',
  admin:       'Admin',
  salesperson: 'Salesperson on the Order',
  bdm:         'BDM Department',
}

export const ORDER_UPDATE_RECIPIENT_DESCRIPTION: Record<OrderUpdateRecipientRole, string> = {
  super_admin: 'Everyone whose designation level is Super Admin.',
  admin:       'Everyone with system administrator access.',
  salesperson: 'The one salesperson named on that Order, and nobody else.',
  // States what it IS and then what it IS NOT, because the second half is the
  // half that gets assumed. Off by default for exactly this reason.
  bdm: 'EVERY active member of the BDM Department — not the BDM associated with this Order. No Order records a BDM of its own, so there is no per-Order BDM to resolve, and switching this on notifies the whole department about every Order.',
}

/**
 * WHAT A DATABASE WITH NO CONFIGURATION ROW BEHAVES AS — and it is the same
 * thing 20261202000000 seeds, deliberately.
 *
 * The three that name accountable people are on. `bdm` is OFF, because it
 * cannot resolve to "the BDM on this Order" — no such field exists — and so
 * resolves to the whole BDM department. On by default that would put every
 * Order's every change into the bell of every BDM, none of whom the Order
 * names.
 *
 * THESE TWO MUST AGREE. If this said `bdm: true` while the migration seeded
 * false, then a database where the row was somehow absent would fail OPEN for
 * the one category that must not — which is the precise mistake this pass
 * exists to avoid. A test reads the migration against this record.
 */
export const ORDER_UPDATE_RECIPIENTS_DEFAULT: Record<OrderUpdateRecipientRole, boolean> = {
  super_admin: true, admin: true, salesperson: true, bdm: false,
}

/**
 * Read a stored configuration into a complete record.
 *
 * A MISSING ROW FALLS BACK TO THE SEEDED DEFAULT ABOVE; a row saying
 * `enabled = false` was switched off by somebody and stays off. So an
 * undecided category behaves exactly as a freshly migrated database does —
 * which for `bdm` means silent — and an unknown key is ignored rather than
 * trusted.
 */
export function readRecipientConfig(
  rows: readonly { recipient_role?: unknown; enabled?: unknown }[] | null | undefined,
): Record<OrderUpdateRecipientRole, boolean> {
  const config = { ...ORDER_UPDATE_RECIPIENTS_DEFAULT }
  for (const row of rows ?? []) {
    if (isOrderUpdateRecipientRole(row.recipient_role)) {
      config[row.recipient_role] = row.enabled !== false
    }
  }
  return config
}

// ── Who a candidate is, to this Order ─────────────────────────────────────────

/** The columns the route reads for every person it might notify. */
export type OrderUpdateCandidate = {
  id: string
  /** users.role. */
  role?: string | null
  /** users.designation_level. */
  designation_level?: string | null
  /** users.team — the department key. */
  team?: string | null
  /** users.is_deleted. A departed employee is never notified. */
  is_deleted?: boolean | null
}

/** The only two Order columns that decide a recipient. */
export type OrderUpdateSubject = {
  /** orders.assigned_to — the salesperson. */
  assignedTo: string | null
}

/**
 * Every category this person falls into for this Order. A person can be
 * several — an administrator who is also the salesperson is both — and the
 * caller only needs to know whether ANY of them is enabled.
 */
export function orderUpdateRolesFor(
  candidate: OrderUpdateCandidate,
  order: OrderUpdateSubject,
): OrderUpdateRecipientRole[] {
  const roles: OrderUpdateRecipientRole[] = []
  if (candidate.designation_level === 'super_admin') roles.push('super_admin')
  if (candidate.role === 'admin') roles.push('admin')
  if (order.assignedTo && candidate.id === order.assignedTo) roles.push('salesperson')
  if (candidate.team === 'bdm') roles.push('bdm')
  return roles
}

export type ResolveRecipientsInput = {
  candidates: readonly OrderUpdateCandidate[]
  order: OrderUpdateSubject
  config: Record<OrderUpdateRecipientRole, boolean>
  /**
   * THE PERSON WHO PERFORMED THE UPDATE, AND THE ONE RULE THAT IS NOT
   * CONFIGURABLE. Nobody is ever told about their own action — they were
   * looking at the screen when they did it, and a notification about it is
   * noise of the purest kind. No Control Center switch can turn this off,
   * because there is no reading of "notify the actor" that anybody wants.
   *
   * Enforced HERE so the recipient list itself is honest, and AGAIN by
   * insertUserNotifications(..., { actorId }) at the single write funnel — the
   * same belt-and-braces Task Management uses. Either alone would be correct;
   * both means a new call site cannot reintroduce it.
   */
  actorId: string | null
}

/**
 * The user ids to notify: distinct, actor excluded, departed employees
 * excluded, and every remaining person matched by at least one ENABLED
 * category. Order is stable (the candidate order given), so a test and a log
 * read the same way twice.
 */
export function resolveOrderUpdateRecipients(input: ResolveRecipientsInput): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const candidate of input.candidates) {
    if (!candidate.id) continue
    if (candidate.is_deleted === true) continue
    if (input.actorId && candidate.id === input.actorId) continue
    if (seen.has(candidate.id)) continue

    const roles = orderUpdateRolesFor(candidate, input.order)
    if (!roles.some(role => input.config[role])) continue

    seen.add(candidate.id)
    out.push(candidate.id)
  }

  return out
}

// ── The events, and the sentence each one produces ────────────────────────────

/**
 * The four notification types, and the `order_activity_log` event types each
 * one is raised from.
 *
 * THE MAP IS THE DEFINITION OF "MEANINGFUL". An activity event that is not
 * listed here raises no notification — `order_product_codes_assigned`,
 * `order_created_from_pi_submission` and every future bookkeeping row included.
 * Adding one is a deliberate edit to this table, which is exactly the review
 * anybody should have to pass to put a row in somebody's bell.
 */
export const ORDER_UPDATE_EVENTS = {
  status: {
    type: 'order_update_status',
    activityTypes: ['status_changed'],
  },
  amended: {
    type: 'order_update_amended',
    activityTypes: [
      'order_amended',
      'order_client_details_amended',
      'order_schedule_terms_amended',
      'order_products_amended',
      'order_billing_percentage_amended',
      'order_workbook_replaced',
    ],
  },
  production: {
    type: 'order_update_production',
    activityTypes: ['production_alignment_changed'],
  },
  payment: {
    type: 'order_update_payment',
    activityTypes: ['payment_verified', 'payment_rejected', 'payment_linked', 'payment_unlinked'],
  },
} as const satisfies Record<string, { type: string; activityTypes: readonly string[] }>

export type OrderUpdateEvent = keyof typeof ORDER_UPDATE_EVENTS

export const ORDER_UPDATE_EVENT_KEYS = Object.keys(ORDER_UPDATE_EVENTS) as OrderUpdateEvent[]

export function isOrderUpdateEvent(value: unknown): value is OrderUpdateEvent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ORDER_UPDATE_EVENTS, value)
}

/** The four `notification_type` values, for the feed filter and the unread read. */
export const ORDER_UPDATE_NOTIFICATION_TYPES =
  ORDER_UPDATE_EVENT_KEYS.map(key => ORDER_UPDATE_EVENTS[key].type)

/** Every activity event that can raise a notification, flattened. */
export function activityTypesForEvent(event: OrderUpdateEvent): readonly string[] {
  return ORDER_UPDATE_EVENTS[event].activityTypes
}

// ── Wording ───────────────────────────────────────────────────────────────────

const ORDER_STATUS_LABEL: Record<string, string> = {
  running:            'Running',
  on_hold:            'On Hold',
  ready_for_dispatch: 'Ready for Dispatch',
  dispatched:         'Dispatched',
  cancelled:          'Cancelled',
}

function statusLabel(value: unknown): string {
  const key = typeof value === 'string' ? value : ''
  return ORDER_STATUS_LABEL[key] ?? (key || 'an unknown state')
}

/** ₹1,50,000.00 — the Indian grouping every money figure in BOE already uses. */
function rupees(value: unknown): string | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const trimmed = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

export type OrderUpdateActivity = {
  event_type: string
  payload: Record<string, unknown>
}

export type OrderUpdateMessage = {
  /** The `notification_type` to store. */
  type: string
  /** The one-line title a recipient reads. */
  title: string
  /** The quieter second line, or null. */
  body: string | null
}

/**
 * ONE SENTENCE: the Order number, what changed, and who changed it.
 *
 *   "BOE-147 status changed from Running to Dispatched by Ashok."
 *   "BOE-147 due date changed from 24 Sep 2026 to 28 Sep 2026 by Nitish."
 *   "Payment of ₹1,50,000.00 verified for BOE-147 by Nishant."
 *
 * EVERY WORD COMES FROM THE STORED ACTIVITY ROW AND FROM THIS FILE. The caller
 * supplies no text at all: an actor who could write their own notification body
 * could write anything into everybody else's bell.
 *
 * OLD AND NEW VALUES ARE SHOWN WHERE THEY ARE SAFE AND SHORT — a status, a
 * date, a lead source. They are NOT shown for free text: a client name or a
 * note can be long, can contain anything somebody typed, and belongs on the
 * page rather than in a one-line summary. Those changes say the field moved
 * and leave the detail to the Activity trail, which is where the audit lives.
 *
 * Returns null when the row says nothing worth sending, which is a normal
 * answer and never an error.
 */
export function describeOrderUpdate(
  event: OrderUpdateEvent,
  orderNumber: string,
  actorName: string | null,
  activity: OrderUpdateActivity,
): OrderUpdateMessage | null {
  const type = ORDER_UPDATE_EVENTS[event].type
  const by = actorName ? ` by ${actorName}` : ''
  const p = activity.payload ?? {}

  switch (event) {
    case 'status': {
      const from = statusLabel(p.from)
      const to = statusLabel(p.to)
      if (p.from === p.to) return null
      const reason = trimmed(p.reason)
      return {
        type,
        title: `${orderNumber} status changed from ${from} to ${to}${by}.`,
        body: reason ? `Reason: ${reason}` : null,
      }
    }

    case 'production': {
      const to = p.to === 'aligned' ? 'aligned for production' : 'moved back to not aligned'
      return {
        type,
        title: `${orderNumber} was ${to}${by}.`,
        body: trimmed(p.note),
      }
    }

    case 'payment': {
      const amount = rupees(p.allocated_amount) ?? rupees(p.payment_amount) ?? rupees(p.amount)
      const money = amount ? `Payment of ${amount}` : 'A payment'
      const verb =
        activity.event_type === 'payment_verified' ? 'verified for'
        : activity.event_type === 'payment_rejected' ? 'rejected for'
        : activity.event_type === 'payment_unlinked' ? 'unlinked from'
        : 'linked to'
      const ref = trimmed(p.human_payment_id) ?? trimmed(p.request_number)
      return {
        type,
        title: `${money} ${verb} ${orderNumber}${by}.`,
        body: ref ? `Payment ${ref}` : null,
      }
    }

    case 'amended': {
      // The amendment payload names every field that moved, with from/to.
      // describeAmendment already words those lines for the Activity trail; the
      // notification names the fields and shows the values only for the short,
      // safe ones.
      const changes = (p as AmendedActivityPayload).changes ?? {}
      const keys = Object.keys(changes)

      if (keys.length === 0) {
        // Not an amendment payload — a workbook replacement, a product edit, a
        // billing-percentage change. Each names itself.
        const what =
          activity.event_type === 'order_workbook_replaced'          ? 'PI workbook was replaced'
          : activity.event_type === 'order_products_amended'         ? 'products were amended'
          : activity.event_type === 'order_billing_percentage_amended' ? 'billing percentage was amended'
          : activity.event_type === 'order_client_details_amended'   ? 'client details were amended'
          : activity.event_type === 'order_schedule_terms_amended'   ? 'schedule or terms were amended'
          : 'details were amended'
        return {
          type,
          title: `${orderNumber} — ${what}${by}.`,
          body: trimmed((p as { reason?: unknown }).reason),
        }
      }

      // ONE FIELD: name it, and show the movement when the values are short and
      // safe to repeat.
      if (keys.length === 1) {
        const key = keys[0]
        const label = (AMENDABLE_FIELD_LABEL[key as keyof typeof AMENDABLE_FIELD_LABEL] ?? key.replace(/_/g, ' ')).toLowerCase()
        const line = SHOW_VALUES.has(key) ? describeAmendment(p as AmendedActivityPayload)[0] : null
        const movement = line ? line.slice(line.indexOf(':') + 1).trim() : null
        return {
          type,
          title: movement
            ? `${orderNumber} ${label} changed from ${movement.replace(' → ', ' to ')}${by}.`
            : `${orderNumber} ${label} was changed${by}.`,
          body: trimmed((p as AmendedActivityPayload).reason),
        }
      }

      // SEVERAL FIELDS: name them, and leave the values to the Activity trail.
      const labels = keys
        .map(k => (AMENDABLE_FIELD_LABEL[k as keyof typeof AMENDABLE_FIELD_LABEL] ?? k.replace(/_/g, ' ')).toLowerCase())
      return {
        type,
        title: `${orderNumber} was amended${by}: ${labels.join(', ')}.`,
        body: trimmed((p as AmendedActivityPayload).reason),
      }
    }
  }
}

/**
 * The amendable fields whose old and new values may be repeated in a one-line
 * notification.
 *
 * DATES AND THE LEAD SOURCE ONLY. Both are short, both are closed-ish
 * vocabularies, and both are exactly what somebody wants to see without
 * opening the Order — "due date changed from 24 Sep to 28 Sep" is the whole
 * message. A client name, a note or a money figure is either free text
 * somebody typed or a number that deserves its column; those say the field
 * moved and send the reader to the page.
 */
const SHOW_VALUES: ReadonlySet<string> = new Set(['confirm_date', 'due_date', 'lead_source'])
