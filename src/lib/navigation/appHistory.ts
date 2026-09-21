// ── Can an in-app Back control safely pop the browser's history? ─────────────
//
// A record page's Back button is not the browser's Back button. The browser's
// must always pop; an in-app one is a promise to return the reader to where
// they came from INSIDE BOE — and `router.back()` cannot keep that promise when
// the record is the first page in the tab. A task opened from a notification in
// a new tab, from a bookmark or from a pasted link has nothing behind it, so
// the press does nothing at all and the page appears frozen. Orders and Finance
// hit this first and answered it by never popping (RecordBackLink); Task Detail
// wants the popping behaviour kept wherever it is genuinely available, because
// popping is what leaves the history clean and what makes Forward work.
//
// THE SIGNAL. Not `history.length > 1` — a tab that visited another site before
// BOE also has entries behind it, and popping into them takes the reader off
// BOE, which is precisely what an in-app Back must never do. The question is
// narrower: has THIS document pushed an entry of its own since its JavaScript
// started? If it has, the entry behind us is one of ours and popping returns to
// it. If it has not, there is nothing of ours to pop and the caller must
// navigate to a named destination instead.
//
// So the length is sampled once, when the app boots in a document
// (`noteDocumentEntry`, called from Providers), and compared against the live
// value at the moment Back is pressed. A reload re-evaluates the module and
// re-samples, which is correct: a reloaded document has pushed nothing yet.
//
// KNOWN, SAFE DEGRADATION. Browsers cap `history.length` (Chrome at 50). A
// reader who has pushed past the cap stops growing the number and is treated as
// having no in-app history — so Back navigates to the named destination rather
// than popping. That is the safe direction to fail in: the wrong-but-correct
// list, never a dead button and never a jump off BOE.

/**
 * Whether an in-app Back may pop, given the length sampled when the document
 * booted and the length now. Pure, so both branches are testable without a
 * browser.
 *
 * `entryLength` is null when the document's entry was never sampled — server
 * rendering, or a caller that runs before Providers has mounted. Unsampled
 * means "we cannot prove the entry behind us is ours", which is a refusal.
 */
export function canPopInAppHistory(entryLength: number | null, currentLength: number): boolean {
  if (entryLength === null) return false
  return currentLength > entryLength
}

let entryLength: number | null = null

/**
 * Sample this document's history length. Called once from Providers, at the
 * root of every route, so the value is taken before any in-app navigation can
 * happen. Repeat calls are ignored — the FIRST sample is the one that describes
 * the document as it arrived.
 */
export function noteDocumentEntry(length: number): void {
  if (entryLength === null) entryLength = length
}

/** Has this document pushed a history entry of its own? */
export function hasInAppHistory(): boolean {
  if (typeof window === 'undefined') return false
  return canPopInAppHistory(entryLength, window.history.length)
}

/** Test seam — module state is per-document in a browser, per-process here. */
export function resetDocumentEntry(): void {
  entryLength = null
}
