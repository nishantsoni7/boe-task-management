import { createHmac } from 'node:crypto'

import { isValidWhatsAppNumber } from './contact'

// WHAT THE DATABASE IS ALLOWED TO REMEMBER ABOUT A RECIPIENT.
//
// The card needs to record that a test went somewhere, and a verifier needs
// enough to tell one recipient from another. Neither needs the number.
//
// So a recipient is stored as two things and never as a third:
//
//   last_four   four digits, for a person to recognise a number they typed.
//   fingerprint a non-reversible HMAC of the full E.164 form, so two tests sent
//               to the same number are visibly the same recipient without the
//               number being recoverable from the row.
//
// THE FULL NUMBER IS NEVER PERSISTED, never logged, never put in an event
// detail, never in an error message, and never in a fixture. It exists in one
// request body, for the length of one request, and in the wa.me URL the
// server hands back to the browser that asked for it.
//
// ─── WHY AN HMAC AND NOT A PLAIN SHA-256, STATED HONESTLY ───────────────────
//
// A bare digest of a phone number is not a secret. The space is small — an
// Indian mobile is ten digits, and the last four are stored in clear beside it,
// leaving a million candidates — so anyone holding the table could recover
// every number in an afternoon. Calling that "hashed" would be a claim the
// storage does not support.
//
// The HMAC key is the deployment's existing server-only credential, which never
// reaches a browser and is not stored next to the data it protects. That does
// NOT make the fingerprint secret against somebody who has both the database
// and the server's environment — nothing at this layer could — but it means the
// database ALONE does not reveal the numbers, which is the realistic leak this
// is defending against.
//
// It also means the fingerprint is deployment-scoped: the same number produces
// different fingerprints in staging and in production, and rotating the
// credential invalidates every existing fingerprint. That is a real
// consequence, and it is acceptable here because a fingerprint is a
// convenience for correlating test rows, never an identifier anything depends
// on.

/** The one server-only credential this deployment already has. */
const KEY_ENV_VAR = 'SUPABASE_SERVICE_ROLE_KEY'

/**
 * A domain separator, so a fingerprint produced here can never collide with —
 * or be replayed as — an HMAC produced for anything else under the same key.
 */
const DOMAIN = 'boe:customer-review-test-card:recipient:v1'

export type RecipientFingerprint = {
  /** Lower-case hex HMAC-SHA256. Non-reversible without the server credential. */
  fingerprint: string
  /** The final four digits, and nothing else. */
  lastFour: string
}

export type FingerprintResult =
  | { ok: true; value: RecipientFingerprint }
  | { ok: false; reason: 'unconfigured' | 'invalid_number' }

/**
 * Reduce a validated E.164 number to what may be stored.
 *
 * Takes the E.164 form rather than raw input on purpose: fingerprinting an
 * un-normalised string would give `+91 98765 43210` and `+919876543210` two
 * different fingerprints for one number, which would make the whole column
 * useless for the only thing it is for.
 *
 * FAILS CLOSED. With no credential configured there is no fingerprint, and the
 * caller must decide what to do rather than receiving a weaker value it might
 * not notice — see the route, which refuses to record.
 */
export function fingerprintRecipient(e164: string): FingerprintResult {
  // The canonical predicate rather than a second copy of the pattern. Two
  // regexes for "is this E.164" is how one of them ends up accepting something
  // the other rejects, and the disagreement would be invisible: the caller
  // would fingerprint a number this module had already refused to link to.
  if (!isValidWhatsAppNumber(e164)) return { ok: false, reason: 'invalid_number' }

  const key = process.env[KEY_ENV_VAR]
  if (!key) return { ok: false, reason: 'unconfigured' }

  const fingerprint = createHmac('sha256', key)
    .update(`${DOMAIN}:${e164}`)
    .digest('hex')

  return { ok: true, value: { fingerprint, lastFour: e164.slice(-4) } }
}
