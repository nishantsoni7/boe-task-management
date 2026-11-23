'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { beginNavWait } from '@/lib/navigation/navWait'
import { startOpeningReads } from '@/lib/quotations/openQuotation'

type Supabase = ReturnType<typeof createClient>

/** If the page has still not arrived after this, the row is released so the person can press it again. */
export const OPEN_GIVE_UP_MS = 15_000

/**
 * The way a row in Quotations opens a quotation (23 Nov 2026, page speed).
 *
 * `router.push` bypasses AppLink, so the app's loader never knew a click was waiting: the row sat unchanged for the
 * second or two the page took, and people pressed it again. Now the click (1) marks the row as opening at once, (2)
 * starts the quotation's reads beside the page's own loading (openQuotation.ts), (3) turns on the same full-screen
 * wait AppLink uses (it shows after its own 1.2 s pause, so a quick open never flashes it), and (4) ignores further
 * presses until the page arrives (the row unmounts with the old page) or OPEN_GIVE_UP_MS passes.
 */
export function useOpenQuotation(supabase: Supabase) {
  const router = useRouter()
  const qc = useQueryClient()
  const [opening, setOpening] = useState<string | null>(null)
  const busy = useRef(false)

  const open = useCallback((id: string) => {
    if (busy.current) return
    busy.current = true
    setOpening(id)
    startOpeningReads(qc, supabase, id)
    router.push(`/quotations/${id}`)
  }, [qc, supabase, router])

  useEffect(() => {
    if (!opening) return
    const endWait = beginNavWait(document.documentElement)
    const giveUp = setTimeout(() => { busy.current = false; setOpening(null) }, OPEN_GIVE_UP_MS)
    return () => { endWait(); clearTimeout(giveUp) }
  }, [opening])

  return { open, opening }
}
