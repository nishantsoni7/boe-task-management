// The pure half of useMirrorToUrl: set or remove a few query keys and leave
// every other key exactly as it was.

/**
 * `current` with each key in `patch` set to its value, or removed when the value
 * is null or empty. Keys not named in `patch` are untouched and keep their order.
 */
export function mergeSearchParams(
  current: string,
  patch: Record<string, string | null | undefined>,
): string {
  const params = new URLSearchParams(current.startsWith('?') ? current.slice(1) : current)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') params.delete(key)
    else params.set(key, value)
  }
  return params.toString()
}
