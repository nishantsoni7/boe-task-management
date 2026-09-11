// Where Task Detail sends someone back to after Submit for Approval.
//
// Every internal way into /tasks/<id> appends `returnTo` — the path and query of
// the page it was opened from — so the assignee lands on exactly the list they
// left: same tab, filters, search and page. That value arrives in a URL anybody
// can craft, so it is only ever used after `safeReturnPath` has proved it is an
// internal BOE path. Anything else — another site, a protocol, a backslash trick,
// a control character — is ignored and the task's own list is used instead.

export const RETURN_TO_PARAM = 'returnTo'

/** Far longer than any real list URL: a guard against pathological input, not a limit anyone meets. */
export const MAX_RETURN_PATH_LENGTH = 2048

// Resolved against a placeholder origin: a value that can change the origin names
// somewhere other than BOE.
const PLACEHOLDER_ORIGIN = 'https://boe.invalid'

const TASK_DETAIL_PATH = /^\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

// C0 controls, space, DEL and C1 controls. URL parsers silently strip tab and
// newline, which is how "/\t/evil.com" turns into "//evil.com" after a naive check.
function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/**
 * The value itself when it is an internal BOE path (`/tasks/my?tab=working`),
 * otherwise null. Returned unchanged, so the list comes back exactly as it was.
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

/** A page's own location as a return path: `/tasks/my` or `/tasks/my?tab=working&page=2`. */
export function pathWithSearch(pathname: string, search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  return query ? `${pathname}?${query}` : pathname
}

/** `/tasks/<id>?returnTo=<encoded source>`. A source that is not a safe internal path is left off. */
export function taskDetailHref(taskId: string, returnTo?: string | null): string {
  const base = `/tasks/${encodeURIComponent(taskId)}`
  const source = safeReturnPath(returnTo)
  return source ? `${base}?${RETURN_TO_PARAM}=${encodeURIComponent(source)}` : base
}

/** The validated `returnTo` a Task Detail query string carries, or null. */
export function returnPathFromSearch(search: string): string | null {
  return safeReturnPath(new URLSearchParams(search).get(RETURN_TO_PARAM))
}

/** Where a task's work lives when Task Detail was opened without a usable `returnTo`. */
export function defaultTaskListPath(taskType: string | null | undefined): string {
  return taskType === 'quotation_request' ? '/tasks/quotation-requests' : '/tasks/my'
}

/** A link with the source attached — only Task Detail links are rewritten; every other href passes through. */
export function withTaskReturnTo(href: string | null, returnTo: string | null | undefined): string | null {
  if (!href) return href
  const match = TASK_DETAIL_PATH.exec(href)
  return match ? taskDetailHref(match[1], returnTo) : href
}
