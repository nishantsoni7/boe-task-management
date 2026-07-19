'use client'

import { useEffect, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { PROOF_BUCKET } from '@/lib/paymentProof'

// Read-only proof control for a payment request. Renders nothing while loading
// or when the request has no proof, so it can be dropped into any details/
// review modal without extra guards. On click it mints a short-lived signed
// URL (private bucket) and opens it, degrading gracefully if the object is
// missing/expired. Raw storage paths are never shown.

type ProofRow = {
  id: string
  file_name: string
  file_type: string | null
  storage_path: string
}

export function PaymentProofView({
  supabase,
  paymentRequestId,
  renderEmpty = false,
  inline = false,
}: {
  supabase: ReturnType<typeof createClient>
  paymentRequestId: string
  // When true, renders a compact muted empty state instead of nothing once it
  // is known the request has no proof. Default false preserves the original
  // "render nothing when empty" contract used by the admin review modal.
  renderEmpty?: boolean
  // When true, renders without the raised card chrome (no background/border/
  // padding) so it can sit as a plain row inside a host container. Default
  // false preserves the standalone card used by the admin review modal.
  inline?: boolean
}) {
  const [proof,   setProof]   = useState<ProofRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data } = await supabase
        .from('payment_proof_attachments')
        .select('id, file_name, file_type, storage_path')
        .eq('payment_request_id', paymentRequestId)
        .order('created_at', { ascending: false })
        .limit(1)
      if (!active) return
      setProof((data?.[0] as ProofRow) ?? null)
      setLoading(false)
    })()
    return () => { active = false }
  }, [supabase, paymentRequestId])

  const openProof = async () => {
    if (!proof || opening) return
    setOpening(true)
    setError(null)
    const { data, error: e } = await supabase.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(proof.storage_path, 60)
    setOpening(false)
    if (e || !data?.signedUrl) {
      setError('This proof could not be opened. It may have been moved or removed.')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  // While loading, render nothing regardless of renderEmpty (avoids a flash of
  // the empty state before the query resolves).
  if (loading) return null

  if (!proof) {
    if (!renderEmpty) return null
    return <div style={{ fontSize: '13px', color: colors.muted }}>{inline ? 'Not attached' : 'No proof attached'}</div>
  }

  return (
    <div style={inline
      ? { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
      : {
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          padding: '10px 12px', borderRadius: '8px',
          background: colors.raised, border: `1px solid ${colors.border}`,
        }
    }>
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
      <span style={{ fontSize: '13px', color: colors.secondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {proof.file_name}
      </span>
      <button
        onClick={openProof}
        disabled={opening}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '4px 12px', fontSize: '11px', fontWeight: 600, color: colors.blue, flexShrink: 0 }}
      >
        {opening ? 'Opening…' : 'View'}
      </button>
      {error && <span style={{ fontSize: '11px', color: colors.red, width: '100%' }}>{error}</span>}
    </div>
  )
}
