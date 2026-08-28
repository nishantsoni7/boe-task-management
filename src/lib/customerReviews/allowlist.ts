// THE INTERNAL TEAM ALLOWLIST — who a test message may be addressed to.
//
// WHY AN ALLOWLIST AT ALL
// -----------------------
// This module opens WhatsApp with a message prefilled. During this test phase
// the only acceptable recipients are BOE's own internal team numbers, and the
// unacceptable ones include every customer BOE has ever had. A free-text phone
// field would put "message a real customer by mistake" one typo away, so the
// recipient is chosen from a server-held list and every number is re-checked on
// the server before a link is produced.
//
// WHERE THE NUMBERS COME FROM
// ---------------------------
// One server-only environment variable, BOE_INTERNAL_TEST_WHATSAPP_NUMBERS.
// NOT a NEXT_PUBLIC_ name, so Next never inlines it into a client bundle; not a
// table, because this list belongs to a deployment rather than to the data; and
// NOT the repository, because a colleague's personal mobile number is not
// something to commit. .env.example documents the NAME and shows placeholders
// only.
//
// FORMAT: comma- or newline-separated entries, each either
//
//     +919876543210
//     Label|+919876543210
//
// The optional label is what the UI shows ("Ops test phone"), so a tester picks
// a person rather than a number.
//
// FAIL CLOSED, EVERY WAY IT CAN FAIL
// ----------------------------------
// Unset, empty, whitespace, all-comments, or containing an entry that is not a
// valid E.164 number: the result is a REFUSAL, not a shorter list. A malformed
// allowlist is a misconfiguration, and quietly dropping the bad entries would
// mean a deployment that thought it had five approved numbers running with
// three and nobody noticing. There is no default, no fallback, and no built-in
// number anywhere in this file.
//
// WHAT IS NEVER DONE HERE
//   * No number is read from the client and trusted. findAllowedNumber() is
//     what the routes call, and it compares against THIS list.
//   * Nothing sends a message. There is no WhatsApp API client in this
//     repository, no token, and no outbound call — the only artefact this
//     module produces is a wa.me URL string.

import { normalizeWhatsAppNumber } from './contact'

/** The one variable. Named here so the tests and .env.example cannot drift. */
export const ALLOWLIST_ENV_VAR = 'BOE_INTERNAL_TEST_WHATSAPP_NUMBERS'

export type InternalTestNumber = {
  /** E.164, normalized. */
  e164: string
  /** Digits only, for a wa.me path. */
  digits: string
  /** What a tester sees. Falls back to the masked number. */
  label: string
}

export type AllowlistResult =
  | { ok: true; numbers: readonly InternalTestNumber[] }
  | { ok: false; reason: 'missing' | 'empty' | 'malformed'; detail: string }

/**
 * Strip C0 controls and DEL from a label before it reaches a browser.
 *
 * Written by code point rather than as a regex character class ON PURPOSE. The
 * class form has to be spelled with escapes, and an escape that survives one
 * editor and not the next is how a literal NUL byte gets committed to this
 * repository — it has happened here before. Comparing numbers cannot be
 * mis-transcribed.
 */
function stripControlCharacters(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 || code === 127) continue
    out += ch
  }
  return out
}

/**
 * Parse an allowlist from its raw string form.
 *
 * Split out from readInternalTestAllowlist() so the parsing rules can be tested
 * without setting environment variables, and so the ONE place that reads
 * process.env is a two-line function.
 *
 * `detail` NEVER contains a phone number, valid or not. A malformed entry is
 * reported by its POSITION, because the failure message goes into a server log
 * and a log line is exactly the place a number must not appear.
 */
export function parseInternalTestAllowlist(raw: string | undefined | null): AllowlistResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'missing', detail: `${ALLOWLIST_ENV_VAR} is not set` }
  }
  if (raw.trim() === '') {
    return { ok: false, reason: 'empty', detail: `${ALLOWLIST_ENV_VAR} is empty` }
  }

  const entries = raw
    .split(/[,\n]/)
    .map(part => part.trim())
    // '#' starts a comment, so a deployment can annotate the value.
    .filter(part => part !== '' && !part.startsWith('#'))

  if (entries.length === 0) {
    return { ok: false, reason: 'empty', detail: `${ALLOWLIST_ENV_VAR} lists no entries` }
  }

  const numbers: InternalTestNumber[] = []
  const seen = new Set<string>()

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const pipe = entry.lastIndexOf('|')
    const rawLabel = pipe >= 0 ? entry.slice(0, pipe).trim() : ''
    const rawNumber = pipe >= 0 ? entry.slice(pipe + 1).trim() : entry

    // Normalized SERVER-SIDE, and strictly: an entry must already be a complete
    // international number. The bare-10-digit convenience that
    // normalizeWhatsAppNumber offers a human typing into a form is deliberately
    // not extended to configuration, where a guess about which country a number
    // belongs to would be a guess about who gets messaged.
    if (!rawNumber.startsWith('+')) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `${ALLOWLIST_ENV_VAR} entry ${index + 1} is not written in full international form`,
      }
    }
    const normalized = normalizeWhatsAppNumber(rawNumber)
    if (!normalized.ok) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `${ALLOWLIST_ENV_VAR} entry ${index + 1} is not a valid number`,
      }
    }
    if (seen.has(normalized.e164)) continue
    seen.add(normalized.e164)

    numbers.push({
      e164: normalized.e164,
      digits: normalized.digits,
      // A label is display text and reaches a browser, so it is bounded and
      // stripped of control characters. It never reaches a URL or a path.
      label:
        stripControlCharacters(rawLabel).slice(0, 60) ||
        `•••• ${normalized.digits.slice(-4)}`,
    })
  }

  if (numbers.length === 0) {
    return { ok: false, reason: 'empty', detail: `${ALLOWLIST_ENV_VAR} lists no usable entries` }
  }
  return { ok: true, numbers }
}

/**
 * The deployment's allowlist.
 *
 * The only reader of process.env in this module. Server-only: the variable has
 * no NEXT_PUBLIC_ prefix, so in a client bundle this would evaluate to
 * `undefined` and return { ok: false, reason: 'missing' } — fail-closed even
 * when imported from the wrong side, which is the behaviour to have if the
 * import rule is ever broken. A source-contract test enforces the rule itself.
 */
export function readInternalTestAllowlist(): AllowlistResult {
  return parseInternalTestAllowlist(process.env[ALLOWLIST_ENV_VAR])
}

/**
 * Is this number one of the approved internal team numbers?
 *
 * Takes the list as an argument rather than reading the environment, so a
 * caller cannot check against a list other than the one it is about to use, and
 * so the rule is testable without a deployment.
 *
 * Comparison is on the NORMALIZED form of both sides: `+91 98765 43210`,
 * `919876543210` and `+919876543210` are one number, and a caller cannot slip a
 * different recipient past the check by writing it differently.
 */
export function findAllowedNumber(
  candidate: string | null | undefined,
  allowed: readonly InternalTestNumber[],
): InternalTestNumber | null {
  const normalized = normalizeWhatsAppNumber(candidate)
  if (!normalized.ok) return null
  return allowed.find(n => n.e164 === normalized.e164) ?? null
}
