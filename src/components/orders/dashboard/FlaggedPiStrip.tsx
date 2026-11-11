'use client'

// "OPERATIONS FLAGGED N PIs" — the strip on the Orders dashboard of everybody who must answer one and
// is not shown the approver's "Needs your decision" (owner, 2026-11-11): the salesperson who owns the PI,
// an admin who does not approve PIs, a creator who is neither.
//
// One line per PI: the Order and client, who flagged it and how long it has waited, Operations' reason on
// one line, and a button to the Order, where Respond and resubmit is. The list is the database's own
// (public.my_flagged_pis, 20270611000000): whoever the answer door lets answer, on an Order they may open,
// while the flag is live. It leaves by itself the moment the PI is answered and resubmitted.
//
// It draws NOTHING when none waits, and nothing under View As (the read is the signed-in person's own).
// A read that fails says so in a line, never "nothing waits"; a database without the function has none.
// It looks like the "returned to you" strip (the same classes), because it is the same kind of thing.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  FLAGGED_LOAD_FAILED,
  FLAGGED_OPEN,
  FLAGGED_STRIP_HINT,
  flaggedHref,
  flaggedTitle,
  loadFlaggedPis,
  reasonLine,
  type FlaggedPi,
} from '@/lib/orders/flaggedPis'
import { waitingText } from '@/lib/orders/salespersonDashboard'
import { isReturnedPiUrgent } from '@/lib/orders/returnedPis'

export type FlaggedStripState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; rows: FlaggedPi[] }

export function FlaggedPiStrip({ supabase, viewingAs, reloadKey }: {
  supabase: SupabaseClient
  viewingAs: boolean
  /** Changes whenever the page re-reads the dashboard, so the strip is read again with it. */
  reloadKey: number
}) {
  const [state, setState] = useState<FlaggedStripState>({ kind: 'loading' })

  useEffect(() => {
    if (viewingAs) return
    let live = true
    void loadFlaggedPis({ rpc: async (fn: string) => supabase.rpc(fn) }).then(rows => {
      if (live) setState(rows ? { kind: 'ready', rows } : { kind: 'failed' })
    })
    return () => { live = false }
  }, [supabase, viewingAs, reloadKey])

  return viewingAs ? null : <FlaggedPiStripView state={state} />
}

export function FlaggedPiStripView({ state }: { state: FlaggedStripState }) {
  if (state.kind === 'loading') return null
  if (state.kind === 'failed') {
    return <p className="od-note" role="alert">{FLAGGED_LOAD_FAILED}</p>
  }
  if (state.rows.length === 0) return null
  return (
    <section className="spd-returned" aria-labelledby="flagged-pis-title" data-flagged-pis="true">
      <header className="spd-returned-head">
        <h2 id="flagged-pis-title" className="spd-returned-title">{flaggedTitle(state.rows.length)}</h2>
        <span className="spd-returned-hint">{FLAGGED_STRIP_HINT}</span>
      </header>
      <ul className="spd-returned-rows">
        {state.rows.map(r => (
          <li key={r.handoffId}>
            <Link href={withReturnTo(flaggedHref(r.orderId), '/orders')} className="spd-returned-row" prefetch={false}>
              <span className="spd-who">
                <span className="spd-num">{r.orderNumber}</span>
                <span className="spd-client">{r.clientName || 'Client not recorded'}</span>
              </span>
              <span className="spd-ret-meta">
                <span className="spd-meta">{r.byName ? `Flagged by ${r.byName}` : 'Flagged'} · PI V{r.versionNumber}</span>
                <span className="spd-pill" data-tone={isReturnedPiUrgent(r.waitingSeconds) ? 'alert' : 'warn'}>{waitingText(r.waitingSeconds)}</span>
                <span className="spd-meta">“{reasonLine(r.reason)}”</span>
              </span>
              <span className="spd-open" aria-hidden="true">{FLAGGED_OPEN}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
