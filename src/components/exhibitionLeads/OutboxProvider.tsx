'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { EXHIBITION_LEADS_KEY, createLead, LeadRequestError } from '@/lib/exhibitionLeads/api'
import {
  afterAnswer, afterError, isUnsent, loadOutbox, nextToSend, resend, retryDelayMs, storeOutbox,
  type OutboxEntry,
} from '@/lib/exhibitionLeads/outbox'
import { standingsKey } from '@/lib/exhibitionLeads/queries'
import { withMyDelta, type Standings } from '@/lib/exhibitionLeads/standings'

// The outbox lives HERE, above every Exhibition Leads page, not inside the Add
// Lead screen. A salesperson taps Save, the form clears, and a second later they
// are on My Leads: the sending must carry on across that move, and entries still
// waiting must go out no matter which page is open. Mounted by the route layout
// once the session and module access are known.

type Ctx = {
  entries: readonly OutboxEntry[]
  /** The green "Saved — …" confirmation, for a few seconds. */
  justSaved: string | null
  enqueue: (entry: OutboxEntry) => void
  patch: (id: string, fn: (e: OutboxEntry) => OutboxEntry) => void
  remove: (id: string) => void
  retry: (id: string) => void
  flash: (message: string) => void
  clearFlash: () => void
  /** Leads of this exhibition that are still on their way (counted on screen before the server confirms). */
  pendingFor: (exhibitionId: string | null) => number
}

const OutboxContext = createContext<Ctx | null>(null)

export function useOutbox(): Ctx {
  const ctx = useContext(OutboxContext)
  if (!ctx) throw new Error('useOutbox needs the OutboxProvider (mounted by the Exhibition Leads layout)')
  return ctx
}

// How long the green confirmation stays.
const SAVED_FLASH_MS = 5000

export function OutboxProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), [])
  const qc = useQueryClient()
  const [entries, setEntries] = useState<OutboxEntry[]>([])
  const [justSaved, setJustSaved] = useState<string | null>(null)
  // Whose saved entries have been read back from storage (nothing is written before that).
  const [outboxUser, setOutboxUser] = useState<string | null>(null)
  const inFlight = useRef<string | null>(null)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const dirty = useRef(false)

  const patch = useCallback((id: string, fn: (e: OutboxEntry) => OutboxEntry) => {
    setEntries(list => list.map(e => (e.id === id ? fn(e) : e)))
  }, [])
  const enqueue = useCallback((entry: OutboxEntry) => {
    setJustSaved(null)
    setEntries(list => [...list, entry])
  }, [])
  const remove = useCallback((id: string) => setEntries(list => list.filter(e => e.id !== id)), [])
  const retry = useCallback((id: string) => patch(id, resend), [patch])
  const flash = useCallback((message: string) => setJustSaved(message), [])
  const clearFlash = useCallback(() => setJustSaved(null), [])

  // Entries owed from an earlier visit (a closed tab, a dropped connection) come back and are sent.
  // (Read after a microtask: the storage is an external system, and the state
  // is set in a callback of that read, not while the effect body runs.)
  useEffect(() => {
    let live = true
    void Promise.resolve().then(() => {
      if (!live) return
      const owed = loadOutbox(userId)
      if (owed.length) setEntries(list => [...owed.filter(o => !list.some(e => e.id === o.id)), ...list])
      setOutboxUser(userId)
    })
    return () => { live = false }
  }, [userId])

  // …and what is still owed is kept, so it survives a reload.
  useEffect(() => {
    if (outboxUser === userId) storeOutbox(userId, entries)
  }, [userId, outboxUser, entries])

  // Send the oldest waiting entry; one at a time keeps the order and spares a weak connection.
  useEffect(() => {
    if (inFlight.current) return
    const next = nextToSend(entries)
    if (!next) return
    inFlight.current = next.id
    ;(async () => {
      try {
        const res = await createLead(supabase, { submissionId: next.id, exhibitionId: next.exhibitionId, ...next.args })
        patch(next.id, e => afterAnswer(e, res))
        if (res.outcome === 'created' || res.outcome === 'replayed') {
          dirty.current = true
          if (res.outcome === 'created') {
            qc.setQueryData<Standings | undefined>(standingsKey(next.exhibitionId), d => withMyDelta(d, 1))
          }
          setJustSaved(next.name)
        }
      } catch (e) {
        const err = e as LeadRequestError
        patch(next.id, x => afterError(x, { kind: err.kind ?? 'unknown', message: err.message }))
      } finally {
        inFlight.current = null
      }
    })()
  }, [entries, supabase, qc, patch])

  // A failed send tries again by itself, a little later each time.
  useEffect(() => {
    for (const e of entries) {
      if (e.status === 'retry' && !timers.current.has(e.id)) {
        timers.current.set(e.id, setTimeout(() => {
          timers.current.delete(e.id)
          patch(e.id, resend)
        }, retryDelayMs(e.attempts)))
      }
    }
  }, [entries, patch])
  useEffect(() => {
    const t = timers.current
    return () => { t.forEach(clearTimeout); t.clear() }
  }, [])

  // The connection came back: do not wait for the timer.
  useEffect(() => {
    const again = () => setEntries(list => list.map(e => (e.status === 'retry' ? resend(e) : e)))
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])

  // Once everything has been answered, bring the numbers and the lists in line with the database.
  const waiting = entries.some(isUnsent)
  useEffect(() => {
    if (!waiting && dirty.current) {
      dirty.current = false
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    }
  }, [waiting, qc])

  // Closing the tab while something is still on its way: ask first.
  useEffect(() => {
    if (!entries.some(e => e.status === 'saving' || e.status === 'retry')) return
    const warn = (ev: BeforeUnloadEvent) => { ev.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [entries])

  // The green confirmation fades by itself.
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(null), SAVED_FLASH_MS)
    return () => clearTimeout(t)
  }, [justSaved])

  const pendingFor = useCallback(
    (exhibitionId: string | null) => entries.filter(e => isUnsent(e) && e.exhibitionId === exhibitionId).length,
    [entries],
  )

  const value = useMemo<Ctx>(
    () => ({ entries, justSaved, enqueue, patch, remove, retry, flash, clearFlash, pendingFor }),
    [entries, justSaved, enqueue, patch, remove, retry, flash, clearFlash, pendingFor],
  )
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>
}
