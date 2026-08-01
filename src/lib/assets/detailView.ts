// Asset detail — presentation arithmetic for the record page.
//
// This module decides NOTHING about authorization or lifecycle. It is handed a
// map of "may this person do this to this asset right now", already computed by
// the page from `caps` AND the asset's state, and it only answers a layout
// question: which of those actions belongs on the surface, which belongs in the
// overflow menu, and which sits behind the destructive divider.
//
// It lives here rather than inline in the page for one reason: an action that
// silently falls out of every group disappears from the UI while every
// permission check still passes, which is the kind of regression a screenshot
// never catches. assetActionLayout() is total by construction (the three order
// lists together are exactly AssetActionKey) and the test asserts that.

import type { EmployeeAsset } from './types'

/** Every operation the asset record page can offer. One key per button. */
export type AssetActionKey =
  | 'assign'
  | 'transfer'
  | 'markReturned'
  | 'closeService'
  | 'recover'
  | 'restore'
  | 'sendRepair'
  | 'addService'
  | 'warranty'
  | 'uploadInvoice'
  | 'uploadWarrantyCard'
  | 'edit'
  | 'requestEdit'
  | 'requestRemoval'
  | 'markLost'
  | 'retire'
  | 'dispose'
  | 'delete'

/** The words on the control. Same vocabulary the page used before the redesign. */
export const ASSET_ACTION_LABEL: Record<AssetActionKey, string> = {
  assign:             'Assign Asset',
  transfer:           'Transfer Asset',
  markReturned:       'Mark Returned',
  closeService:       'Record Return from Service',
  recover:            'Record Recovery',
  restore:            'Restore to Service',
  sendRepair:         'Send for Repair',
  addService:         'Add Repair / Service',
  warranty:           'Add Warranty Details',
  uploadInvoice:      'Upload Invoice',
  uploadWarrantyCard: 'Upload Warranty Card',
  edit:               'Edit Asset',
  requestEdit:        'Request Edit',
  requestRemoval:     'Request Removal',
  markLost:           'Mark Lost',
  retire:             'Retire Asset',
  dispose:            'Dispose Asset',
  delete:             'Delete Asset',
}

/**
 * PRIMARY — the custody moves that answer "what happens to this asset next".
 * At most a handful are ever true at once, because each is gated on a different
 * asset state: an available asset offers Assign/Transfer, an assigned one
 * Mark Returned, a lost one Record Recovery, one away for service Record
 * Return from Service, a retired one Restore.
 */
const PRIMARY_ORDER: readonly AssetActionKey[] = [
  'assign', 'transfer', 'markReturned', 'closeService', 'recover', 'restore',
]

/** MORE — record-keeping. Always available to whoever holds the permission. */
const MORE_ORDER: readonly AssetActionKey[] = [
  'sendRepair', 'addService', 'warranty',
  'uploadInvoice', 'uploadWarrantyCard',
  'edit', 'requestEdit', 'requestRemoval',
]

/**
 * DANGER — below a divider at the bottom of the overflow menu. These end or
 * write off the asset's life, and Delete is last because it is the only one
 * that leaves no record behind.
 */
const DANGER_ORDER: readonly AssetActionKey[] = [
  'markLost', 'retire', 'dispose', 'delete',
]

export type AssetActionAvailability = Record<AssetActionKey, boolean>

export type AssetActionLayout = {
  /** Rendered as buttons beside the summary card. */
  primary: AssetActionKey[]
  /** Rendered as menu items in More Actions. */
  more: AssetActionKey[]
  /** Rendered after a divider, at the bottom of More Actions. */
  danger: AssetActionKey[]
}

/** True when the overflow trigger has anything at all to show. */
export function hasOverflowActions(layout: AssetActionLayout): boolean {
  return layout.more.length > 0 || layout.danger.length > 0
}

/**
 * Split the available actions into the three groups, preserving group order.
 *
 * An action the caller marked unavailable is absent everywhere — this function
 * never widens what it was given.
 */
export function assetActionLayout(available: AssetActionAvailability): AssetActionLayout {
  const pick = (order: readonly AssetActionKey[]) => order.filter(key => available[key])
  return {
    primary: pick(PRIMARY_ORDER),
    more:    pick(MORE_ORDER),
    danger:  pick(DANGER_ORDER),
  }
}

/** Every key this module knows about, in render order. Exported for the test. */
export const ALL_ASSET_ACTION_KEYS: readonly AssetActionKey[] = [
  ...PRIMARY_ORDER, ...MORE_ORDER, ...DANGER_ORDER,
]

// ── Tab counts ───────────────────────────────────────────────────────────────

export type AssetDetailCounts = {
  /** Movement rows plus custody periods — both are listed on that tab. */
  assignments: number
  service: number
  /** ACTIVE documents only; a soft-removed row is history, not a file. */
  documents: number
  activity: number
}

/**
 * Counts for the tab strip.
 *
 * Every number is the length of a list the page has ALREADY loaded, so a badge
 * can never disagree with what the tab shows and no extra query is issued to
 * produce one. There is deliberately no count on Overview: it is a view of the
 * record, not a list of rows.
 */
export function assetDetailTabCounts(input: {
  transfers: readonly unknown[]
  assignments: readonly unknown[]
  services: readonly unknown[]
  activeDocuments: readonly unknown[]
  activity: readonly unknown[]
}): AssetDetailCounts {
  return {
    assignments: input.transfers.length + input.assignments.length,
    service:     input.services.length,
    documents:   input.activeDocuments.length,
    activity:    input.activity.length,
  }
}

// ── Missing data ─────────────────────────────────────────────────────────────

/**
 * A stored text value, or null when there is nothing to show.
 *
 * Null is the signal to render a muted dash. Repeating "Not recorded" down a
 * whole column turns a page about one asset into a page about what nobody
 * filled in; the dash says the same thing without shouting it.
 */
export function optionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// ── Warranty: recorded at all? ───────────────────────────────────────────────

/**
 * Whether ANY warranty field has been filled in.
 *
 * Deliberately not the same question as warrantyStatus() !== 'not_available'.
 * That one asks only about the EXPIRY date, because expiry is the only thing a
 * status can be derived from. An asset can carry a start date, a warranty type
 * and remarks with no expiry recorded, and showing an "add warranty details"
 * empty state over the top of those would hide data somebody entered.
 */
export function hasWarrantyDetails(asset: {
  warranty_start_date: string | null
  warranty_expiry_date: string | null
  warranty_type: string | null
  warranty_remarks: string | null
}): boolean {
  return [
    asset.warranty_start_date,
    asset.warranty_expiry_date,
    asset.warranty_type,
    asset.warranty_remarks,
  ].some(value => optionalText(value) !== null)
}

// ── The one date the summary states ──────────────────────────────────────────

export type AssetSummaryDate = { label: string; iso: string | null }

/**
 * The date the summary card carries beside the custodian.
 *
 * An asset someone holds is described by WHEN they got it; one nobody holds is
 * described by when the record was created. Both come from columns that always
 * exist, so this never invents a date — and it never labels created_at as an
 * assignment date, which is the mistake it exists to prevent.
 */
export function assetSummaryDate(
  asset: { created_at: string },
  openAssignment: Pick<EmployeeAsset, 'assigned_at'> | null,
): AssetSummaryDate {
  if (openAssignment) return { label: 'Assigned', iso: openAssignment.assigned_at ?? null }
  return { label: 'Added', iso: asset.created_at ?? null }
}
