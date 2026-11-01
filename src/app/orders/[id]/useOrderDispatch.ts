'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseDispatchData, type DispatchData } from '@/lib/orders/dispatch'

/**
 * The Order's dispatches. undefined while reading; null when this person has no
 * sight of them, which is the database's answer (order_dispatch_read): the
 * unscoped right to open the Order, because invoices show money.
 *
 * Nothing awaits it, so the Order page's startup is unchanged.
 */
export function useOrderDispatch(orderId: string | null, enabled: boolean): DispatchData | null | undefined {
  const supabase = useMemo(() => createClient(), [])
  const [read, setRead] = useState<{ orderId: string; data: DispatchData | null } | null>(null)

  useEffect(() => {
    if (!orderId || !enabled) return
    let live = true
    void (async () => {
      const { data, error } = await supabase.rpc('order_dispatch_read', { p_order_id: orderId })
      if (live) setRead({ orderId, data: error ? null : parseDispatchData(data) })
    })()
    return () => { live = false }
  }, [supabase, orderId, enabled])

  if (!enabled) return null
  return read && read.orderId === orderId ? read.data : undefined
}
