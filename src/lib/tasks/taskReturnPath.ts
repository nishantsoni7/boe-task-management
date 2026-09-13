// Where Task Detail sends someone back to after Submit for Approval.
//
// Every internal way into /tasks/<id> appends `returnTo` — the path and query of
// the page it was opened from — so the assignee lands on exactly the list they
// left: same tab, filters, search and page. That value arrives in a URL anybody
// can craft, so it is only ever used after `safeReturnPath` has proved it is an
// internal BOE path. Anything else — another site, a protocol, a backslash trick,
// a control character — is ignored and the task's own list is used instead.
// The validator is shared with Account Settings and lives in src/lib/safeReturnPath.ts.

import { safeReturnPath } from '@/lib/safeReturnPath'

export { MAX_RETURN_PATH_LENGTH, safeReturnPath } from '@/lib/safeReturnPath'

export const RETURN_TO_PARAM = 'returnTo'

const TASK_DETAIL_PATH = /^\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

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
