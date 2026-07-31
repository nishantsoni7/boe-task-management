// Asset change requests — the rules a non-admin's Request Edit / Request
// Removal has to satisfy, kept out of the page so they can be tested.
//
// Storage and approval live in
// supabase/migrations/20260724000000_asset_change_requests.sql. Everything
// here is client-side shaping and pre-validation: the database re-checks all
// of it, and the definer functions are the only thing that can actually move
// an asset.

export type AssetChangeRequestType = 'edit' | 'remove'
export type AssetChangeRequestStatus = 'pending' | 'approved' | 'rejected'

export type AssetChangeRequest = {
  id: string
  asset_id: string | null
  asset_name_snapshot: string
  request_type: AssetChangeRequestType
  requested_by: string
  reason: string
  proposed_asset_type: string | null
  proposed_asset_name: string | null
  proposed_serial_no: string | null
  proposed_specifications: string | null
  status: AssetChangeRequestStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  updated_at: string
}

export const REQUEST_STATUS_LABEL: Record<AssetChangeRequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

export const REQUEST_STATUS_BADGE: Record<AssetChangeRequestStatus, string> = {
  pending: 'boe-badge-pending',
  approved: 'boe-badge-completed',
  rejected: 'boe-badge-urgent',
}

export const REQUEST_TYPE_LABEL: Record<AssetChangeRequestType, string> = {
  edit: 'Edit',
  remove: 'Removal',
}

/**
 * Does this person already have an open request of this type against this
 * asset? Mirrors the partial unique index, so the UI can show "Edit
 * requested" instead of letting the insert fail on a constraint.
 */
export function hasPendingRequest(
  requests: Pick<AssetChangeRequest, 'asset_id' | 'requested_by' | 'request_type' | 'status'>[],
  assetId: string,
  requestedBy: string,
  type: AssetChangeRequestType,
): boolean {
  return requests.some(r =>
    r.status === 'pending' &&
    r.asset_id === assetId &&
    r.requested_by === requestedBy &&
    r.request_type === type,
  )
}

export type AssetEditableFields = {
  asset_type: string
  asset_name: string
  serial_no: string | null
  specifications: string | null
}

export type ProposedAssetFields = {
  proposed_asset_type: string | null
  proposed_asset_name: string | null
  proposed_serial_no: string | null
  proposed_specifications: string | null
}

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim()
}

/**
 * Only what the requester actually changed. A field left alone is proposed as
 * NULL, which the approval function reads as "leave this one" — so an
 * approved edit can only move the fields the request names.
 *
 * Consequence worth knowing: because NULL means "unchanged", this route
 * cannot blank an existing serial number or specification. Clearing a field
 * stays an admin's direct edit.
 */
export function buildProposedFields(
  current: AssetEditableFields,
  draft: AssetEditableFields,
): ProposedAssetFields {
  const changed = (next: string | null, prev: string | null) =>
    normalise(next) !== normalise(prev) && normalise(next) !== '' ? normalise(next) : null

  return {
    proposed_asset_type:     changed(draft.asset_type, current.asset_type),
    proposed_asset_name:     changed(draft.asset_name, current.asset_name),
    proposed_serial_no:      changed(draft.serial_no, current.serial_no),
    proposed_specifications: changed(draft.specifications, current.specifications),
  }
}

export function hasAnyProposedChange(proposed: ProposedAssetFields): boolean {
  return Object.values(proposed).some(v => v !== null)
}

/**
 * Why this request cannot be submitted yet, or null when it can. Matches the
 * table's CHECK constraints so the reader is corrected in the form rather
 * than by a constraint violation.
 */
export function validateChangeRequest(input: {
  type: AssetChangeRequestType
  reason: string
  proposed?: ProposedAssetFields
}): string | null {
  if (normalise(input.reason) === '') {
    return 'A reason is required.'
  }
  if (input.type === 'edit') {
    if (!input.proposed || !hasAnyProposedChange(input.proposed)) {
      return 'Change at least one field before submitting the request.'
    }
  }
  return null
}

/** Human summary of what an edit request would change, for the review list. */
export function describeProposedChanges(request: AssetChangeRequest): string[] {
  const lines: string[] = []
  if (request.proposed_asset_name)     lines.push(`Name → ${request.proposed_asset_name}`)
  if (request.proposed_asset_type)     lines.push(`Type → ${request.proposed_asset_type.replace(/_/g, ' ')}`)
  if (request.proposed_serial_no)      lines.push(`Serial No. → ${request.proposed_serial_no}`)
  if (request.proposed_specifications) lines.push(`Specifications → ${request.proposed_specifications}`)
  return lines
}

/** A reviewed request can never be reviewed again. */
export function canReviewRequest(request: Pick<AssetChangeRequest, 'status'>): boolean {
  return request.status === 'pending'
}
