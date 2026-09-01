// Sharing an approved review — the decisions, separated from the DOM.
//
// WHY THIS FILE EXISTS AT ALL. The share control has to answer three questions
// before it does anything: is this review allowed to leave the building, can
// this browser take files, and if not, what happens instead. All three are
// worth testing and none of them needs a browser, so all three live here as
// pure functions and the component is left holding only the parts that do.
//
// ── WHAT SHARING IS, AND EMPHATICALLY IS NOT ───────────────────────────────
//
// It hands the review's text and its images to the operating system's share
// sheet. The person choosing WhatsApp, choosing a recipient and pressing send
// is a person, every time.
//
// THERE IS NO WHATSAPP BUSINESS API HERE. No Meta credential, no template, no
// token, no outbound HTTP request, and no code path in this module that
// delivers a message. `navigator.share` opens a sheet; what happens after that
// is the operating system's business and the user's decision. Nothing in this
// file, or in the component that uses it, may ever report that a message was
// sent — because nothing here can know, and claiming otherwise would be the one
// dishonesty this module is most careful to avoid.

import type { TestCardStatus } from './types'

/**
 * Whether a review may be shared at all.
 *
 * PENDING IS THE ONE THAT MATTERS. A draft awaiting approval has not been read
 * by a verifier, and the entire workflow rests on nobody outside BOE seeing one
 * before that happens. Sharing is the single control in this module that hands
 * text to another application, so it is the single place that rule could be
 * broken by accident — and this function is why it cannot be.
 *
 * Everything else is allowed: `available`, `booked`, `submitted` and `verified`
 * are all states a review reached BY BEING APPROVED, and approval is the gate.
 * A deleted review is refused too — a verifier threw it away, and throwing
 * something away should not leave it shareable.
 */
export function isShareableReview(card: {
  status: TestCardStatus
  approved_at: string | null
  deleted_at: string | null
}): boolean {
  if (card.deleted_at !== null) return false
  if (card.status === 'pending_approval') return false
  // APPROVED_AT IS CHECKED TOO, not just the status. They agree — a CHECK
  // enforces that a pending card has no approval stamp — and asking both means
  // a row that somehow held one without the other is refused rather than
  // trusted. The cheap question is asked because the expensive one is
  // irreversible.
  return card.approved_at !== null
}

export type ShareCapability =
  /** The browser will take the text and every file. The good path. */
  | { kind: 'files' }
  /**
   * There is a share sheet, but not one that accepts these files — or there are
   * no files to send. Text alone goes through the sheet.
   */
  | { kind: 'text' }
  /** No Web Share API at all. Desktop, mostly. Copy and download instead. */
  | { kind: 'none' }

/**
 * What this browser can actually do, asked of the browser rather than guessed
 * from a user agent.
 *
 * `canShare` IS CONSULTED BEFORE `share`, ALWAYS, and that ordering is the
 * whole point of this function. Calling `navigator.share({ files })` on a
 * browser that has `share` but not file support does not degrade — it rejects,
 * and on some browsers it rejects only after the sheet has flickered open. The
 * specification provides `canShare` precisely so a caller can find out first,
 * and a caller that skips it is choosing to find out by failing.
 *
 * `canShare` is asked with THE ACTUAL FILES, not with a probe, because support
 * depends on the file types and the count. A browser may accept one JPEG and
 * refuse four.
 *
 * Written against a narrow structural type rather than `Navigator` so a test
 * can pass three lines of object literal instead of standing up a DOM.
 */
export type ShareCapableNavigator = {
  share?: (data: unknown) => Promise<void>
  canShare?: (data: unknown) => boolean
}

export function shareCapability(
  nav: ShareCapableNavigator | undefined,
  payload: { title: string; text: string; files: readonly File[] },
): ShareCapability {
  if (!nav || typeof nav.share !== 'function') return { kind: 'none' }

  const { title, text, files } = payload

  if (files.length > 0 && typeof nav.canShare === 'function') {
    // The complete payload, exactly as it will be shared. Asking about the
    // files alone would answer a question we are not going to ask.
    if (nav.canShare({ title, text, files: [...files] })) return { kind: 'files' }
  }

  // FILES WERE WANTED AND CANNOT GO. Falling back to a text-only share sheet
  // here would send the review WITHOUT its images, silently — the recipient
  // gets a review about furniture they cannot see, and the sender has no idea.
  // The download fallback is the honest answer, so this is reported as 'none'
  // rather than 'text' whenever there were files to carry.
  if (files.length > 0) return { kind: 'none' }

  // No files wanted. A plain text share is the whole payload, so the sheet is
  // still the better path than copying to the clipboard.
  if (typeof nav.canShare === 'function' && !nav.canShare({ title, text })) {
    return { kind: 'none' }
  }
  return { kind: 'text' }
}

/**
 * The sentence shown beside the fallback.
 *
 * Written once, here, because it is the instruction that makes the fallback
 * usable and it must say the same thing wherever it appears. It describes what
 * the PERSON does next; it does not describe anything the app has done.
 */
export const MANUAL_ATTACH_INSTRUCTION =
  'The review text is on your clipboard and the images have been saved to your device. ' +
  'Open WhatsApp, paste the text, and attach the saved images before you send.'

/**
 * A filename for a downloaded image.
 *
 * The card reference and the position, so four files landing in one Downloads
 * folder are distinguishable and sort in the order they were attached. Nothing
 * the uploader typed contributes — the stored filename is display-only and has
 * never been trusted to be path-safe.
 */
export function downloadFileName(cardRef: string, index: number, mime: string): string {
  const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  const safeRef = cardRef.replace(/[^A-Za-z0-9-]/g, '') || 'review'
  return `${safeRef}-${index + 1}.${extension}`
}
