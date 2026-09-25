'use client'

import { useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { BoeOsLayout } from '@/components/layout/BoeOsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useMyAnnouncements } from '@/hooks/queries/useAnnouncements'

// Announcements live in the BOE OS shell beside Home, not inside a module: every
// signed-in employee reaches them, and what each one sees is decided by the
// database (named recipient, live today). No module permission is involved.
export function AnnouncementsShell({
  title, subtitle, children,
}: {
  title: string
  subtitle?: string
  children: (ctx: { userId: string; isAdmin: boolean }) => React.ReactNode
}) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { ready, userId, role, profile } = usePermissionContext()
  const { data: mine = [] } = useMyAnnouncements(userId)

  useEffect(() => {
    if (ready && userId === null) router.replace('/login')
  }, [ready, userId, router])

  if (!ready || !userId) return <LoadingScreen />

  return (
    <BoeOsLayout
      profile={profile}
      title={title}
      subtitle={subtitle}
      onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
      contentMaxWidth={880}
      announcementUnread={mine.filter(a => !a.read_at).length}
    >
      {children({ userId, isAdmin: role === 'admin' })}
    </BoeOsLayout>
  )
}
