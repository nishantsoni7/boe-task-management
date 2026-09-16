/**
 * Where the shared header's "Self Task" / "Delegate Task" buttons appear.
 *
 * They belong to Task Management screens. Notifications is a reading surface,
 * and every Quotation screen is its own workflow with its own creation control
 * ("New Request") — a task-creation shortcut there reads as the way to raise a
 * quotation, which it is not.
 *
 * Two inputs, because a route cannot answer on its own: a quotation's detail
 * page shares `/tasks/[id]` with every ordinary task, and only the loaded row's
 * `task_type` tells them apart. That page passes `hideTaskCreateActions`.
 */

/** Routes (and everything beneath them) that never show the buttons. */
export const TASK_CREATE_ACTIONS_HIDDEN_ROUTES = [
  '/notifications',
  '/tasks/quotation-requests',
] as const

export function isTaskCreateActionsHiddenRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  return TASK_CREATE_ACTIONS_HIDDEN_ROUTES.some(
    route => path === route || path.startsWith(`${route}/`),
  )
}

export function shouldShowTaskCreateActions({
  pathname,
  inViewMode,
  hideTaskCreateActions = false,
}: {
  pathname: string | null | undefined
  inViewMode: boolean
  hideTaskCreateActions?: boolean
}): boolean {
  // View As is read-only, exactly as before.
  if (inViewMode) return false
  if (hideTaskCreateActions) return false
  return !isTaskCreateActionsHiddenRoute(pathname)
}
