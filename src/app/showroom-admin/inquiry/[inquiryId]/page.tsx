'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, InquiryStatus, QuotationStatus } from '@/lib/types'
import { LoadingScreen, AlertBanner } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { ArrowLeft, Trash2, Search, Plus, FileDown, Link2, Check, Package } from 'lucide-react'
import { useViewAs } from '@/hooks/useViewAs'

// ── Local types ───────────────────────────────────────────────────────────────

type InquiryItem = {
  id: string
  quantity: number
  mrp_at_time: number
  rate_override: number | null
  customization_note: string | null
  showroom_products: {
    id: string
    product_code: string
    name: string
    category: string
    mrp: number
    is_active: boolean
    image_url: string | null
    images: string[]
    dimensions: { width?: number | null; depth?: number | null; height?: number | null; unit?: string } | null
  } | null
}

type InquiryDetail = {
  id: string
  salesperson_id: string
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
  lead_source: string
  status: InquiryStatus
  discount_percent: number
  notes: string | null
  quotation_no: string | null
  quotation_status: QuotationStatus
  quotation_sent_at: string | null
  created_at: string
  share_token: string
  showroom_inquiry_items: InquiryItem[]
}

type ProductOption = {
  id: string
  product_code: string
  name: string
  category: string
  mrp: number
}

const STATUSES: { value: InquiryStatus; label: string }[] = [
  { value: 'new',            label: 'New' },
  { value: 'in_discussion',  label: 'In Discussion' },
  { value: 'quotation_sent', label: 'Quotation Sent' },
  { value: 'closed',         label: 'Closed' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function initItemEdits(
  items: Array<{ id: string; mrp_at_time: number; rate_override: number | null; customization_note: string | null }>,
  existing: Record<string, { rate: string; note: string }>
): Record<string, { rate: string; note: string }> {
  const next: Record<string, { rate: string; note: string }> = {}
  for (const item of items) {
    // Preserve in-progress edits; seed fresh entries from saved DB values.
    next[item.id] = existing[item.id] ?? {
      rate: String(item.rate_override ?? item.mrp_at_time),
      note: item.customization_note ?? '',
    }
  }
  return next
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InquiryDetailPage() {
  const params      = useParams()
  const inquiryId   = params.inquiryId as string

  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [inquiry,   setInquiry]   = useState<InquiryDetail | null>(null)
  const [products,  setProducts]  = useState<ProductOption[]>([])
  const [loading,   setLoading]   = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [saveError, setSaveError]   = useState('')
  const [saveOk,    setSaveOk]      = useState(false)
  const [saving,    setSaving]      = useState(false)
  const [pdfError,  setPdfError]    = useState('')
  const [pdfLoading, setPdfLoading] = useState(false)
  const [copied,          setCopied]          = useState(false)
  const [token,           setToken]           = useState('')
  const [salespersonName, setSalespersonName] = useState('')

  // Editable fields
  const [status,          setStatus]          = useState<InquiryStatus>('new')
  const [discountPercent, setDiscountPercent] = useState('0')
  const [notes,           setNotes]           = useState('')

  // Item editing state: itemId → pending qty string
  const [pendingQty,   setPendingQty]   = useState<Record<string, string>>({})
  const [removingId,   setRemovingId]   = useState<string | null>(null)

  // Local editable overrides for rate and customization note (persisted via Save Edits)
  const [itemEdits,    setItemEdits]    = useState<Record<string, { rate: string; note: string }>>({})
  const [savingEdits,  setSavingEdits]  = useState(false)
  const [saveEditsOk,  setSaveEditsOk]  = useState(false)
  const [saveEditsErr, setSaveEditsErr] = useState('')

  // Product search
  const [search,      setSearch]      = useState('')
  const [addingId,    setAddingId]    = useState<string | null>(null)
  const [searchOpen,  setSearchOpen]  = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId } = useViewAs()

  // ── Init ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      if (!p) { router.push('/login'); return }
      const profile = p as UserProfile
      const hasAccess = profile.role === 'admin' ||
        profile.team?.toLowerCase().includes('sales') ||
        profile.team?.toLowerCase().includes('showroom')
      if (!hasAccess) { router.replace('/modules'); return }

      setProfile(profile)
      setToken(session.access_token)

      const inqUrl = new URL(`/api/showroom/inquiry/${inquiryId}`, window.location.origin)
      if (profile.role === 'admin' && viewAsUserId) {
        inqUrl.searchParams.set('viewAs', viewAsUserId)
      }

      const [inqRes, prodRes] = await Promise.all([
        fetch(inqUrl.toString(), {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }),
        fetch('/api/showroom/products', {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }),
      ])

      if (inqRes.status === 403) { setForbidden(true); setLoading(false); return }
      if (!inqRes.ok) { setLoading(false); return }

      const inqData = await inqRes.json()
      const inq: InquiryDetail = inqData.inquiry
      setInquiry(inq)
      setStatus(inq.status)
      setDiscountPercent(String(inq.discount_percent))
      setNotes(inq.notes ?? '')
      setItemEdits(initItemEdits(inq.showroom_inquiry_items, {}))

      // Fetch salesperson name (may differ from caller when admin views another user's inquiry)
      const { data: sp } = await supabase
        .from('users')
        .select('full_name')
        .eq('id', inq.salesperson_id)
        .single()
      setSalespersonName((sp as { full_name: string } | null)?.full_name ?? '—')

      if (prodRes.ok) {
        const prodData = await prodRes.json()
        setProducts(prodData.products ?? [])
      }

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inquiryId])

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const authHeader = useMemo(() => ({ 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }), [token])

  const reloadInquiry = async () => {
    const reloadUrl = new URL(`/api/showroom/inquiry/${inquiryId}`, window.location.origin)
    if (viewAsUserId) reloadUrl.searchParams.set('viewAs', viewAsUserId)
    const res = await fetch(reloadUrl.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (res.ok) {
      const data = await res.json()
      setInquiry(data.inquiry)
      // Preserve existing edits; only seed new items that weren't edited before
      setItemEdits(prev => initItemEdits(data.inquiry.showroom_inquiry_items, prev))
    }
  }

  // ── Save status / discount / notes ────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true)
    setSaveError('')
    setSaveOk(false)

    const res = await fetch(`/api/showroom/inquiry/${inquiryId}`, {
      method: 'PATCH',
      headers: authHeader,
      body: JSON.stringify({ status, discount_percent: parseFloat(discountPercent) || 0, notes }),
    })

    if (!res.ok) {
      const d = await res.json()
      setSaveError(d.error ?? 'Failed to save')
    } else {
      setSaveOk(true)
      await reloadInquiry()
      setTimeout(() => setSaveOk(false), 2500)
    }
    setSaving(false)
  }

  // ── Save per-item quotation edits (rate_override + customization_note) ────────

  const handleSaveItemEdits = async (): Promise<boolean> => {
    setSavingEdits(true)
    setSaveEditsErr('')
    setSaveEditsOk(false)
    const currentItems = inquiry?.showroom_inquiry_items ?? []
    const results = await Promise.all(currentItems.map(async item => {
      const edit = itemEdits[item.id]
      if (!edit) return true
      const rateVal      = parseFloat(edit.rate)
      const rate_override     = (!isNaN(rateVal) && rateVal > 0) ? rateVal : null
      const customization_note = edit.note.trim() || null
      const res = await fetch(`/api/showroom/inquiry-items/${item.id}`, {
        method: 'PATCH',
        headers: authHeader,
        body: JSON.stringify({ rate_override, customization_note }),
      })
      return res.ok
    }))
    setSavingEdits(false)
    if (results.every(Boolean)) {
      setSaveEditsOk(true)
      await reloadInquiry()
      setTimeout(() => setSaveEditsOk(false), 2500)
      return true
    } else {
      setSaveEditsErr('Some edits failed to save. Please try again.')
      return false
    }
  }

  // ── Quantity update ───────────────────────────────────────────────────────────

  const handleQtyBlur = async (item: InquiryItem) => {
    const raw = pendingQty[item.id]
    if (raw === undefined) return
    const qty = parseInt(raw, 10)
    if (!qty || qty < 1 || qty === item.quantity) {
      setPendingQty(p => { const n = { ...p }; delete n[item.id]; return n })
      return
    }
    await fetch(`/api/showroom/inquiry-items/${item.id}`, {
      method: 'PATCH', headers: authHeader,
      body: JSON.stringify({ quantity: qty }),
    })
    setPendingQty(p => { const n = { ...p }; delete n[item.id]; return n })
    await reloadInquiry()
  }

  // ── Remove item ───────────────────────────────────────────────────────────────

  const handleRemove = async (itemId: string) => {
    setRemovingId(itemId)
    await fetch(`/api/showroom/inquiry-items/${itemId}`, {
      method: 'DELETE', headers: authHeader,
    })
    setRemovingId(null)
    await reloadInquiry()
  }

  // ── Add product from search ───────────────────────────────────────────────────

  const handleAddProduct = async (product: ProductOption) => {
    setAddingId(product.id)
    await fetch('/api/showroom/inquiry-items', {
      method: 'POST', headers: authHeader,
      body: JSON.stringify({ inquiry_id: inquiryId, product_id: product.id, quantity: 1 }),
    })
    setAddingId(null)
    setSearch('')
    setSearchOpen(false)
    await reloadInquiry()
  }

  // ── Download quotation PDF ───────────────────────────────────────────────────

  const handleDownloadQuotation = async () => {
    setPdfLoading(true)
    setPdfError('')

    // Persist item edits to DB before generating so PDF always reflects saved state
    const saved = await handleSaveItemEdits()
    if (!saved) {
      setPdfLoading(false)
      return
    }

    const payload = {
      discount_percent: parseFloat(discountPercent) || 0,
      items: (inquiry?.showroom_inquiry_items ?? []).map(i => {
        const rate = parseFloat(itemEdits[i.id]?.rate ?? '')
        return {
          id:                 i.id,
          quantity:           i.quantity,
          rate:               (isNaN(rate) || rate <= 0) ? i.mrp_at_time : rate,
          customization_note: itemEdits[i.id]?.note?.trim() || null,
        }
      }),
    }
    const res = await fetch(`/api/showroom/quotation/${inquiryId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setPdfError(d.error ?? 'Failed to generate quotation')
      setPdfLoading(false)
      return
    }
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    const cd   = res.headers.get('Content-Disposition') ?? ''
    const match = cd.match(/filename="([^"]+)"/)
    a.href     = url
    a.download = match ? match[1] : `BOE-Quotation.pdf`
    a.click()
    URL.revokeObjectURL(url)
    setPdfLoading(false)
    // Status may have changed to quotation_sent — reload inquiry to reflect it
    await reloadInquiry()
    setStatus(s => s === 'new' || s === 'in_discussion' ? 'quotation_sent' : s)
  }

  // ── Mark converted / lost ─────────────────────────────────────────────────────

  const [outcomeLoading, setOutcomeLoading] = useState<'converted' | 'lost' | null>(null)
  const [outcomeError,   setOutcomeError]   = useState('')

  const handleMarkOutcome = async (outcome: 'converted' | 'lost') => {
    if (outcome === 'lost') {
      if (!window.confirm('Mark this quotation as lost?')) return
    } else {
      if (!window.confirm('Mark this quotation as converted?')) return
    }

    setOutcomeLoading(outcome)
    setOutcomeError('')

    const body = outcome === 'converted'
      ? { quotation_status: 'converted', converted_at: new Date().toISOString() }
      : { quotation_status: 'lost',      lost_at:      new Date().toISOString() }

    const res = await fetch(`/api/showroom/inquiry/${inquiryId}`, {
      method: 'PATCH',
      headers: authHeader,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setOutcomeError(d.error ?? 'Failed to update. Please try again.')
    } else {
      await reloadInquiry()
    }

    setOutcomeLoading(null)
  }

  // ── WhatsApp share ────────────────────────────────────────────────────────────

  const handleWhatsAppShare = () => {
    if (!inquiry) return

    const message = [
      `Hello ${inquiry.customer_name},`,
      '',
      'Please find your quotation attached.',
      '',
      `Quotation No: ${inquiry.quotation_no ?? 'Pending'}`,
      '',
      'Regards,',
      `${salespersonName || 'Your Salesperson'}`,
      'Best of Exports',
    ].join('\n')

    const encoded = encodeURIComponent(message)

    // Normalise mobile: strip non-digits, add India country code if 10-digit local number
    const digits = (inquiry.customer_mobile ?? '').replace(/\D/g, '')
    let phone = ''
    if (digits.length === 10) {
      phone = '91' + digits
    } else if (digits.length === 12 && digits.startsWith('91')) {
      phone = digits
    } else if (digits.length > 0) {
      phone = digits  // use as-is for other formats
    }

    const url = phone
      ? `https://wa.me/${phone}?text=${encoded}`
      : `https://wa.me/?text=${encoded}`

    window.open(url, '_blank', 'noopener,noreferrer')
  }

  // ── Copy share link ───────────────────────────────────────────────────────────

  const handleCopyShareLink = () => {
    if (!inquiry?.share_token) return
    const url = `${window.location.origin}/showroom/share/${inquiry.share_token}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Derived totals ────────────────────────────────────────────────────────────

  const items = inquiry?.showroom_inquiry_items ?? []
  const subtotal = items.reduce((s, i) => {
    const rate = parseFloat(itemEdits[i.id]?.rate ?? '')
    const effectiveRate = (isNaN(rate) || rate <= 0) ? i.mrp_at_time : rate
    return s + effectiveRate * i.quantity
  }, 0)
  const discPct        = parseFloat(discountPercent) || 0
  const discountAmount = subtotal * discPct / 100
  const finalTotal     = subtotal - discountAmount

  // Product search results
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return products.filter(
      p => p.product_code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    ).slice(0, 8)
  }, [search, products])

  // ── Render ────────────────────────────────────────────────────────────────────

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  if (forbidden || !inquiry) {
    return (
      <ShowroomAdminLayout profile={profile} title="Inquiry" onSignOut={handleSignOut}>
        <div style={{ padding: '48px 0', textAlign: 'center', color: colors.muted, fontSize: '14px' }}>
          {forbidden ? 'You do not have access to this inquiry.' : 'Inquiry not found.'}
        </div>
      </ShowroomAdminLayout>
    )
  }

  return (
    <ShowroomAdminLayout profile={profile} title="Inquiry Detail" onSignOut={handleSignOut}>

      {/* Back */}
      <button
        onClick={() => router.push('/showroom-admin')}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '13px', color: colors.tertiary,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '0 0 20px', fontFamily: font.body,
        }}
      >
        <ArrowLeft size={14} strokeWidth={2} /> Back to Inquiries
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '680px' }}>

        {/* ── Quotation summary ────────────────────────────────────────────── */}
        <Section title="Quotation">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: font.mono, fontSize: '15px', fontWeight: 700, color: '#1A2035',
                letterSpacing: '0.01em',
              }}>
                {inquiry.quotation_no ?? 'Pending assignment'}
              </span>
              <QuotationBadge status={inquiry.quotation_status} />
            </div>
            <Grid>
              <KV label="Created"     value={new Date(inquiry.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} />
              <KV label="Salesperson" value={salespersonName || '—'} />
              <KV label="Customer"    value={inquiry.customer_name} />
              <KV label="Final Value" value={`₹${Math.round(finalTotal).toLocaleString('en-IN')}`} />
            </Grid>

            {/* Outcome actions — hidden once already converted or lost */}
            {inquiry.quotation_status !== 'converted' && inquiry.quotation_status !== 'lost' && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '4px' }}>
                <button
                  onClick={() => handleMarkOutcome('converted')}
                  disabled={outcomeLoading !== null}
                  style={{
                    padding: '7px 16px',
                    background: outcomeLoading === 'converted' ? '#D1FAE5' : '#ECFDF5',
                    color: '#065F46',
                    border: '1.5px solid #A7F3D0',
                    borderRadius: '8px',
                    fontSize: '12px', fontWeight: 600,
                    cursor: outcomeLoading !== null ? 'default' : 'pointer',
                    opacity: outcomeLoading !== null ? 0.6 : 1,
                    fontFamily: font.body,
                  }}
                >
                  {outcomeLoading === 'converted' ? 'Saving…' : 'Mark Converted'}
                </button>
                <button
                  onClick={() => handleMarkOutcome('lost')}
                  disabled={outcomeLoading !== null}
                  style={{
                    padding: '7px 16px',
                    background: outcomeLoading === 'lost' ? '#FEE2E2' : '#FEF2F2',
                    color: '#991B1B',
                    border: '1.5px solid #FECACA',
                    borderRadius: '8px',
                    fontSize: '12px', fontWeight: 600,
                    cursor: outcomeLoading !== null ? 'default' : 'pointer',
                    opacity: outcomeLoading !== null ? 0.6 : 1,
                    fontFamily: font.body,
                  }}
                >
                  {outcomeLoading === 'lost' ? 'Saving…' : 'Mark Lost'}
                </button>
              </div>
            )}
            {outcomeError && (
              <div style={{ fontSize: '12px', color: '#B91C1C', paddingTop: '2px' }}>{outcomeError}</div>
            )}
          </div>
        </Section>

        {/* ── Customer details ─────────────────────────────────────────────── */}
        <Section title="Customer">
          <Grid>
            <KV label="Name"    value={inquiry.customer_name} />
            <KV label="Mobile"  value={inquiry.customer_mobile} />
            {inquiry.company     && <KV label="Company"  value={inquiry.company} />}
            {inquiry.city        && <KV label="City"     value={inquiry.city} />}
            {inquiry.project_name && <KV label="Project" value={inquiry.project_name} />}
            <KV label="Source"  value={inquiry.lead_source} />
            <KV label="Date"    value={new Date(inquiry.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} />
          </Grid>
        </Section>

        {/* ── Items ────────────────────────────────────────────────────────── */}
        <Section title={`Products · ${items.length}`}>

          {items.length === 0 ? (
            <div style={{ fontSize: '13px', color: colors.muted, padding: '12px 0' }}>
              No products. Use the search below to add products.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
              {items.map(item => {
                const prod = item.showroom_products
                const rateVal = parseFloat(itemEdits[item.id]?.rate ?? '')
                const effectiveRate = (isNaN(rateVal) || rateVal <= 0) ? item.mrp_at_time : rateVal
                const lineTotal = effectiveRate * item.quantity
                const isRemoving = removingId === item.id
                return (
                  <div key={item.id} style={{
                    background: colors.raised,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '9px', padding: '10px 14px',
                    opacity: isRemoving ? 0.4 : 1,
                  }}>
                    {/* Main row: thumbnail · info · qty · total · remove */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>

                      {/* Product thumbnail */}
                      {(() => {
                        const primaryImg = prod?.images?.[0] ?? prod?.image_url ?? null
                        return (
                          <div style={{
                            width: 44, height: 44, flexShrink: 0,
                            borderRadius: '7px',
                            background: colors.float,
                            border: `1px solid ${colors.border}`,
                            overflow: 'hidden',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {primaryImg ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={primaryImg} alt={prod?.name ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                              <Package size={16} color={colors.muted} strokeWidth={1.5} />
                            )}
                          </div>
                        )
                      })()}

                      {/* Code + name + dims + MRP */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{
                          fontFamily: font.mono, fontSize: '10px', fontWeight: 600,
                          color: '#1A2035', background: 'rgba(26,32,53,0.07)',
                          borderRadius: '3px', padding: '1px 5px',
                        }}>
                          {prod?.product_code ?? '—'}
                        </span>
                        <div style={{ fontSize: '13px', fontWeight: 500, color: colors.primary, marginTop: '2px', lineHeight: 1.3 }}>
                          {prod?.name ?? 'Unknown product'}
                        </div>
                        {prod?.dimensions && (() => {
                          const d = prod.dimensions
                          const u = d.unit === 'inches' ? '"' : ` ${d.unit ?? 'in'}`
                          const parts: string[] = []
                          if (d.width  != null) parts.push(`W ${d.width}${u}`)
                          if (d.depth  != null) parts.push(`D ${d.depth}${u}`)
                          if (d.height != null) parts.push(`H ${d.height}${u}`)
                          return parts.length > 0 ? (
                            <div style={{ fontSize: '10px', color: colors.muted, fontFamily: font.mono, marginTop: '1px' }}>
                              {parts.join(' × ')}
                            </div>
                          ) : null
                        })()}
                        <div style={{ fontSize: '11px', color: colors.muted, fontFamily: font.mono, marginTop: '1px' }}>
                          Rs.{Number(item.mrp_at_time).toLocaleString('en-IN')} MRP
                        </div>
                      </div>

                      {/* Qty input */}
                      <input
                        type="number"
                        min={1}
                        value={pendingQty[item.id] ?? item.quantity}
                        onChange={e => setPendingQty(p => ({ ...p, [item.id]: e.target.value }))}
                        onBlur={() => handleQtyBlur(item)}
                        style={{
                          width: '56px', padding: '6px 8px',
                          fontSize: '13px', fontWeight: 600, textAlign: 'center',
                          border: `1.5px solid ${colors.border}`, borderRadius: '6px',
                          background: '#fff', color: colors.primary,
                          fontFamily: font.body,
                        }}
                      />

                      {/* Line total */}
                      <div style={{
                        width: '90px', textAlign: 'right', flexShrink: 0,
                        fontSize: '13px', fontWeight: 600, color: colors.primary,
                        fontFamily: font.mono,
                      }}>
                        ₹{Math.round(lineTotal).toLocaleString('en-IN')}
                      </div>

                      {/* Remove */}
                      <button
                        onClick={() => handleRemove(item.id)}
                        disabled={isRemoving}
                        title="Remove"
                        style={{
                          background: 'none', border: 'none',
                          color: colors.muted, cursor: isRemoving ? 'default' : 'pointer',
                          display: 'flex', alignItems: 'center', flexShrink: 0,
                        }}
                      >
                        <Trash2 size={14} strokeWidth={1.8} />
                      </button>
                    </div>

                    {/* Rate override + customization note */}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <label style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          Rate (Rs.)
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={itemEdits[item.id]?.rate ?? ''}
                          onChange={e => setItemEdits(prev => ({
                            ...prev,
                            [item.id]: { ...(prev[item.id] ?? { rate: '', note: '' }), rate: e.target.value },
                          }))}
                          placeholder={String(item.mrp_at_time)}
                          style={{
                            width: '100px', padding: '5px 8px',
                            fontSize: '12px', fontWeight: 600, fontFamily: font.mono,
                            border: `1.5px solid ${colors.border}`, borderRadius: '6px',
                            background: '#fff', color: colors.primary, outline: 'none',
                          }}
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: '160px' }}>
                        <label style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          Customization Note
                        </label>
                        <input
                          type="text"
                          value={itemEdits[item.id]?.note ?? ''}
                          onChange={e => setItemEdits(prev => ({
                            ...prev,
                            [item.id]: { ...(prev[item.id] ?? { rate: '', note: '' }), note: e.target.value },
                          }))}
                          placeholder="e.g. custom fabric, color change…"
                          style={{
                            width: '100%', padding: '5px 8px',
                            fontSize: '12px', fontFamily: font.body,
                            border: `1.5px solid ${colors.border}`, borderRadius: '6px',
                            background: '#fff', color: colors.primary, outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Save quotation edits ─────────────────────────────────────── */}
          {items.length > 0 && (
            <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={handleSaveItemEdits}
                disabled={savingEdits}
                style={{
                  padding: '8px 18px',
                  background: saveEditsOk ? '#ECFDF5' : '#fff',
                  color:      saveEditsOk ? '#065F46' : colors.secondary,
                  border: `1.5px solid ${saveEditsOk ? '#A7F3D0' : colors.border}`,
                  borderRadius: '8px',
                  fontSize: '12px', fontWeight: 600,
                  cursor: savingEdits ? 'default' : 'pointer',
                  opacity: savingEdits ? 0.6 : 1,
                  fontFamily: font.body,
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                }}
              >
                {savingEdits ? 'Saving…' : saveEditsOk ? '✓ Saved' : 'Save quotation changes'}
              </button>
              {saveEditsErr && (
                <span style={{ fontSize: '12px', color: '#B91C1C' }}>{saveEditsErr}</span>
              )}
            </div>
          )}

          {/* ── Product search / add ──────────────────────────────────────── */}
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px',
              border: `1.5px solid ${searchOpen ? '#1A2035' : colors.border}`,
              borderRadius: '8px', padding: '8px 12px', background: '#fff',
            }}>
              <Search size={14} color={colors.muted} strokeWidth={1.8} />
              <input
                value={search}
                onChange={e => { setSearch(e.target.value); setSearchOpen(true) }}
                onFocus={() => setSearchOpen(true)}
                placeholder="Search product by name or code to add…"
                style={{
                  flex: 1, border: 'none', outline: 'none',
                  fontSize: '13px', color: colors.primary, background: 'transparent',
                  fontFamily: font.body,
                }}
              />
            </div>

            {searchOpen && searchResults.length > 0 && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                background: '#fff',
                border: `1.5px solid ${colors.border}`,
                borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
                zIndex: 10, overflow: 'hidden',
              }}>
                {searchResults.map(prod => (
                  <button
                    key={prod.id}
                    onClick={() => handleAddProduct(prod)}
                    disabled={addingId === prod.id}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      width: '100%', padding: '10px 14px',
                      background: 'none', border: 'none',
                      borderBottom: `1px solid ${colors.border}`,
                      cursor: addingId === prod.id ? 'default' : 'pointer',
                      fontFamily: font.body, textAlign: 'left',
                      opacity: addingId === prod.id ? 0.5 : 1,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = colors.raised }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                  >
                    <div>
                      <span style={{
                        fontFamily: font.mono, fontSize: '10px', fontWeight: 600,
                        color: '#1A2035', background: 'rgba(26,32,53,0.07)',
                        borderRadius: '3px', padding: '1px 5px', marginRight: '6px',
                      }}>
                        {prod.product_code}
                      </span>
                      <span style={{ fontSize: '13px', color: colors.primary }}>{prod.name}</span>
                      <span style={{ fontSize: '11px', color: colors.muted, marginLeft: '6px' }}>{prod.category}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, fontFamily: font.mono }}>
                        ₹{Number(prod.mrp).toLocaleString('en-IN')}
                      </span>
                      <Plus size={13} color={colors.muted} strokeWidth={2} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Totals ───────────────────────────────────────────────────── */}
          {items.length > 0 && (
            <div style={{
              marginTop: '16px', borderTop: `1px solid ${colors.border}`,
              paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              <TotalRow label="Subtotal"       value={`₹${subtotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} />
              {discPct > 0 && (
                <TotalRow label={`Discount (${discPct}%)`} value={`−₹${discountAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} muted />
              )}
              <TotalRow label="Final Total" value={`₹${finalTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} bold />
            </div>
          )}
        </Section>

        {/* ── Status / Discount / Notes / Save ──────────────────────────── */}
        <Section title="Manage">

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* Status */}
            <Field label="Status">
              <select
                value={status}
                onChange={e => setStatus(e.target.value as InquiryStatus)}
                style={inputStyle}
              >
                {STATUSES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </Field>

            {/* Discount */}
            <Field label="Discount %">
              <input
                type="number" min={0} max={100} step={0.5}
                value={discountPercent}
                onChange={e => setDiscountPercent(e.target.value)}
                placeholder="0"
                style={{ ...inputStyle, maxWidth: '120px' }}
              />
            </Field>

            {/* Notes */}
            <Field label="Notes">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Internal notes about this inquiry…"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>

            {saveError && <AlertBanner variant="red">{saveError}</AlertBanner>}
            {saveOk    && <AlertBanner variant="green">Saved</AlertBanner>}

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: '10px 22px',
                  background: '#1A2035', color: '#fff',
                  border: 'none', borderRadius: '8px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                  fontFamily: font.body,
                }}
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>

              <button
                onClick={handleDownloadQuotation}
                disabled={pdfLoading || items.length === 0}
                title={items.length === 0 ? 'Add products before generating a quotation' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '10px 18px',
                  background: '#fff', color: '#1A2035',
                  border: '1.5px solid #1A2035', borderRadius: '8px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: (pdfLoading || items.length === 0) ? 'default' : 'pointer',
                  opacity: (pdfLoading || items.length === 0) ? 0.5 : 1,
                  fontFamily: font.body,
                }}
              >
                <FileDown size={14} strokeWidth={2} />
                {pdfLoading ? 'Generating…' : 'Generate Quotation'}
              </button>

              <button
                onClick={handleWhatsAppShare}
                title="Share quotation message via WhatsApp"
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '10px 18px',
                  background: '#fff', color: '#15803D',
                  border: '1.5px solid #86EFAC',
                  borderRadius: '8px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: font.body,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  <path d="M12 0C5.373 0 0 5.373 0 12c0 2.122.554 4.112 1.523 5.837L.057 23.492a.75.75 0 0 0 .921.921l5.655-1.466A11.945 11.945 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.907 0-3.686-.528-5.207-1.44l-.374-.22-3.877 1.005 1.006-3.877-.22-.374A9.96 9.96 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                </svg>
                WhatsApp Share
              </button>

              <button
                onClick={handleCopyShareLink}
                title="Copy shareable link for customer"
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '10px 18px',
                  background: copied ? '#ECFDF5' : '#fff',
                  color: copied ? '#065F46' : colors.secondary,
                  border: `1.5px solid ${copied ? '#A7F3D0' : colors.border}`,
                  borderRadius: '8px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: font.body,
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                }}
              >
                {copied ? <Check size={14} strokeWidth={2.5} /> : <Link2 size={14} strokeWidth={2} />}
                {copied ? 'Copied!' : 'Copy Share Link'}
              </button>
            </div>

            {pdfError && <AlertBanner variant="red">{pdfError}</AlertBanner>}
          </div>
        </Section>

      </div>
    </ShowroomAdminLayout>
  )
}

// ── Small layout helpers ──────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '12px',
      padding: '18px 20px 20px',
    }}>
      <div style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: colors.muted, marginBottom: '14px',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
      {children}
    </div>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: '13px', color: colors.primary }}>{value}</div>
    </div>
  )
}

function TotalRow({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '12px', color: muted ? colors.muted : colors.secondary }}>{label}</span>
      <span style={{
        fontSize: bold ? '15px' : '13px',
        fontWeight: bold ? 700 : 500,
        color: bold ? colors.primary : muted ? colors.muted : colors.secondary,
        fontFamily: font.mono,
      }}>{value}</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <label style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>{label}</label>
      {children}
    </div>
  )
}

const QUOTATION_STATUS_CONFIG: Record<QuotationStatus, { label: string; bg: string; color: string; border: string }> = {
  draft:     { label: 'Draft',     bg: '#F3F4F6', color: '#4B5563', border: '#D1D5DB' },
  sent:      { label: 'Sent',      bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' },
  converted: { label: 'Converted', bg: '#ECFDF5', color: '#065F46', border: '#A7F3D0' },
  lost:      { label: 'Lost',      bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

function QuotationBadge({ status }: { status: QuotationStatus }) {
  const cfg = QUOTATION_STATUS_CONFIG[status] ?? QUOTATION_STATUS_CONFIG.draft
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '3px 10px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 600, letterSpacing: '0.03em',
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
      fontFamily: 'var(--font-body, DM Sans, sans-serif)',
    }}>
      {cfg.label}
    </span>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  fontSize: '13px', color: '#111318',
  background: '#fff',
  border: '1.5px solid rgba(0,0,0,0.13)',
  borderRadius: '7px', outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
}
