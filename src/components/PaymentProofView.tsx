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
}: {
  supabase: ReturnType<typeof createClient>
  paymentRequestId: string
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

  if (loading || !proof) return null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '8px 12px', borderRadius: '8px',
      background: colors.raised, border: `1px solid ${colors.border}`,
    }}>
      <span style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Payment Proof
      </span>
      <span style={{ fontSize: '12px', color: colors.secondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
