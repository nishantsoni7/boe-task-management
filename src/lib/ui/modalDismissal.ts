// Form-modal dismissal and focus-trap policy.
//
// The BOE Form Modal Dismissal Rule, as code. See
// docs/BOE Master Context/05_Business_Rules.md → "Form Modal Dismissal Rule"
// and docs/Reference/UI_RULES.md → "Form Modal Dismissal".
//
// A form modal may close ONLY through Cancel, the × control, Escape, or a
// successful submission. A backdrop or any outside-the-dialog click must do
// nothing — a user can spend real time in these forms and an accidental click
// must never discard it. Read-only detail pop-ups are not covered here and may
// keep click-away-to-close.
//
// Kept separate from the components so the rule is stated once and can be
// tested without a DOM.

export type ModalDismissReason =
  | 'backdrop'        // click on the overlay, or anywhere outside the dialog
  | 'escape'          // Escape key
  | 'close-icon'      // × control, top-right
  | 'cancel'          // Cancel button
  | 'submit-success'  // the write succeeded
  | 'submit-error'    // the write failed

/**
 * Whether a form modal closes for this reason. The single source of truth —
 * components must not re-decide it inline.
 */
export function shouldCloseFormModal(reason: ModalDismissReason): boolean {
  switch (reason) {
    case 'escape':
    case 'close-icon':
    case 'cancel':
    case 'submit-success':
      return true
    // A backdrop click does nothing at all. Not "close after confirming",
    // not "close if the form is untouched" — nothing.
    case 'backdrop':
    // A failed save keeps the modal open with every entered value intact.
    case 'submit-error':
      return false
  }
}

export type TrapInput = {
  /** Focusable elements inside the dialog. */
  count: number
  /** Index of the focused element within them; -1 when focus is outside. */
  activeIndex: number
  /** Shift+Tab rather than Tab. */
  shiftKey: boolean
}

/**
 * Where Tab should send focus to keep it inside the dialog.
 *
 *   'first' / 'last' — move there and swallow the keypress
 *   'block'          — nothing focusable inside; swallow it and stay put
 *   null             — an ordinary move within the dialog; let the browser do it
 *
 * The activeIndex === -1 case is what stops Tab from reaching the sidebar:
 * focus that has escaped the dialog is pulled straight back in.
 */
export function resolveTrapTarget(input: TrapInput): 'first' | 'last' | 'block' | null {
  if (input.count <= 0) return 'block'
  if (input.activeIndex < 0) return 'first'
  if (input.shiftKey) return input.activeIndex === 0 ? 'last' : null
  return input.activeIndex === input.count - 1 ? 'first' : null
}

// Selector for what can hold focus inside a dialog. Excludes negative
// tabindex (the dialog container itself uses tabIndex={-1}) and disabled
// controls, which cannot be tabbed to.
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')
