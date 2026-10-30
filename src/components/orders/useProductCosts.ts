'use client'

// ── The cost sheet, read for the product list ────────────────────────────────
//
// The PI Draft page shows each product's fabric and packing beside it (owner,
// 2026-10-30). This is the cost sheet's own ONE read
// (order_submission_fabric_finish_read, 20270431000000), taken by the list
// itself, as FabricFinishSheet takes it — so the page's counted startup reads
// are unchanged and the database alone decides who may see the figures. A
// viewer it refuses, or a PI with no sheet, simply gets no figures.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseFabricFinishData, type FabricFinishData } from '@/lib/orders/fabricFinishCost'

/**
 * The PI's cost sheet: undefined while it is first being read, null when it
 * cannot be (refused, or no such PI).
 * `reloadKey` re-reads it: after the PI is re-read (a quantity may have changed)
 * and after the cost sheet panel closes (a value may have been typed).
 */
export function useProductCosts(submissionId: string, reloadKey: string | number): FabricFinishData | null | undefined {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<FabricFinishData | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void (async () => {
      const { data: raw, error } = await supabase.rpc('order_submission_fabric_finish_read', { p_submission_id: submissionId })
      if (live) setData(error ? null : parseFabricFinishData(raw))
    })()
    return () => { live = false }
  }, [supabase, submissionId, reloadKey])
  return data
}
