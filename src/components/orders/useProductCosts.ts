'use client'

// ── The Fabric & Finish sheet, read for the product list's tabs ──────────────
//
// The F&P Cost and Approvals tabs show each product's fabric, packing and
// approvals (owner, 2026-10-30). This is the sheet's own ONE read
// (order_submission_fabric_finish_read, 20270431000000), taken by the list
// itself, so the page's counted startup reads are unchanged and the database
// alone decides who may see the figures. A viewer it refuses, or a PI with no
// sheet, simply gets no figures.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseFabricFinishData, type FabricFinishData } from '@/lib/orders/fabricFinishCost'

/**
 * The PI's sheet: undefined while it is first being read, null when it cannot
 * be (refused, or no such PI).
 * `reloadKey` re-reads it: after the PI is re-read (a quantity may have changed)
 * and after a value is saved or a workbook is read again.
 * `enabled` false takes no read at all, for a page whose startup reads are
 * counted; what was already read stays.
 */
export function useProductCosts(
  submissionId: string,
  reloadKey: string | number,
  enabled = true,
): FabricFinishData | null | undefined {
  const [data, setData] = useState<FabricFinishData | null | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let live = true
    void (async () => {
      const { data: raw, error } = await createClient().rpc('order_submission_fabric_finish_read', { p_submission_id: submissionId })
      if (live) setData(error ? null : parseFabricFinishData(raw))
    })()
    return () => { live = false }
  }, [submissionId, reloadKey, enabled])
  return data
}
