const DEFAULT_ORIGIN = 'https://boe.invalid'
const MAX_RETURN_PATH_LENGTH = 2048
const UNSAFE_RETURN_CHARS = /[\s\u0000-\u001F\u007F-\u009F]/u

/**
 * Accept only a same-origin absolute-path reference suitable for client-side
 * navigation. Invalid input returns null so callers can apply their own
 * fallback.
 */
export function safeReturnPath(
  raw: string | null | undefined,
  origin = DEFAULT_ORIGIN,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) {
    return null
  }

  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return null
  }

  if (raw.includes('\\') || UNSAFE_RETURN_CHARS.test(raw)) {
    return null
  }

  try {
    const base = new URL(origin)
    const resolved = new URL(raw, base)
    return resolved.origin === base.origin ? raw : null
  } catch {
    return null
  }
}
