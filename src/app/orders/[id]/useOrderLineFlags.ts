'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadLineFlags, type LineFlagsRead } from '@/lib/orders/lineFlags'

/**
 * The line flags of the Order's live PI review (20270616000000). undefined while reading. Read again
 * whenever `reloadKey` changes (the page passes the live handoff's id and status, which move with every
 * decision). Nothing awaits it, so the Order page's startup is unchanged.
 */
export function useOrderLineFlags(orderId: string | null, reloadKey: string): LineFlagsRead | undefined {
  const supabase = useMemo(() => createClient(), [])
  const [read, setRead] = useState<{ key: string; data: LineFlagsRead } | null>(null)
  const key = `${orderId ?? ''}|${reloadKey}`

  useEffect(() => {
    if (!orderId) return
    let live = true
    void loadLineFlags(supabase, orderId).then(data => { if (live) setRead({ key, data }) })
    return () => { live = false }
  }, [supabase, orderId, key])

  // While a re-read is in flight the last answer for THIS Order stands, so the flags do not blink off.
  return read && read.key.startsWith(`${orderId ?? ''}|`) ? read.data : undefined
}
