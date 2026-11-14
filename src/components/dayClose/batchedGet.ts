// THE LAUNCHER'S FOUR DAY-CLOSE / SCOREBOARD GETS TRAVEL AS ONE REQUEST (2026-11-14, page speed part 6).
//
// The Day Close strip, the score card, the vote card and the Star Seller card each fetched their own route
// on every visit to the Modules page: four server functions, each checking the caller and reading the
// settings, to be told "nothing" while Day Close is paused. They all ask in the same moment, so this waits
// a few milliseconds, gathers whoever asked, and sends ONE request to /api/day-close/launcher, which runs
// the same four loaders and hands back each answer with the status its own route would have sent.
//
// NOTHING CHANGES FOR A CALLER. It gets { status, body } exactly as if it had fetched its own route.
//  - Only ONE route asked (the score line on another screen): it goes to that route directly.
//  - The batch fails for ANY reason (network, error status, an answer that does not name the part): every
//    caller is answered by its own route, as before this existed. The four routes are untouched.
//  - A POST is never batched: only these four GETs are known, by their exact path.
//
// status 0 means the server could not be reached at all.

import { createClient } from '@/lib/supabase/client'

export type PartResult = { status: number; body: Record<string, unknown> }

/** Each batchable route and the part name /api/day-close/launcher answers it under. */
const PART_OF: Readonly<Record<string, string>> = {
  '/api/day-close/prompt': 'prompt',
  '/api/scoreboard/me': 'me',
  '/api/scoreboard/vote': 'vote',
  '/api/scoreboard/star-seller': 'starSeller',
}

export const BATCH_ROUTE = '/api/day-close/launcher'
export const BATCH_WINDOW_MS = 10

export const isBatchable = (path: string): boolean => path in PART_OF

export type Deps = {
  getToken: () => Promise<string | null>
  fetchImpl: typeof fetch
  windowMs: number
  schedule: (run: () => void, ms: number) => void
}

const realDeps: Deps = {
  getToken: async () => (await createClient().auth.getSession()).data.session?.access_token ?? null,
  fetchImpl: (...args) => fetch(...args),
  windowMs: BATCH_WINDOW_MS,
  schedule: (run, ms) => { setTimeout(run, ms) },
}

type Waiter = { path: string; resolve: (result: PartResult) => void }

// One open batch at a time; a call after it was sent opens the next one.
let open: { waiters: Waiter[] } | null = null

async function fetchOne(path: string, token: string, deps: Deps): Promise<PartResult> {
  try {
    const res = await deps.fetchImpl(path, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body: body && typeof body === 'object' ? body : {} }
  } catch {
    return { status: 0, body: {} }
  }
}

async function send(waiters: Waiter[], deps: Deps): Promise<void> {
  const token = await deps.getToken().catch(() => null)
  if (!token) {
    for (const w of waiters) w.resolve({ status: 401, body: { error: 'Your session has expired. Sign in again.' } })
    return
  }
  const paths = [...new Set(waiters.map(w => w.path))]
  const answers = new Map<string, PartResult>()

  if (paths.length > 1) {
    try {
      const res = await deps.fetchImpl(`${BATCH_ROUTE}?parts=${paths.map(p => PART_OF[p]).join(',')}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const json = res.ok ? await res.json().catch(() => null) : null
      const parts = json && typeof json === 'object' ? (json as { parts?: Record<string, unknown> }).parts : undefined
      for (const path of paths) {
        const part = parts?.[PART_OF[path]] as Partial<PartResult> | undefined
        if (part && typeof part.status === 'number' && part.body && typeof part.body === 'object') {
          answers.set(path, { status: part.status, body: part.body as Record<string, unknown> })
        }
      }
    } catch {
      // Falls through: every route not answered above is asked for itself.
    }
  }

  const missing = paths.filter(path => !answers.has(path))
  await Promise.all(missing.map(async path => { answers.set(path, await fetchOne(path, token, deps)) }))
  for (const w of waiters) w.resolve(answers.get(w.path) as PartResult)
}

export function batchedGet(path: string, deps: Deps = realDeps): Promise<PartResult> {
  return new Promise(resolve => {
    if (!open) {
      const batch = { waiters: [] as Waiter[] }
      open = batch
      deps.schedule(() => {
        if (open === batch) open = null
        void send(batch.waiters, deps)
      }, deps.windowMs)
    }
    open.waiters.push({ path, resolve })
  })
}
