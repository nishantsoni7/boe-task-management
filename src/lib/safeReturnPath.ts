// Is a `returnTo` value an internal BOE path that is safe to navigate to?
//
// Account Settings' Back button and Task Detail's Submit for Approval both take
// their destination from a URL anybody can craft, so the value is only followed
// after `safeReturnPath` has proved it stays on BOE. Anything else — another site,
// a protocol, a backslash trick, a control or whitespace character — returns null
// and the caller uses its own fallback.

/** Far longer than any real BOE URL: a guard against pathological input, not a limit anyone meets. */
export const MAX_RETURN_PATH_LENGTH = 2048

// Resolved against a placeholder origin: a value that can change the origin names
// somewhere other than BOE.
const PLACEHOLDER_ORIGIN = 'https://boe.invalid'

// C0 controls, space, DEL, C1 controls and Unicode whitespace. URL parsers silently
// strip tab and newline, which is how "/\t/evil.com" turns into "//evil.com" after
// a naive check.
function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return /\s/.test(value)
}

/**
 * The value itself when it is an internal BOE path (`/tasks/my?tab=working`),
 * otherwise null. Returned unchanged, so the page comes back exactly as it was.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length < 1 || raw.length > MAX_RETURN_PATH_LENGTH) return null
  if (raw[0] !== '/') return null      // relative to BOE — never a scheme or a host
  if (raw[1] === '/') return null      // "//host" is protocol-relative
  if (raw.includes('\\')) return null  // browsers read "\" as "/": "/\host"
  if (hasUnsafeCharacter(raw)) return null
  let url: URL
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN)
  } catch {
    return null
  }
  return url.origin === PLACEHOLDER_ORIGIN ? raw : null
}
