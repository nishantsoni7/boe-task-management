// CURRENT STATUS — the three questions management asks before the product list.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// A Confirmed Order's position lives in four different places: the PI versions
// table, the approval event log, the product images of the approved PI, and the
// Order row itself. Somebody asking "where is this order?" had to open three
// screens to find out. This module turns what those sources ALREADY hold into
// the two read-only summaries that join the Main PI card above the product
// list.
//
// IT READS NOTHING, COMPUTES NO MONEY, AND AUTHORIZES NOTHING. Every input is
// handed in, already resolved by the module that owns it — mainPiCard for the
// PI, approvalStanding for fabric and finish, describeProductionAlignment for
// production, and the page's own label for the Order's stage. This selects,
// labels and orders.
//
// IT INVENTS NO STATUS. Where this system records nothing — CAD and technical
// drawings, a manufacturing stage, QC, packaging — the line says so in words
// and carries `unsupported`, so the screen can mute it rather than dress an
// absence up as a state. A combined "manufacturing progress" derived from a due
// date, or from the Order merely existing, is the one thing this must never
// produce: it would read as a fact and be a guess.

import {
  APPROVAL_STATUS_LABEL,
  APPROVAL_STATUS_TONE,
  type ApprovalStanding,
} from './orderApprovals'
import { isOrderClosed } from './orderWorkspace'
import type { ProductionAlignmentView } from './productionAlignment'

// ── Words ─────────────────────────────────────────────────────────────────────

export const CURRENT_STATUS_TITLE = 'Current Status'
export const DESIGN_FILES_TITLE = 'Design Files'
export const MANUFACTURING_TITLE = 'Manufacturing Status'

/** The tone vocabulary the Order status cards already spend colour from. */
export type CurrentStatusTone = 'green' | 'amber' | 'red' | 'neutral'

/**
 * A line of one card: a label, a value, and an optional quieter qualifier.
 *
 * `tone` is null where a pill would add nothing — a count is not a status — and
 * the value is ALWAYS a word, never a colour alone, so a reader who cannot tell
 * amber from red still reads what the line says.
 */
export type CurrentStatusLine = {
  key: string
  label: string
  value: string
  tone: CurrentStatusTone | null
  detail: string | null
  /** True when this system holds no record of this at all. */
  unsupported: boolean
}

// ── Design files ──────────────────────────────────────────────────────────────

export const DESIGN_FABRIC_LABEL = 'Fabric'
export const DESIGN_FINISH_LABEL = 'Finish'
export const DESIGN_IMAGES_LABEL = 'Product images'
export const DESIGN_DRAWINGS_LABEL = 'CAD & drawings'

export const DESIGN_PROOF_ON_FILE = 'Approval screenshot on file'
export const DESIGN_NO_PROOF = 'No screenshot on file'
export const DESIGN_IMAGES_NONE = 'None recorded'

/**
 * WHAT THIS BUILD DOES NOT HOLD, said plainly.
 *
 * There is no CAD table, no drawing column and no drawing bucket anywhere in
 * this system. Counting the PI workbook or a fabric screenshot as a "drawing"
 * to fill the row would put a file in front of somebody under a name it does
 * not answer to.
 */
export const DESIGN_DRAWINGS_UNSUPPORTED = 'Not recorded'
export const DESIGN_DRAWINGS_NOTE =
  'This system keeps no CAD or technical drawing records against an Order.'

export const DESIGN_FILES_READ_ONLY_NOTE =
  'Fabric and Finish are updated in the Fabric & Finish card; product pictures come from the approved PI.'

export type DesignImageCounts = {
  representative: number
  customization: number
}

export type DesignFilesView = {
  lines: CurrentStatusLine[]
  note: string
}

/** `12 files` / `1 file`, so a count never reads as a plural of one. */
function fileCount(total: number): string {
  return `${total} file${total === 1 ? '' : 's'}`
}

/**
 * The design record of one Order, as four lines.
 *
 * FABRIC AND FINISH ARE THE APPROVAL LOG'S OWN ANSWER, unchanged — the newest
 * event of each kind, exactly as the Fabric & Finish card reads it, from the
 * same standing. This is the SUMMARY of it: a status and whether a proof
 * exists, with no date, no actor, no proof button and no update control. The
 * two cannot disagree, because there is only one computation.
 *
 * THE PICTURES ARE COUNTED FROM THE ROWS, not from the URLs the page managed to
 * sign. A picture the storage policy refused this reader is still a picture the
 * Order holds, and reporting one fewer would make the count a function of who
 * is looking.
 */
export function describeDesignFiles(input: {
  approvals: ApprovalStanding
  images: DesignImageCounts
  /** How many product lines the approved PI carries, for the qualifier. */
  productCount: number
}): DesignFilesView {
  const lines: CurrentStatusLine[] = []

  for (const kind of input.approvals.kinds) {
    lines.push({
      key: kind.kind,
      label: kind.kind === 'fabric' ? DESIGN_FABRIC_LABEL : DESIGN_FINISH_LABEL,
      value: APPROVAL_STATUS_LABEL[kind.status],
      tone: APPROVAL_STATUS_TONE[kind.status],
      detail: kind.evidencePath ? DESIGN_PROOF_ON_FILE : DESIGN_NO_PROOF,
      unsupported: false,
    })
  }

  const total = input.images.representative + input.images.customization
  const acrossProducts = `${input.productCount} product line${input.productCount === 1 ? '' : 's'}`
  lines.push({
    key: 'images',
    label: DESIGN_IMAGES_LABEL,
    value: total === 0 ? DESIGN_IMAGES_NONE : fileCount(total),
    tone: null,
    detail: total === 0
      ? null
      : `${input.images.representative} representative · ${input.images.customization} customization`
        + (input.productCount > 0 ? ` · ${acrossProducts}` : ''),
    unsupported: false,
  })

  lines.push({
    key: 'drawings',
    label: DESIGN_DRAWINGS_LABEL,
    value: DESIGN_DRAWINGS_UNSUPPORTED,
    tone: null,
    detail: DESIGN_DRAWINGS_NOTE,
    unsupported: true,
  })

  return { lines, note: DESIGN_FILES_READ_ONLY_NOTE }
}

/**
 * The pictures an Order holds, counted by role from the stored rows.
 *
 * A ROW WHOSE ROLE THIS BUILD DOES NOT KNOW IS NOT COUNTED, for the reason the
 * approval standing drops an unknown status: a file this screen cannot name is
 * a file it should not claim.
 */
export function countDesignImages(
  rows: readonly { role: string }[],
): DesignImageCounts {
  let representative = 0
  let customization = 0
  for (const row of rows) {
    if (row.role === 'representative') representative += 1
    else if (row.role === 'customization') customization += 1
  }
  return { representative, customization }
}

// ── Manufacturing ─────────────────────────────────────────────────────────────

export const MANUFACTURING_PRODUCTION_LABEL = 'Production alignment'
export const MANUFACTURING_STAGE_LABEL = 'Order stage'

/**
 * WHAT THIS BUILD RECORDS ABOUT MAKING AND SENDING AN ORDER, and what it does
 * not.
 *
 * It records two things: whether the Head of Manufacturing has aligned the
 * Order for production, and which of the five lifecycle stages the Order is in
 * — of which Ready for Dispatch and Dispatched are the only dispatch facts that
 * exist anywhere. There is no work-in-progress stage, no QC result and no
 * packing record in any table, so the card says so rather than leaving a reader
 * to read the blank as "not started yet".
 */
export const MANUFACTURING_UNTRACKED_NOTE =
  'Manufacturing stage, QC and packaging are not recorded against an Order in this system. '
  + 'Dispatch is recorded only as the Order stage above.'

export type ManufacturingStatusView = {
  lines: CurrentStatusLine[]
  note: string
}

/**
 * Where the Order stands operationally.
 *
 * PRODUCTION IS describeProductionAlignment's ANSWER, and its tone follows the
 * rule the summary panel already applies to the very same field: aligned is
 * green, a gap on a live Order is amber, and the same gap on a dispatched or
 * cancelled one is neutral because nothing is waiting on it any more.
 *
 * THE STAGE CARRIES NO PILL. It is the Order's own status, already stated in
 * the command header at the top of the page; restating it here in colour would
 * make one fact shout twice. It is a plain value, because a reader in this card
 * is asking "has it gone out yet", and the word answers that.
 */
export function describeManufacturingStatus(input: {
  production: ProductionAlignmentView | null
  orderStatus: string
  /** The page's own label for that status. */
  orderStatusLabel: string
}): ManufacturingStatusView {
  const lines: CurrentStatusLine[] = []
  const closed = isOrderClosed(input.orderStatus)

  if (input.production) {
    lines.push({
      key: 'production',
      label: MANUFACTURING_PRODUCTION_LABEL,
      value: input.production.label,
      tone: input.production.value === 'aligned' ? 'green' : closed ? 'neutral' : 'amber',
      // The line names who aligned it and when; before that there is only the
      // hint, which says what the Order is waiting for and on whom.
      detail: input.production.line ?? input.production.hint,
      unsupported: false,
    })
  }

  lines.push({
    key: 'stage',
    label: MANUFACTURING_STAGE_LABEL,
    value: input.orderStatusLabel,
    tone: null,
    detail: null,
    unsupported: false,
  })

  return { lines, note: MANUFACTURING_UNTRACKED_NOTE }
}
