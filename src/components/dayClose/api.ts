'use client'

// The browser's side of /api/day-close/*: the bearer token on every call, and a failure turned into words.

import { createClient } from '@/lib/supabase/client'
import { batchedGet, isBatchable } from './batchedGet'

export async function dayCloseFetch<T = Record<string, unknown>>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; raw?: Blob } = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    // The launcher's four GETs travel as one request (src/components/dayClose/batchedGet.ts); the caller
    // still gets what its own route would have answered, and a failed batch falls back to that route.
    if (!init.method && init.body === undefined && !init.raw && isBatchable(path)) {
      const r = await batchedGet(path)
      if (r.status >= 200 && r.status < 300) return { ok: true, data: r.body as T }
      if (r.status === 0) return { ok: false, error: 'Could not reach BOE. Check your connection and try again.' }
      return { ok: false, error: typeof r.body.error === 'string' ? r.body.error : 'Something went wrong. Try again.' }
    }
    const { data: { session } } = await createClient().auth.getSession()
    if (!session) return { ok: false, error: 'Your session has expired. Sign in again.' }
    const headers: Record<string, string> = { authorization: `Bearer ${session.access_token}` }
    let body: BodyInit | undefined
    if (init.raw) {
      headers['content-type'] = 'image/jpeg'
      body = init.raw
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    const res = await fetch(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, cache: 'no-store' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: typeof json.error === 'string' ? json.error : 'Something went wrong. Try again.' }
    return { ok: true, data: json as T }
  } catch {
    return { ok: false, error: 'Could not reach BOE. Check your connection and try again.' }
  }
}

/** "10:42 am" in India, from an instant. */
export function istClock(instant: string | null | undefined): string {
  if (!instant) return '—'
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}

/** "Thu, 12 Nov" from an IST date. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}
