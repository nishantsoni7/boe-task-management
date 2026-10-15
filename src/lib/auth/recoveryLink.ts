// What did the password-reset email link bring back to /reset-password?
//
// Supabase can return a recovery link in three shapes, and the page has to tell
// them apart before it can show the "choose a new password" form:
//
//   ?token_hash=…&type=recovery   The email template points straight at BOE.
//                                 Works on any device, because the hash itself
//                                 is the proof — verifyOtp() turns it into a
//                                 session.
//   ?code=…                       The default PKCE link. The browser client
//                                 exchanges it on load, but only in the browser
//                                 that asked for the email, because that is
//                                 where the code verifier was stored.
//   ?error=… / #error=…           Supabase refused the link before sending the
//                                 user here — usually expired or already used.
//
// Kept free of React and Supabase so the rules can be tested directly.

export type RecoveryLink =
  | { kind: 'token_hash'; tokenHash: string }
  | { kind: 'code' }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

export const EXPIRED_LINK_MESSAGE =
  'This reset link has expired or has already been used. Please request a new one.'

/** `search` is location.search, `hash` is location.hash — either may be empty. */
export function readRecoveryLink(search: string, hash: string): RecoveryLink {
  const query    = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)

  const error = query.get('error') ?? fragment.get('error')
  if (error) {
    const code = query.get('error_code') ?? fragment.get('error_code')
    if (code === 'otp_expired') return { kind: 'error', message: EXPIRED_LINK_MESSAGE }
    const description = query.get('error_description') ?? fragment.get('error_description')
    return { kind: 'error', message: description || EXPIRED_LINK_MESSAGE }
  }

  const tokenHash = query.get('token_hash')
  if (tokenHash && (query.get('type') ?? 'recovery') === 'recovery') {
    return { kind: 'token_hash', tokenHash }
  }

  if (query.get('code')) return { kind: 'code' }

  return { kind: 'none' }
}

// ── Did THIS session come from a reset link? ─────────────────────────────────
//
// A failed or unusable link does not sign anybody out: auth-js keeps whatever
// session was already in the browser, and a ?code= opened on another device is
// simply ignored. So "is there a session?" is not enough — on a shared machine
// it could be a colleague still signed in, and the form would change THEIR
// password.
//
// The access token's `amr` claim records how the session was created. Supabase
// Auth writes "recovery" for a PKCE reset link and "otp" for a token_hash one
// (verifyOtp); a normal sign-in writes "password". BOE signs people in only with
// a password, so a recent link-based method means the session is the one the
// reset link just made.

/** A reset link's session can set a new password for this long after it was opened. */
export const RECOVERY_SESSION_MAX_AGE_SECONDS = 60 * 60

const LINK_METHODS = new Set(['recovery', 'otp'])

type AmrEntry = { method?: unknown; timestamp?: unknown }

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json = decodeURIComponent(
      Array.from(atob(padded), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    )
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/** True when the access token was issued by a reset link opened within the last hour. */
export function isFreshRecoverySession(accessToken: string, nowSeconds: number): boolean {
  const amr = decodeJwtPayload(accessToken)?.amr
  if (!Array.isArray(amr)) return false
  return amr.some((entry: AmrEntry) =>
    typeof entry?.method === 'string' &&
    LINK_METHODS.has(entry.method) &&
    typeof entry.timestamp === 'number' &&
    nowSeconds - entry.timestamp <= RECOVERY_SESSION_MAX_AGE_SECONDS,
  )
}

/** Same rule as Account Settings, so a reset password is never weaker than a changed one. */
export const MIN_PASSWORD_LENGTH = 8

/** The first problem with a new password, or null when it can be saved. */
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (!password) return 'New password is required.'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password !== confirm) return 'Passwords do not match.'
  return null
}
