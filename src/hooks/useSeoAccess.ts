'use client'

import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { decideProposal, updatePlanItem, type SeoDecision } from '@/lib/seo/api'
import type { SeoPlanItem } from '@/lib/seo/report'
import { createClient } from '@/lib/supabase/client'

// What to SHOW. The database functions decide what is allowed. Authority is the signed-in person's, and nothing
// writes while an administrator is previewing somebody else.
export function useSeoAccess() {
  const { role, permissionsByModule } = usePermissionContext()
  const { readOnly } = useDisplaySubject()
  const holds = (action: string) => role === 'admin' || (permissionsByModule.get('seo') ?? []).some(p => p.actionKey === action && p.allowed)
  return { canEdit: !readOnly && holds('edit'), canDecide: !readOnly && holds('approve') }
}

export function useSeoWrites() {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['seo', 'data'] })
  return {
    saveItem: async (id: string, status: SeoPlanItem['status'], evidence: string) => {
      await updatePlanItem(supabase, id, status, evidence)
      await refresh()
    },
    decide: async (id: string, decision: SeoDecision, note: string) => {
      await decideProposal(supabase, id, decision, note)
      await refresh()
    },
  }
}
