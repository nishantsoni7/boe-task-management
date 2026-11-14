// THE LAUNCHER'S BADGE COUNTS TRAVEL AS ONE REQUEST (2026-11-14, page speed part 7).
//
// Task, Finance, Orders and Sample Tracking each fetch their own unread count when the Modules page opens
// cold: four server functions for four small numbers. They all ask in the same moment, so this waits a few
// milliseconds, gathers whoever asked, and sends ONE request to /api/notifications/counts, which runs the
// same two count routes and hands back each answer with the status its own route would have sent.
// The sibling of src/components/dayClose/batchedGet.ts (that one carries a bearer token; these routes sign
// the caller in from the cookie, so there is no token here).
//
// NOTHING CHANGES FOR A CALLER. It passes the URL it always fetched and gets { status, body } as if it had
// fetched it itself.
//  - Only ONE count asked (a module shell, a sidebar): its own URL is fetched directly, as before.
//  - The batch fails for ANY reason (network, error status, an answer that does not name the part): every
//    caller is answered by its own route. The two routes are untouched.
//  - Only the two count routes, with exactly their known parameters, are batched; any other URL is fetched
//    as it is.
//
// status 0 means the server could not be reached at all.

export type CountResult = { status: number; body: Record<string, unknown> }

export const COUNTS_ROUTE = '/api/notifications/counts'
export const COUNTS_WINDOW_MS = 10

const NOTIFICATION_PARAMS = new Set(['count', 'category', 'subjectUserId'])

/** The part and subject a count URL stands for, or null when it is not one of the two batchable count requests. */
export function countPartOf(url: string): { part: string; subject: string | null } | null {
  let parsed: URL
  try { parsed = new URL(url, 'http://local') } catch { return null }
  if (parsed.searchParams.get('count') !== '1') return null
  const keys = [...parsed.searchParams.keys()]
  if (parsed.pathname === '/api/samples/notifications') {
    return keys.every(k => k === 'count') ? { part: 'sample', subject: null } : null
  }
  if (parsed.pathname === '/api/notifications') {
    const category = parsed.searchParams.get('category')
    if (!category || !keys.every(k => NOTIFICATION_PARAMS.has(k))) return null
    return { part: category, subject: parsed.searchParams.get('subjectUserId') }
  }
  return null
}

export type CountDeps = {
  fetchImpl: typeof fetch
  windowMs: number
  schedule: (run: () => void, ms: number) => void
}

const realDeps: CountDeps = {
  fetchImpl: (...args) => fetch(...args),
  windowMs: COUNTS_WINDOW_MS,
  schedule: (run, ms) => { setTimeout(run, ms) },
}

type Waiter = { url: string; part: string; subject: string | null; resolve: (result: CountResult) => void }

let open: { waiters: Waiter[] } | null = null

async function fetchOne(url: string, deps: CountDeps): Promise<CountResult> {
  try {
    const res = await deps.fetchImpl(url)
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body: body && typeof body === 'object' ? body : {} }
  } catch {
    return { status: 0, body: {} }
  }
}

async function sendGroup(group: Waiter[], subject: string | null, deps: CountDeps): Promise<void> {
  const urlOf = new Map<string, string>()
  for (const w of group) if (!urlOf.has(w.part)) urlOf.set(w.part, w.url)
  const parts = [...urlOf.keys()]
  const answers = new Map<string, CountResult>()

  if (parts.length > 1) {
    try {
      const res = await deps.fetchImpl(
        `${COUNTS_ROUTE}?parts=${parts.join(',')}${subject ? `&subjectUserId=${encodeURIComponent(subject)}` : ''}`,
        { cache: 'no-store' },
      )
      const json = res.ok ? await res.json().catch(() => null) : null
      const answered = json && typeof json === 'object' ? (json as { parts?: Record<string, unknown> }).parts : undefined
      for (const part of parts) {
        const a = answered?.[part] as Partial<CountResult> | undefined
        if (a && typeof a.status === 'number' && a.body && typeof a.body === 'object') {
          answers.set(part, { status: a.status, body: a.body as Record<string, unknown> })
        }
      }
    } catch {
      // Falls through: every part not answered above is asked of its own route.
    }
  }

  await Promise.all(parts.filter(p => !answers.has(p)).map(async p => {
    answers.set(p, await fetchOne(urlOf.get(p) as string, deps))
  }))
  for (const w of group) w.resolve(answers.get(w.part) as CountResult)
}

async function send(waiters: Waiter[], deps: CountDeps): Promise<void> {
  const bySubject = new Map<string | null, Waiter[]>()
  for (const w of waiters) bySubject.set(w.subject, [...(bySubject.get(w.subject) ?? []), w])
  await Promise.all([...bySubject].map(([subject, group]) => sendGroup(group, subject, deps)))
}

/** Fetch a count URL exactly as `fetch(url)` would, sharing one request with the other counts asked in the same moment. */
export function batchedCountGet(url: string, deps: CountDeps = realDeps): Promise<CountResult> {
  const which = countPartOf(url)
  if (!which) return fetchOne(url, deps)
  return new Promise(resolve => {
    if (!open) {
      const batch = { waiters: [] as Waiter[] }
      open = batch
      deps.schedule(() => {
        if (open === batch) open = null
        void send(batch.waiters, deps)
      }, deps.windowMs)
    }
    open.waiters.push({ url, part: which.part, subject: which.subject, resolve })
  })
}
