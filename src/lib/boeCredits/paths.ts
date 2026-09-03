// BOE Credits — where the employee-facing screens live, in one place.
//
// Both are self-service: every read behind them derives the employee from the
// bearer token, so an administrator opening them sees their own credits, and
// the knowledge page reads no employee record at all.

/** The employee's credits: balance, what they can be used for, this month's progress, history. */
export const MY_CREDITS_PATH = '/my-credits'

/** "How BOE Credits Work" — the knowledge page, driven by the live settings. */
export const CREDITS_GUIDE_PATH = '/my-credits/how-it-works'
