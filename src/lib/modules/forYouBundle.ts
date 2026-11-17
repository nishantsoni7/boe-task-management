// THE FOR YOU COLUMN'S READS TRAVEL AS ONE REQUEST (2026-11-17, page speed; migration 20270730000000).
//
// When the Modules launcher opens, the For you column asks for the company's settings, the person's own choices,
// open cash handovers, cash on its way, and (Orders users) the PIs returned to them and flagged by Operations:
// each its own request, and again every minute. They ask in the same moment, so this waits a few milliseconds,
// gathers whoever asked, and sends ONE call to for_you_bundle, which runs the same reads as the caller.
//
// NOTHING CHANGES FOR A CALLER. It gets { data, error } exactly as if it had made its own read.
//  - Only ONE part asked (another screen reading cash on its way): it makes its own read.
//  - The bundle fails for ANY reason (function not there yet, network, an error): every caller makes its own read.
//  - A part missing from the answer (it raised in the database): that caller makes its own read, which reports
//    the error the way it always did.
//  - The same part asked twice with different arguments: the second makes its own read.

import { createClient } from '@/lib/supabase/client'

export type BundleAnswer = { data: unknown; error: { code?: string; message?: string } | null }

export type BundlePart = 'modes' | 'choices' | 'handovers' | 'unclosed' | 'returned' | 'flagged'
export const BUNDLE_PARTS: readonly BundlePart[] = ['modes', 'choices', 'handovers', 'unclosed', 'returned', 'flagged']

/** What a part needs: `choices` the person whose choices, `handovers` the statuses (the launcher's open list). */
export type BundleArgs = { choicesUser?: string; handoverStatuses?: readonly string[] }

export const BUNDLE_FUNCTION = 'for_you_bundle'
export const BUNDLE_WINDOW_MS = 10

export type Deps = {
  rpc: (args: { p_parts: BundlePart[]; p_choices_user: string | null; p_handover_statuses: string[] | null }) => PromiseLike<BundleAnswer>
  windowMs: number
  schedule: (run: () => void, ms: number) => void
}

const realDeps: Deps = {
  rpc: args => createClient().rpc(BUNDLE_FUNCTION, args) as unknown as PromiseLike<BundleAnswer>,
  windowMs: BUNDLE_WINDOW_MS,
  schedule: (run, ms) => { setTimeout(run, ms) },
}

type Waiter = { part: BundlePart; args: BundleArgs; direct: () => PromiseLike<BundleAnswer>; resolve: (a: BundleAnswer) => void; reject: (e: unknown) => void }

let open: { waiters: Waiter[] } | null = null

const argsKey = (w: Waiter) => JSON.stringify([w.args.choicesUser ?? null, w.args.handoverStatuses ?? null])

async function send(waiters: Waiter[], deps: Deps): Promise<void> {
  // The first asker of each part decides its arguments; anyone else asking that part differently goes alone.
  const lead = new Map<BundlePart, Waiter>()
  for (const w of waiters) if (!lead.has(w.part)) lead.set(w.part, w)
  const bundled = (w: Waiter) => argsKey(w) === argsKey(lead.get(w.part)!)

  let parts: Record<string, { data?: unknown }> | null = null
  if (lead.size > 1) {
    try {
      const { data, error } = await deps.rpc({
        p_parts: [...lead.keys()],
        p_choices_user: lead.get('choices')?.args.choicesUser ?? null,
        p_handover_statuses: lead.get('handovers')?.args.handoverStatuses ? [...lead.get('handovers')!.args.handoverStatuses!] : null,
      })
      if (!error && data && typeof data === 'object') parts = data as Record<string, { data?: unknown }>
    } catch {
      // Falls through: every caller makes its own read.
    }
  }

  for (const w of waiters) {
    const got = parts && bundled(w) ? parts[w.part] : undefined
    if (got && typeof got === 'object' && 'data' in got) { w.resolve({ data: got.data ?? null, error: null }); continue }
    Promise.resolve().then(w.direct).then(w.resolve, w.reject)
  }
}

/** One of the For you column's reads: `direct` is the read as it was, used whenever the bundle cannot answer. */
export function bundledRead(part: BundlePart, direct: () => PromiseLike<BundleAnswer>, args: BundleArgs = {}, deps: Deps = realDeps): Promise<BundleAnswer> {
  return new Promise((resolve, reject) => {
    if (!open) {
      const batch = { waiters: [] as Waiter[] }
      open = batch
      deps.schedule(() => {
        if (open === batch) open = null
        void send(batch.waiters, deps)
      }, deps.windowMs)
    }
    open.waiters.push({ part, args, direct, resolve, reject })
  })
}
