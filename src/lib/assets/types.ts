// Assets & Access — the record shapes shared by the list, the detail page and
// the pure helpers around them.
//
// These mirror the database exactly (20260726000000 / 20260727000000). Every
// field added by that migration is optional-by-nullability rather than by
// presence: an asset created before the module grew has all of them, and every
// one of them is null. "Not recorded" is a permanent, legitimate state and the
// UI must render it rather than treat it as missing data.

export type AssetStatus =
  | 'available'
  | 'assigned'
  | 'under_repair'
  | 'returned' // legacy resting state; nothing writes it since 20260722000000
  | 'lost'
  | 'retired'
  | 'disposed'

export type AssetCondition = 'new' | 'good' | 'fair' | 'poor' | 'damaged'

export type Asset = {
  id: string
  /** BOE-AST-000001. Database-generated, unique and immutable (20260726000000). */
  asset_code: string
  /** The asset's CATEGORY. Named asset_type in the database since 20260640. */
  asset_type: string
  asset_name: string
  serial_no: string | null
  specifications: string | null
  brand: string | null
  model: string | null
  description: string | null

  purchase_date: string | null
  purchase_price: number | string | null
  vendor: string | null
  invoice_number: string | null

  warranty_start_date: string | null
  warranty_expiry_date: string | null
  warranty_type: string | null
  warranty_remarks: string | null

  condition: string | null
  /** Where the asset sits when nobody holds it. Free text (20260726000000). */
  location: string | null
  /** The department the asset currently belongs to. */
  department: string | null

  status: string
  created_at: string
  updated_at: string
}

export type AssignmentStatus = 'pending_acceptance' | 'accepted' | 'returned' | 'lost'

export type EmployeeAsset = {
  id: string
  asset_id: string
  employee_id: string
  assigned_by: string
  assigned_at: string
  accepted_at: string | null
  returned_at: string | null
  lost_at: string | null
  status: string
  assets?: Asset | Asset[] | null
}

export type AssetTransferEvent =
  | 'assigned'
  | 'transferred'
  | 'returned'
  | 'marked_lost'
  | 'recovered'
  | 'sent_for_repair'
  | 'returned_from_repair'
  | 'retired'
  | 'disposed'
  | 'correction'

export type AssetTransfer = {
  id: string
  asset_id: string
  event_type: string
  from_employee_id: string | null
  to_employee_id: string | null
  from_location: string | null
  to_location: string | null
  from_department: string | null
  to_department: string | null
  transfer_date: string
  effective_date: string | null
  condition: string | null
  remarks: string | null
  /**
   * Names snapshotted at write time, so a movement still reads by name after a
   * user record is removed and the id column is nulled by its FK.
   */
  from_employee_name: string | null
  to_employee_name: string | null
  performed_by: string | null
  performed_by_name: string | null
  corrects_transfer_id: string | null
  created_at: string
}

export type AssetServiceType = 'repair' | 'maintenance' | 'inspection' | 'upgrade'

export type AssetServiceRecord = {
  id: string
  asset_id: string
  service_type: string
  issue: string | null
  description: string | null
  vendor: string | null
  sent_date: string | null
  returned_date: string | null
  next_service_date: string | null
  cost: number | string | null
  remarks: string | null
  condition_after: string | null
  status: string
  recorded_by: string | null
  created_at: string
  updated_at: string
}

export type AssetDocumentType = 'invoice' | 'warranty_card' | 'other'

export type AssetDocument = {
  id: string
  asset_id: string
  doc_type: string
  file_name: string
  storage_path: string
  mime_type: string | null
  file_size: number | null
  uploaded_by: string
  created_at: string
  removed_at: string | null
  removed_by: string | null
  removal_note: string | null
}

export type AssetActivityEntry = {
  id: string
  asset_id: string
  event_type: string
  actor_id: string | null
  from_status: string | null
  to_status: string | null
  details: Record<string, unknown>
  created_at: string
}

/** Minimal employee shape the Assets screens read. */
export type AssetEmployee = {
  id: string
  full_name: string
  role: string
  team: string | null
}

// ── Display vocabularies ─────────────────────────────────────────────────────
// One place per vocabulary, so a status reads the same on the list, the detail
// header, the timeline and a filter dropdown.

export const ASSET_STATUS_LABEL: Record<string, string> = {
  available:    'Available',
  assigned:     'Assigned',
  under_repair: 'Under Repair',
  returned:     'Returned',
  lost:         'Lost',
  retired:      'Retired',
  disposed:     'Disposed',
}

/** Statuses offered as filters, in the order an operator thinks about them. */
export const ASSET_STATUS_OPTIONS: readonly string[] = [
  'available', 'assigned', 'under_repair', 'returned', 'lost', 'retired', 'disposed',
]

export const ASSET_CONDITION_LABEL: Record<string, string> = {
  new:     'New',
  good:    'Good',
  fair:    'Fair',
  poor:    'Poor',
  damaged: 'Damaged',
}

export const ASSET_CONDITION_OPTIONS: readonly AssetCondition[] = [
  'new', 'good', 'fair', 'poor', 'damaged',
]

export const ASSET_CATEGORY_OPTIONS: readonly string[] = [
  'laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other',
]

export const ASSET_SERVICE_TYPE_LABEL: Record<string, string> = {
  repair:      'Repair',
  maintenance: 'Maintenance',
  inspection:  'Inspection',
  upgrade:     'Upgrade',
}

export const ASSET_SERVICE_TYPE_OPTIONS: readonly AssetServiceType[] = [
  'repair', 'maintenance', 'inspection', 'upgrade',
]

export const ASSET_DOCUMENT_TYPE_LABEL: Record<string, string> = {
  invoice:       'Invoice',
  warranty_card: 'Warranty Card',
  other:         'Supporting Document',
}

/** Underscored machine value → readable words, for labels with no fixed map. */
export function humanizeToken(value: string | null | undefined): string {
  if (!value) return '—'
  return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function assetStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return ASSET_STATUS_LABEL[status] ?? humanizeToken(status)
}

export function assetConditionLabel(condition: string | null | undefined): string {
  if (!condition) return 'Not recorded'
  return ASSET_CONDITION_LABEL[condition] ?? humanizeToken(condition)
}
