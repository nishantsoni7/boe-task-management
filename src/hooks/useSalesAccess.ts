'use client'

import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'

// What to SHOW. The database functions decide what is allowed (create_sales_lead, update_sales_lead and
// allot_sales_lead each check their own right). Authority is the signed-in person's, and nothing writes while an
// administrator is previewing somebody else.
export function useSalesAccess() {
  const { role, permissionsByModule } = usePermissionContext()
  const { readOnly } = useDisplaySubject()
  const holds = (action: string) => role === 'admin' || (permissionsByModule.get('sales') ?? []).some(p => p.actionKey === action && p.allowed)
  return {
    canCreate: !readOnly && holds('create'),
    canEdit: !readOnly && holds('edit'),
    canAssign: !readOnly && holds('assign'),
  }
}
