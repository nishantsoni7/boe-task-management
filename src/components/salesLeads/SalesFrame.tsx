'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { SalesLayout } from '@/components/layout/SalesLayout'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { createClient } from '@/lib/supabase/client'

/** The Sales shell with the signed-in person wired in, for every Sales page. */
export function SalesFrame({ title, subtitle, fill = false, actions, children }: { title: string; subtitle?: string; fill?: boolean; actions?: React.ReactNode; children: React.ReactNode }) {
  const { profile } = usePermissionContext()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const signOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }
  return <SalesLayout profile={profile} title={title} subtitle={subtitle} actions={actions} fill={fill} onSignOut={signOut}>{children}</SalesLayout>
}
