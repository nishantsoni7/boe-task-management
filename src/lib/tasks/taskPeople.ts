// Everyone a task screen may have to name, active or not.
//
// WHY THIS GOES THROUGH THE SERVER.
//
// The `users` row policy has been `is_active = true` since 20260812000000, so a
// browser read returns no row at all for a deactivated person. Their tasks and
// their history stay, and every screen that looked the name up fell through to
// "member", "Unknown" or "Someone". Widening that policy is the wrong fix: it
// was tightened on purpose, and code that selects from `users` without filtering
// relies on it to keep leavers out of its dropdowns.
//
// So the names come from /api/tasks/people, which reads them with the service
// role and hands back these three fields and nothing else.

export type TaskPerson = { id: string; full_name: string; is_active: boolean }

type PersonRow = { id: string; full_name: string | null; is_active: boolean | null }

/** The three fields a task screen may see. Nothing else about a person leaves the server. */
export function toTaskPeople(rows: readonly PersonRow[]): TaskPerson[] {
  return rows
    .filter(r => !!r.full_name)
    .map(r => ({ id: r.id, full_name: r.full_name as string, is_active: r.is_active === true }))
}

// The request already on its way. Two hooks on one page (the name list and Team response on
// Assigned By Me) ask at the same moment; they share it. Nothing is kept once it answers, so no
// list outlives its request and none is carried over to whoever signs in next.
let inFlight: Promise<TaskPerson[] | null> | null = null

/** Null when the route could not answer, so the caller can fall back rather than draw nobody. */
export function fetchTaskPeople(): Promise<TaskPerson[] | null> {
  inFlight ??= requestTaskPeople().finally(() => { inFlight = null })
  return inFlight
}

async function requestTaskPeople(): Promise<TaskPerson[] | null> {
  try {
    const res = await fetch('/api/tasks/people')
    if (!res.ok) return null
    const body = await res.json() as { people?: TaskPerson[] }
    return Array.isArray(body.people) ? body.people : null
  } catch {
    return null
  }
}
