// Asset detail — shared query shapes and the current-custodian rule.
//
// The column lists live here rather than inline in each page so the inventory
// and the detail page cannot drift apart on what an asset row contains (they
// diverged once already: asset_code would have been added to one and not the
// other). They are also the reason a test can assert, without a database, that
// no asset query ever reaches for access_records or secret_value.

/**
 * Everything the inventory and the detail page read from `assets`.
 *
 * The master-detail block (brand … warranty_remarks, 20260728000000) is read by
 * BOTH screens on purpose: the list filters on category, condition, warranty
 * and purchase date, and filtering client-side on a column the query did not
 * fetch is the classic way to produce a filter that silently matches nothing.
 */
export const ASSET_COLUMNS = [
  'id', 'asset_code', 'asset_type', 'asset_name', 'serial_no', 'specifications',
  'location', 'department', 'status', 'condition',
  'brand', 'model', 'description',
  'purchase_date', 'purchase_price', 'vendor', 'invoice_number',
  'warranty_start_date', 'warranty_expiry_date', 'warranty_type', 'warranty_remarks',
  'created_at', 'updated_at',
].join(', ')

/** One movement record (20260729000000). */
export const ASSET_TRANSFER_COLUMNS = [
  'id', 'asset_id', 'event_type',
  'from_employee_id', 'to_employee_id', 'from_location', 'to_location',
  'from_department', 'to_department',
  'transfer_date', 'effective_date', 'condition', 'remarks',
  'from_employee_name', 'to_employee_name',
  'performed_by', 'performed_by_name', 'corrects_transfer_id', 'created_at',
].join(', ')

/** One repair/service record (20260729000000). */
export const ASSET_SERVICE_COLUMNS = [
  'id', 'asset_id', 'service_type', 'issue', 'description', 'vendor',
  'sent_date', 'returned_date', 'next_service_date', 'cost',
  'remarks', 'condition_after', 'status', 'recorded_by', 'created_at', 'updated_at',
].join(', ')

/** One document row. storage_path is read so a signed URL can be minted. */
export const ASSET_DOCUMENT_COLUMNS = [
  'id', 'asset_id', 'doc_type', 'file_name', 'storage_path', 'mime_type', 'file_size',
  'uploaded_by', 'created_at', 'removed_at', 'removed_by', 'removal_note',
].join(', ')

/**
 * One custody period, including its handover record (20261029000000).
 *
 * The six handover columns are read by BOTH screens for the same reason the
 * asset master block is: the employee's Accept dialog shows the condition,
 * accessories and existing issues, and the asset detail page prints the same
 * facts onto the Handover Sheet. A list that fetched them on one screen and not
 * the other is how a printout ends up saying "Not recorded" about something
 * that was.
 *
 * `accepted_terms` is the stored snapshot, not a secret — it is the text the
 * employee was shown, and the sheet has to reproduce it verbatim.
 */
export const EMPLOYEE_ASSET_COLUMNS = [
  'id', 'asset_id', 'employee_id', 'assigned_by',
  'assigned_at', 'accepted_at', 'returned_at', 'lost_at', 'status',
  'handover_condition', 'handover_accessories', 'handover_existing_issues',
  'accepted_by', 'acceptance_version', 'accepted_terms',
].join(', ')

/** One activity row. */
export const ASSET_ACTIVITY_COLUMNS =
  'id, asset_id, asset_code_snapshot, asset_name_snapshot, event_type, actor_id, employee_id, event_at, summary, details, source_type, source_id, created_at'

/**
 * Who or what currently holds this asset.
 *
 * The module's standing rule: an asset must never read as "Assigned" without
 * naming someone. An open custody period (pending_acceptance or accepted) wins
 * over the location field — the person is where the asset actually is, and the
 * location column describes where it sits when nobody has it. `location` is
 * free text for this phase; there is no locations table and no
 * employee-to-location transfer.
 */
export type AssetCustodian =
  | { kind: 'employee'; label: string }
  | { kind: 'location'; label: string }
  | { kind: 'unknown';  label: string }

export type CustodianInput = {
  /** The employee's display name, when an assignment is open. */
  employeeName?: string | null
  /** True when an employee_assets row is pending_acceptance or accepted. */
  hasOpenAssignment: boolean
  /** assets.location — free text, may be blank. */
  location?: string | null
}

export function resolveAssetCustodian(input: CustodianInput): AssetCustodian {
  if (input.hasOpenAssignment) {
    const name = input.employeeName?.trim()
    // An open assignment with an unresolvable name is still custody by a
    // person — saying "Assigned employee" is honest, falling back to a
    // location would not be.
    return { kind: 'employee', label: name && name !== '' ? name : 'Assigned employee' }
  }

  const location = input.location?.trim()
  if (location && location !== '') return { kind: 'location', label: location }

  return { kind: 'unknown', label: 'No location set' }
}

/** True while an employee_assets row describes custody that has not ended. */
export function isOpenAssignment(status: string | null | undefined): boolean {
  return status === 'pending_acceptance' || status === 'accepted'
}
