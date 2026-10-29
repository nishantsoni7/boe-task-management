'use client'

// FABRIC & FINISH COST FOR A PI DRAFT — the workbook's own two sheets, on a
// page of their own (owner, 2026-10-29).
//
// Who may open it is whoever may open the PI: the row is read under the
// reader's own RLS here, and the route that parses the stored workbook reads
// the same row the same way before it touches storage. Nothing on this page
// writes; nothing typed here exists.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { RecordBackLink } from '@/components/layout/RecordBackLink'
import { AmountMaskRegion, AmountsToggle, useAmountsHidden } from '@/components/orders/AmountMask'
import { FabricFinishView, type FabricFinishPiFacts } from '@/components/orders/FabricFinishView'
import { FABRIC_FINISH_PAGE_TITLE } from '@/lib/orders/editPiPage'
import { draftDetailHref, formatSavedAt, toNumber } from '@/lib/orders/draftsView'
import { FABRIC_COST_SHEET_NAME, FABRIC_FINISH_SHEET_NAME, type FabricFinishSheets } from '@/lib/pi/fabricFinishSheets'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'

type PiRow = {
  id: string
  client_name: string | null
  draft_reference: string | null
  source_workbook_name: string | null
  updated_at: string | null
  fabric_cost: number | string | null
  fabric_cost_text: string | null
  packing_cost: number | string | null
  packing_cost_text: string | null
}

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; pi: PiRow; message: string }
  | { kind: 'ready'; pi: PiRow; sheets: FabricFinishSheets; facts: FabricFinishPiFacts }

// Not exported: a Next page may export only its own conventions.
const FABRIC_FINISH_ROUTE = '/api/orders/submissions/fabric-finish'
const PI_COLUMNS = 'id, client_name, draft_reference, source_workbook_name, updated_at, fabric_cost, fabric_cost_text, packing_cost, packing_cost_text'

/** What the route said when it could not answer, in the reader's words. */
function describeRouteFailure(status: number, body: { code?: string; message?: string } | null): string {
  if (body?.message) return body.message
  if (status === 404) return 'This PI could not be found.'
  if (status === 401) return 'Your session has ended. Sign in again to read the workbook.'
  return 'The workbook could not be read just now.'
}

export default function FabricFinishPage() {
  const { submissionId } = useParams<{ submissionId: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [amountsHidden, setAmountsHidden] = useAmountsHidden()

  useEffect(() => {
    let live = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const [me, piRes, itemsRes] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        supabase.from('order_submissions').select(PI_COLUMNS).eq('id', submissionId).maybeSingle(),
        supabase.from('order_submission_items').select('source_row, quantity').eq('submission_id', submissionId),
      ])
      if (!live) return
      if (me.data) setProfile(me.data as UserProfile)
      const pi = piRes.data as PiRow | null
      if (piRes.error || !pi) { setState({ kind: 'missing' }); return }

      const piQuantityByRow = new Map<number, number | null>()
      for (const item of (itemsRes.data ?? []) as { source_row: number | string; quantity: number | string | null }[]) {
        const row = toNumber(item.source_row)
        if (row !== null) piQuantityByRow.set(row, toNumber(item.quantity))
      }
      const facts: FabricFinishPiFacts = {
        fabricCost: toNumber(pi.fabric_cost),
        fabricCostText: pi.fabric_cost_text,
        packingCost: toNumber(pi.packing_cost),
        packingCostText: pi.packing_cost_text,
        piQuantityByRow,
      }

      let response: Response
      try {
        response = await fetch(`${FABRIC_FINISH_ROUTE}?submissionId=${encodeURIComponent(submissionId)}`, { credentials: 'same-origin' })
      } catch {
        if (live) setState({ kind: 'failed', pi, message: 'The workbook could not be read just now.' })
        return
      }
      const body = await response.json().catch(() => null) as { ok?: boolean; sheets?: FabricFinishSheets; code?: string; message?: string } | null
      if (!live) return
      if (!response.ok || !body?.ok || !body.sheets) {
        setState({ kind: 'failed', pi, message: describeRouteFailure(response.status, body) })
        return
      }
      setState({ kind: 'ready', pi, sheets: body.sheets, facts })
    })()
    return () => { live = false }
  }, [supabase, submissionId, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const pi = state.kind === 'ready' || state.kind === 'failed' ? state.pi : null
  const subtitle = pi ? [pi.draft_reference, pi.client_name].filter(Boolean).join(' · ') || undefined : undefined

  return (
    <OrdersLayout
      profile={profile}
      title={FABRIC_FINISH_PAGE_TITLE}
      subtitle={subtitle}
      onSignOut={handleSignOut}
      showRefresh={false}
      actions={<AmountsToggle hidden={amountsHidden} onChange={setAmountsHidden} />}
    >
      <AmountMaskRegion hidden={amountsHidden}>
        <div className="pi-detail-stack pi-ff-page">
          <RecordBackLink fallbackHref={draftDetailHref(submissionId)} className="order-back" />

          {state.kind === 'loading' && <div className="pi-edit-loading" role="status">Reading the workbook…</div>}
          {state.kind === 'missing' && <p className="pi-ff-empty">This PI could not be found.</p>}

          {pi && (
            <header className="pi-ff-head">
              <h2 className="pi-ff-title">{FABRIC_FINISH_PAGE_TITLE}</h2>
              <p className="pi-ff-meta">
                Read from the uploaded PI workbook{pi.source_workbook_name ? ` “${pi.source_workbook_name}”` : ''}
                {' · '}sheets “{FABRIC_COST_SHEET_NAME}” and “{FABRIC_FINISH_SHEET_NAME}”
                {' · '}PI saved {formatSavedAt(pi.updated_at)}
              </p>
            </header>
          )}

          {state.kind === 'failed' && (
            <section className="pi-ff-card" aria-label="Not available">
              <p className="pi-ff-empty" role="status">{state.message}</p>
            </section>
          )}
          {state.kind === 'ready' && <FabricFinishView sheets={state.sheets} pi={state.facts} />}
        </div>
      </AmountMaskRegion>
    </OrdersLayout>
  )
}
