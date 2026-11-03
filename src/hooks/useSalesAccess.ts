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
    /** Sees every lead: the "Leads of" chips, and the queue waiting to be allotted. */
    canSeeAll: holds('view_all') || holds('assign'),
    /** The register is for whoever adds, allots or oversees leads. A salesperson lives on My day and the board. */
    canOpenRegister: holds('create') || holds('assign') || holds('view_all'),
    /** The manager's page. */
    canOpenTeam: holds('view_all') || holds('assign'),
    /** Nothing may be logged or moved while previewing somebody else. */
    readOnly,
  }
}
