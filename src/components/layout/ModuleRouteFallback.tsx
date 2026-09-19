'use client'

import { useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from './OrdersLayout'
import { FinanceLayout } from './FinanceLayout'
import { ModulePageSkeleton, type ModulePageSkeletonVariant } from './ModulePageSkeleton'
import { pendingModuleTitle } from '@/lib/navigation/moduleNav'

// What an Orders or Finance route shows BEFORE its page has anything to say —
// used by the route-level loading.tsx boundaries and by the pages' own
// <Suspense> fallbacks.
//
// THE SHELL, NOT A SPINNER. The sidebar, the header with the page's own title,
// and a skeleton in the body. A click in the sidebar therefore changes the
// screen within a frame — the destination is lit, its name is in the header —
// even when the route's code or its server payload is still on the way (the two
// record routes are dynamic, so every visit waits on the server once).
//
// IT READS NOTHING. The layouts' own badge and permission hooks are shared,
// cached queries; this adds no request, and no page data is fetched until the
// page itself mounts under the reader's own session. No actions are drawn —
// every action is permission-derived, and nothing is permitted until the page
// has asked.

function useSignOut() {
  const router = useRouter()
  return useCallback(async () => {
    await createClient().auth.signOut()
    router.replace('/login')
  }, [router])
}

/** The skeleton that best matches what the path will render. */
export function skeletonVariantFor(pathname: string): ModulePageSkeletonVariant {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 1) return parts[0] === 'orders' ? 'dashboard' : 'list'
  if (parts[0] === 'orders' && parts[1] === 'drafts' && parts[2]) return 'record'
  if (parts[0] === 'orders' && parts.length === 2 &&
      !['drafts', 'all', 'import', 'notifications', 'requests'].includes(parts[1])) return 'record'
  return 'list'
}

export function OrdersRouteFallback() {
  const pathname = usePathname()
  const signOut = useSignOut()
  const title = pendingModuleTitle(pathname)
  return (
    <OrdersLayout profile={null} title={title} onSignOut={signOut} showRefresh={false}>
      <ModulePageSkeleton variant={skeletonVariantFor(pathname)} label={`Loading ${title}`} />
    </OrdersLayout>
  )
}

export function FinanceRouteFallback() {
  const pathname = usePathname()
  const signOut = useSignOut()
  const title = pendingModuleTitle(pathname)
  return (
    <FinanceLayout profile={null} title={title} onSignOut={signOut}>
      <ModulePageSkeleton variant={skeletonVariantFor(pathname)} label={`Loading ${title}`} />
    </FinanceLayout>
  )
}
