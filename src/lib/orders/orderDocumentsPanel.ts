// ── THE CONFIRMED ORDER'S DOCUMENTS, AS ONE AREA ─────────────────────────────
//
// WHAT THIS MODULE IS FOR
// -----------------------
// An Order carries paperwork of three different kinds — the PI it runs on, the
// design files behind its products, and the client's own purchase order — and
// they used to be nothing, one card and another card. A reader looking for "the
// documents on this Order" had no single place to look, and the two cards that
// did exist each restated the fabric and finish approvals that the Fabric &
// Finish card states in full a column away.
//
// This decides what each of the three SUBSECTIONS says. One card draws them.
//
// IT REPORTS STATE. It computes no figure, authorizes nothing, reads nothing and
// signs nothing. Every input is an answer somebody else already gave:
// `mainPiCard` names the PI in force, and the image summary is the Order's own
// four-state picture read.
//
// THE APPROVALS ARE NOT HERE. Fabric and Finish belong to the card beside this
// one, which states them with their dates, their actors and their evidence.
// Summarising them here as well is the duplication this pass exists to remove —
// see orderDetailArchitecture.test.ts, which holds that they are stated once.

import {
  DESIGN_IMAGES_NONE,
  DESIGN_IMAGES_NO_SOURCE,
  DESIGN_IMAGES_NO_SOURCE_NOTE,
  DESIGN_IMAGES_UNAVAILABLE,
  DESIGN_IMAGES_UNAVAILABLE_NOTE,
  type DesignImageSummary,
} from './orderCurrentStatus'

// ── Words ─────────────────────────────────────────────────────────────────────

export const DOCUMENTS_TITLE = 'Documents'

export const DOC_MAIN_PI_TITLE = 'Main PI'
export const DOC_DESIGN_FILES_TITLE = 'Design Files'
export const DOC_CLIENT_PO_TITLE = 'Client PO'

/**
 * WHAT AN EMPTY DOCUMENT SLOT SAYS, and it says it quietly.
 *
 * `Not attached` is a statement of fact, not a warning. Most Orders legitimately
 * carry no client PO and plenty carry no design file; drawing either in an alarm
 * colour would teach a reader to ignore the colour on the one that matters.
 */
export const DOC_NOT_ATTACHED = 'Not attached'

/**
 * WHAT THE DESIGN-FILE CONTROL DOES, NAMED FOR WHAT IT DOES.
 *
 * It was "View / Manage", and it manages nothing: the dialog it opens previews
 * the pictures and offers no upload, no replacement and no deletion, because
 * this Order has no way to perform any of the three. A label promising
 * management where none exists sends somebody looking for a control that was
 * never built, and then to somebody else to ask where it went.
 *
 * ORDER-LEVEL DESIGN-DOCUMENT UPLOAD DOES NOT EXIST YET. These pictures belong
 * to the approved PI and are added and removed there. Giving the Order its own
 * design documents needs the same backend work a Client PO needs — see the note
 * further down this file — and until that lands the honest word is "View".
 */
export const DOC_VIEW_FILES_LABEL = 'View files'

// ── The four states a subsection can be in ────────────────────────────────────
//
// LOADING, UNAVAILABLE, EMPTY AND READY, AND NO FIFTH — the model PR #195
// introduced for the picture read, kept whole here because the confusion it
// prevents is exactly the confusion this box could reintroduce.
//
//   loading      the read has not finished. NOT "none".
//   unavailable  the read failed or was refused. NOT "none" either: a reader
//                told "none recorded" stops looking, and would be wrong.
//   empty        the read finished and there is genuinely nothing.
//   ready        there is something, and here is what.
//
// `empty` carries its OWN message rather than a shared one, because "this Order
// has no source PI" and "this Order's PI records no picture" are different
// facts and a reader acts differently on each.

export type DocumentStateKind = 'loading' | 'unavailable' | 'empty' | 'ready'

export type DesignFilesDocument =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string; note: string }
  | { kind: 'empty'; message: string; note: string | null }
  | {
      kind: 'ready'
      /** `9 files` — the headline. */
      summary: string
      /** `6 representative · 3 customization · 6 product lines`. */
      detail: string
      /** How many pictures the Order holds, for the caller's own gating. */
      total: number
    }

/** `12 files` / `1 file`, so a count never reads as a plural of one. */
const fileCount = (total: number): string => `${total} file${total === 1 ? '' : 's'}`

/**
 * THE DESIGN FILES SUBSECTION.
 *
 * READ-ONLY, AND HONESTLY LABELLED. Every picture here BELONGS TO THE APPROVED
 * PI — it is the PI's own product imagery, inherited by the Order at conversion
 * — and the PI screen is where one is added or removed. The Order has no design
 * document of its own, no upload path and no store to put one in, so this
 * subsection previews and counts, and says "View files" rather than pretending
 * to manage anything.
 *
 * THE PICTURES ARE COUNTED FROM THE ROWS, not from the URLs the page managed to
 * sign. A picture the storage policy refused this reader is still a picture the
 * Order holds, and reporting one fewer would make the count a function of who is
 * looking.
 */
export function designFilesDocument(
  images: DesignImageSummary,
  productCount: number,
): DesignFilesDocument {
  if (images.kind === 'loading') return { kind: 'loading' }

  if (images.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      message: DESIGN_IMAGES_UNAVAILABLE,
      note: DESIGN_IMAGES_UNAVAILABLE_NOTE,
    }
  }

  if (images.kind === 'no_source') {
    // EMPTY, BUT FOR ITS OWN REASON. An Order that never came from a PI has no
    // design record to be missing, and saying `None recorded` would suggest one
    // was expected.
    return { kind: 'empty', message: DESIGN_IMAGES_NO_SOURCE, note: DESIGN_IMAGES_NO_SOURCE_NOTE }
  }

  const total = images.counts.representative + images.counts.customization
  if (total === 0) return { kind: 'empty', message: DESIGN_IMAGES_NONE, note: null }

  return {
    kind: 'ready',
    summary: fileCount(total),
    detail: [
      `${images.counts.representative} representative`,
      `${images.counts.customization} customization`,
      `${productCount} product line${productCount === 1 ? '' : 's'}`,
    ].join(' · '),
    total,
  }
}

// ── The client's own purchase order ───────────────────────────────────────────
//
// THERE IS NOWHERE TO PUT ONE YET, AND THIS SAYS SO RATHER THAN PRETENDING.
//
// The audit behind this pass looked for a home for a client PO and found none:
//
//   order_document_versions     a GENERATED xlsx/pdf pipeline with a closed
//                               status set (pending/claimed/ready/failed) and a
//                               worker that writes it. Not an upload store.
//   order_request_attachments   an upload store, but keyed to order_requests —
//                               not orders — with attachment_type closed by a
//                               CHECK to ('main_pi','reference').
//   the four buckets            order-files, order-request-attachments,
//                               payment-proofs, task-attachments. No prefix and
//                               no policy for an Order-scoped client document.
//
// So a real Client PO needs a table or a widened one, an RLS pair, a storage
// policy for its prefix, and a decision about who may upload — none of which
// belongs in a presentation pass, and none of which this module invents.
//
// WHAT WAS DELIBERATELY NOT DONE. No PO is stored as a mis-typed design file, no
// file is identified as a PO by guessing at its name, and no local state
// pretends an upload happened. Each of those would put a number on the screen
// that no record backs.
//
// THE SLOT IS STILL DRAWN, quietly, so the box answers the question a reader
// actually has — "is the client's PO on this Order?" — with `Not attached` and
// one muted sentence, instead of leaving them to wonder whether the screen
// simply does not show it.

export const CLIENT_PO_UNSUPPORTED_NOTE =
  'Client POs are not stored against an Order yet, so none can be attached here.'

export type ClientPoDocument =
  /** No store exists. The slot states the absence and offers no control. */
  | { kind: 'unsupported'; message: string; note: string }
  /** Reserved for the store: a reader with upload rights gets a control. */
  | { kind: 'empty'; message: string; canUpload: boolean }
  | { kind: 'ready'; summary: string; detail: string | null }

export function clientPoDocument(): ClientPoDocument {
  return { kind: 'unsupported', message: DOC_NOT_ATTACHED, note: CLIENT_PO_UNSUPPORTED_NOTE }
}
