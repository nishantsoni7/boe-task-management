'use client'

// ── /handover/[id] ───────────────────────────────────────────────────────────
//
// ONE cash handover, for the two people in it. It lives OUTSIDE /finance on
// purpose: a handover can be made to any active employee, and a recipient who
// does not hold Finance access must still be able to open the link in their
// notification and accept (or dispute) the cash. Nothing here checks a module
// permission; finance_handover_list answers only for a participant (or an
// administrator / finance.view_all holder), and accept / dispute re-check that
// the caller IS the recipient.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { HandoverCard } from '@/components/finance/HandoverCard'
import { useHandover } from '@/hooks/queries/useHandovers'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'

export default function HandoverPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : ''
  const { data: userId, isPending: idPending } = useSignedInUserId()
  const query = useHandover(id)

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px 48px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#303536' }}>Cash handover</h1>
        <Link href="/modules" className="boe-btn boe-btn-secondary" style={{ textDecoration: 'none' }}>Back to BOE One</Link>
      </div>

      {(idPending || query.isPending) && !query.isError && <div style={{ fontSize: 14 }}>Loading…</div>}

      {!idPending && !userId && (
        <div className="boe-handover-error" role="alert">
          Sign in to see this handover. <Link href="/login">Go to sign in</Link>
        </div>
      )}

      {query.isError && (
        <div className="boe-handover-error" role="alert">
          This handover could not be loaded. <button type="button" className="boe-btn boe-btn-secondary" onClick={() => void query.refetch()}>Try again</button>
        </div>
      )}

      {query.data === null && (
        <div style={{ padding: 24, borderRadius: 12, background: '#FFFFFF', border: '1px solid #E4DED7', fontSize: 14, lineHeight: 1.5 }}>
          This handover does not exist, or it is not one you are part of.
        </div>
      )}

      {query.data && (
        <HandoverCard handover={query.data} viewerId={userId ?? null} defaultOpen onChanged={() => void query.refetch()} />
      )}
    </main>
  )
}
