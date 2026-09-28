// ── The full-page Edit PI: where it lives, and how it hands back ─────────────
//
// Edit PI used to be a modal over the Order (propose mode) and over the PI
// draft (apply mode). It is now a page of its own at one of two addresses, and
// every entry point navigates there. When the editor finishes, it returns to
// the record it came from with a one-word outcome the record page turns into
// its notice — nothing else travels in the URL.

import { safeFileName } from '@/lib/tasks/taskGallery'

/** The editor for an approved PI on a Confirmed Order: changes become a proposed version. */
export function editPiPageHref(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}/edit-pi`
}

/** The editor for a PI draft that is not yet an Order: changes apply to the draft. */
export function draftEditPiPageHref(submissionId: string): string {
  return `/orders/drafts/${encodeURIComponent(submissionId)}/edit-pi`
}

/** What the editor tells the record page when it returns. */
export type EditPiOutcome = 'proposed' | 'dates' | 'saved' | 'applied'

export const EDIT_PI_OUTCOME_PARAM = 'edit_pi'

export function editPiReturnHref(base: string, outcome: EditPiOutcome): string {
  return `${base}?${EDIT_PI_OUTCOME_PARAM}=${outcome}`
}

/** Reads the outcome back, accepting only the four known words. */
export function readEditPiOutcome(value: string | null | undefined): EditPiOutcome | null {
  return value === 'proposed' || value === 'dates' || value === 'saved' || value === 'applied' ? value : null
}

export const EDIT_PI_OUTCOME_NOTICE: Record<EditPiOutcome, string> = {
  proposed: 'Your changes were sent for Admin approval as a new PI version. The current PI stays in force until then.',
  dates: 'The dates were updated. They did not need a new PI version.',
  saved: 'Your edit was saved. Open Edit PI to continue it.',
  applied: 'The PI was updated.',
}

/**
 * THE NAME THE ORIGINAL EXCEL DOWNLOADS UNDER: the file name Sales uploaded,
 * when the record kept it, or a readable one — never the storage key's uuid.
 * The bytes are the stored workbook's own; only the name is chosen here.
 */
export function originalWorkbookFileName(
  version: { workbookName: string | null; versionNumber: number },
  orderNumber: string | null,
): string {
  const given = (version.workbookName ?? '').trim()
  if (given) {
    const safe = safeFileName(given, 'PI')
    return /\.(xlsx|xlsm|xls)$/i.test(safe) ? safe : `${safe}.xlsx`
  }
  const order = (orderNumber ?? '').trim()
  return safeFileName(`${order ? `Order ${order} ` : ''}PI V${version.versionNumber}.xlsx`, 'PI.xlsx')
}
