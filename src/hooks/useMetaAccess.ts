'use client'

import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'

// What to SHOW. meta_set_targets decides what is allowed. Authority is the signed-in person's, and nothing writes
// while an administrator is previewing somebody else.
export function useMetaAccess() {
  const { role, permissionsByModule } = usePermissionContext()
  const { readOnly } = useDisplaySubject()
  const holds = (action: string) => role === 'admin' || (permissionsByModule.get('marketing') ?? []).some(p => p.actionKey === action && p.allowed)
  return { canEdit: !readOnly && holds('edit') }
}
