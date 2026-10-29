'use client'

// FABRIC & FINISH COST SHEET OF A PI DRAFT — its own page (owner, 2026-10-29:
// the sheet slides in over the PI on a desktop and opens here on a phone or
// from "Open as a page"). The PI page links here with a button; this page
// links back.
//
// Who may see it is the database's answer (order_submission_fabric_finish_read
// asks for the Orders entry gate and the right to see the PI). This page only
// draws the sheet.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'
import { FabricFinishSheet, FABRIC_FINISH_TITLE } from '@/components/orders/FabricFinishSheet'

export default function PiFabricFinishPage() {
  const { submissionId } = useParams<{ submissionId: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [clientName, setClientName] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'missing' | 'ready'>('loading')

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, piRes] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        supabase.from('order_submissions').select('id, client_name').eq('id', submissionId).maybeSingle(),
      ])
      if (!live) return
      const meRow = me.data as UserProfile | null
      if (meRow) setProfile(meRow)
      const pi = piRes.data as { id: string; client_name: string | null } | null
      if (piRes.error || !pi) { setState('missing'); return }
      setClientName(pi.client_name)
      setState('ready')
    })()
    return () => { live = false }
  }, [supabase, submissionId, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <OrdersLayout profile={profile} title={FABRIC_FINISH_TITLE} onSignOut={handleSignOut} showRefresh={false}>
      <div className={'ff-page'}>
        <button type="button" className={'ff-back'} onClick={() => router.push(`/orders/drafts/${submissionId}`)}>← Back to the PI</button>
        {state === 'loading' && <p className={'ff-note'} role="status">Opening…</p>}
        {state === 'missing' && (
          <p className={'ff-alert'} role="alert">This PI is not available to you, or it does not exist.</p>
        )}
        {state === 'ready' && (
          <div className={'ff-page-card'}>
            <FabricFinishSheet
              submissionId={submissionId}
              variant="page"
              context={clientName ? `PI · ${clientName}` : 'PI'}
            />
          </div>
        )}
      </div>
    </OrdersLayout>
  )
}
