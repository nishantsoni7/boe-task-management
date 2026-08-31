// Asset handover — the terms an employee acknowledges, and the sheet that is
// printed and physically signed.
//
// Two things live here, and nothing else:
//
//   1. THE TERMS. The canonical text, mirrored character for character by the
//      `v1` seed in supabase/migrations/20261029000000_asset_handover_
//      acknowledgement.sql. handover.test.ts reads that migration and fails if
//      the two ever differ, because the screen an employee reads and the body
//      the database snapshots at acceptance must be the same body.
//
//      The TypeScript copy is what the browser RENDERS. The database copy is
//      what is STORED at acceptance, taken by accept_employee_asset() from
//      asset_handover_terms and never from a parameter — so a client cannot
//      record an acknowledgement of terms it invented.
//
//   2. THE SHEET. buildHandoverSheet() turns an assignment into the exact
//      lines the A4 printout shows. It is a pure function so the printout's
//      content is testable without a browser, a database or a print dialog.
//
// WHICH TERMS A SHEET SHOWS. An accepted assignment shows the SNAPSHOT stored
// at acceptance, never today's text. If the terms are ever amended, a sheet
// printed for a year-old acceptance must still say what that person actually
// agreed to — otherwise the printout silently rewrites the record it exists to
// evidence. An assignment not yet accepted has no snapshot, so it shows the
// current terms: that is what the employee is about to be asked to accept.

import { assetConditionLabel } from './types'

/** The heading the terms appear under, on screen and on the printed sheet. */
export const ASSET_HANDOVER_TERMS_HEADING = 'Asset Handover Terms'

/**
 * The version stored on an acceptance made today.
 *
 * A string, not a number, because it is an identity rather than a quantity:
 * `asset_handover_terms.version` is its primary key and a superseded version's
 * row is kept forever so old acceptances keep pointing at real text.
 */
export const ASSET_HANDOVER_TERMS_VERSION = 'v1'

/**
 * The seven clauses, unnumbered.
 *
 * Kept as clauses rather than one blob so the screen can render them as a list
 * with real list semantics. ASSET_HANDOVER_TERMS_BODY below is the numbered
 * join, and that is the string the database stores.
 */
export const ASSET_HANDOVER_TERMS_CLAUSES: readonly string[] = [
  'I confirm that I have received the listed company asset(s) in the stated condition, along with the listed accessories.',
  'I have noted any existing issue before accepting the handover. Any issue not recorded at handover will be treated as not reported at that time.',
  'I will use the asset carefully, keep it secure, and return it in substantially the same condition, allowing for normal wear from proper use.',
  'I will promptly report loss, damage, theft, malfunction, or any concern to the company.',
  'I will keep the asset safely when not in use. BOE has provided locker facilities; I may request a suitable cover or bag where required.',
  'I remain responsible for reasonable care of the asset inside and outside the office. BOE is not responsible for loss or damage arising from my personal handling or storage of the asset.',
  'On return, any damage or loss caused by negligence will be reviewed with me. Any recovery, if applicable, will follow company process and applicable law.',
]

/** The numbered body, exactly as the `v1` row in the migration stores it. */
export const ASSET_HANDOVER_TERMS_BODY: string =
  ASSET_HANDOVER_TERMS_CLAUSES.map((clause, i) => `${i + 1}. ${clause}`).join('\n')

/** The sentence beside the tick-box. Checked on the server too — see §5 of the migration. */
export const ASSET_HANDOVER_ACKNOWLEDGEMENT =
  'I have read and accept the Asset Handover Terms'

/**
 * The terms to display for one assignment, split into lines.
 *
 * `acceptedTerms` is employee_assets.accepted_terms: the snapshot, or null when
 * the assignment has not been accepted. A stored snapshot always wins — see the
 * note at the top of this file.
 */
export function handoverTermsLines(acceptedTerms: string | null | undefined): string[] {
  const snapshot = acceptedTerms?.trim()
  if (snapshot) return snapshot.split('\n').map(line => line.trim()).filter(line => line !== '')
  return ASSET_HANDOVER_TERMS_BODY.split('\n')
}

// ─── The printed sheet ────────────────────────────────────────────────────────

/** BOE's name as it appears at the head of the sheet. */
export const HANDOVER_SHEET_COMPANY = 'Best of Exports'

/** What is written where a value was never recorded. Never a blank cell. */
export const HANDOVER_NOT_RECORDED = 'Not recorded'

export type HandoverSheetLine = { label: string; value: string }

export type HandoverSheetInput = {
  assetName: string | null | undefined
  assetCode: string | null | undefined
  serialNo: string | null | undefined
  assetType?: string | null
  employeeName: string | null | undefined
  issuedByName?: string | null
  assignedAt: string | null | undefined
  /** employee_assets.handover_condition — the condition AS ISSUED. */
  condition?: string | null
  accessories?: string | null
  existingIssues?: string | null
  acceptedAt?: string | null
  acceptedByName?: string | null
  acceptanceVersion?: string | null
  acceptedTerms?: string | null
  /** Formats an ISO timestamp for a reader. Injected so the sheet stays pure. */
  formatDateTime: (iso: string) => string
}

export type HandoverSheet = {
  company: string
  title: string
  /** Asset / device identity — what was handed over. */
  assetLines: HandoverSheetLine[]
  /** The state it was handed over in — condition, accessories, existing issues. */
  handoverLines: HandoverSheetLine[]
  termsHeading: string
  terms: string[]
  /** True once the employee has acknowledged. */
  accepted: boolean
  /** One sentence stating the online acceptance, or that there is none yet. */
  acceptanceStatement: string
  acceptanceLines: HandoverSheetLine[]
  /** The two hand-signed lines at the foot of the sheet. */
  signatures: { label: string; caption: string }[]
}

function value(raw: string | null | undefined): string {
  const text = raw?.trim()
  return text && text !== '' ? text : HANDOVER_NOT_RECORDED
}

/**
 * Everything the A4 Handover Sheet prints, as data.
 *
 * The rule it enforces: a field that was never recorded prints the words
 * "Not recorded", never an empty space. A blank line on a signed sheet is an
 * invitation to fill it in afterwards, and this document exists to say what was
 * true at handover.
 *
 * The ONLINE acceptance and the PHYSICAL signature lines both appear, always.
 * They answer different questions — the first is what the system recorded, the
 * second is what the two people sign in the room — and a sheet that showed only
 * one of them would be evidence of only half the handover.
 */
export function buildHandoverSheet(input: HandoverSheetInput): HandoverSheet {
  const accepted = !!input.acceptedAt

  const assetLines: HandoverSheetLine[] = [
    { label: 'Asset / Device',   value: value(input.assetName) },
    { label: 'Asset ID',         value: value(input.assetCode) },
    { label: 'Serial Number',    value: value(input.serialNo) },
  ]
  if (input.assetType) assetLines.push({ label: 'Category', value: value(input.assetType) })
  assetLines.push(
    { label: 'Issued To',        value: value(input.employeeName) },
    { label: 'Issued By',        value: value(input.issuedByName) },
    {
      label: 'Handover Date',
      value: input.assignedAt ? input.formatDateTime(input.assignedAt) : HANDOVER_NOT_RECORDED,
    },
  )

  const handoverLines: HandoverSheetLine[] = [
    // Labelled, not raw: the column stores 'needs_repair' and a signed document
    // must read "Needs Repair". assetConditionLabel already answers
    // "Not recorded" for a null, which is exactly the wording used elsewhere
    // on the sheet.
    { label: 'Condition at Handover', value: assetConditionLabel(input.condition) },
    { label: 'Accessories Issued',    value: value(input.accessories) },
    // "None recorded" rather than "Not recorded": clause 2 makes the absence of
    // a recorded issue a statement in itself, so the sheet says so plainly.
    {
      label: 'Existing Issues',
      value: input.existingIssues?.trim() || 'None recorded at handover',
    },
  ]

  const acceptanceLines: HandoverSheetLine[] = accepted
    ? [
        { label: 'Accepted By',      value: value(input.acceptedByName ?? input.employeeName) },
        { label: 'Accepted On',      value: input.formatDateTime(input.acceptedAt as string) },
        { label: 'Terms Version',    value: value(input.acceptanceVersion) },
      ]
    : []

  return {
    company: HANDOVER_SHEET_COMPANY,
    title: 'Asset Handover Sheet',
    assetLines,
    handoverLines,
    termsHeading: ASSET_HANDOVER_TERMS_HEADING,
    terms: handoverTermsLines(input.acceptedTerms),
    accepted,
    acceptanceStatement: accepted
      ? `${value(input.acceptedByName ?? input.employeeName)} accepted the ${ASSET_HANDOVER_TERMS_HEADING} online on ${input.formatDateTime(input.acceptedAt as string)}.`
      : 'This handover has not yet been accepted online by the employee.',
    acceptanceLines,
    signatures: [
      { label: 'Employee Signature', caption: value(input.employeeName) },
      { label: 'Issued By (Signature)', caption: value(input.issuedByName) },
    ],
  }
}
