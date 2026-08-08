'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, InquiryStatus, QuotationStatus } from '@/lib/types'
import { LoadingScreen, AlertBanner } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { ArrowLeft, Trash2, Search, Plus, FileDown, Link2, Check, Package, Box, User, Phone, CalendarDays, Save } from 'lucide-react'
import { useViewAs } from '@/hooks/useViewAs'
import { resolveModuleAccess } from '@/lib/moduleAccess'

const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

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
  shared_at: string | null
  converted_at: string | null
  lost_at: string | null
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function initItemEdits(
  items: Array<{ id: string; mrp_at_time: number; rate_override: number | null; customization_note: string | null }>,
  existing: Record<string, { rate: string; note: string }>
): Record<string, { rate: string; note: string }> {
  const next: Record<string, { rate: string; note: string }> = {}
  for (const item of items) {
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
  const [pdfError,  setPdfError]    = useState('')
  const [pdfLoading, setPdfLoading] = useState(false)
  const [copied,          setCopied]          = useState(false)
  const [token,           setToken]           = useState('')
  const [salespersonName, setSalespersonName] = useState('')

  const [status,          setStatus]          = useState<InquiryStatus>('new')
  const [discountPercent, setDiscountPercent] = useState('0')
  const [notes,           setNotes]           = useState('')

  const [pendingQty,   setPendingQty]   = useState<Record<string, string>>({})
  const [removingId,   setRemovingId]   = useState<string | null>(null)

  const [itemEdits,    setItemEdits]    = useState<Record<string, { rate: string; note: string }>>({})
  const [saveEditsOk,  setSaveEditsOk]  = useState(false)
  const [saveEditsErr, setSaveEditsErr] = useState('')

  const [savingQuotation, setSavingQuotation] = useState(false)

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

      const [{ data: p }, { data: mod }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'showroom_qr')
          .single(),
      ])
      if (!p) { router.push('/login'); return }
      const profile = p as UserProfile
      const hasAccess = profile.role === 'admin' ||
        resolveModuleAccess('showroom_qr', mod, profile, teamFallback(profile.team))
      if (!hasAccess) { router.replace('/modules'); return }

      setProfile(profile)
      setToken(session.access_token)

      const inqUrl = new URL(`/api/showroom/inquiry/${inquiryId}`, window.location.origin)
      if (profile.role === 'admin' && viewAsUserId) {
        inqUrl.searchParams.set('viewAs', viewAsUserId)
      }

      // Salesperson name only depends on inquiry.salesperson_id, which we don't have
      // yet — but non-admin callers are always looking at their own inquiry, so we
      // can resolve it from the session profile without waiting on the inquiry fetch.
      const salespersonPromise = profile.role === 'admin'
        ? null
        : supabase.from('users').select('full_name').eq('id', session.user.id).single()

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

      if (salespersonPromise) {
        // Non-admin: already resolved above in parallel with the inquiry fetch.
        const sp = (await salespersonPromise).data as { full_name: string } | null
        setSalespersonName(sp?.full_name ?? '—')
      } else {
        // Admin viewing someone else's inquiry — salesperson_id only known now.
        const { data: sp } = await supabase
          .from('users')
          .select('full_name')
          .eq('id', inq.salesperson_id)
          .single()
        setSalespersonName((sp as { full_name: string } | null)?.full_name ?? '—')
      }

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
      setItemEdits(prev => initItemEdits(data.inquiry.showroom_inquiry_items, prev))
    }
  }

  // ── Save status / discount / notes ────────────────────────────────────────────

  const handleSave = async () => {
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
  }

  // ── Save per-item quotation edits ─────────────────────────────────────────────

  const handleSaveItemEdits = async (): Promise<boolean> => {
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
    await reloadInquiry()
    setStatus(s => s === 'new' || s === 'in_discussion' ? 'quotation_sent' : s)
  }

  // ── Combined Save Quotation ───────────────────────────────────────────────────

  const handleSaveQuotation = async () => {
    setSavingQuotation(true)
    await handleSaveItemEdits()
    await handleSave()
    setSavingQuotation(false)
  }

  // ── WhatsApp share ────────────────────────────────────────────────────────────

  const handleWhatsAppShare = async () => {
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
    const digits = (inquiry.customer_mobile ?? '').replace(/\D/g, '')
    let phone = ''
    if (digits.length === 10) {
      phone = '91' + digits
    } else if (digits.length === 12 && digits.startsWith('91')) {
      phone = digits
    } else if (digits.length > 0) {
      phone = digits
    }

    const url = phone
      ? `https://wa.me/${phone}?text=${encoded}`
      : `https://wa.me/?text=${encoded}`

    window.open(url, '_blank', 'noopener,noreferrer')

    // Record first share timestamp — do not overwrite if already set.
    if (!inquiry.shared_at) {
      await fetch(`/api/showroom/inquiry/${inquiryId}`, {
        method: 'PATCH',
        headers: authHeader,
        body: JSON.stringify({ shared_at: new Date().toISOString() }),
      })
      await reloadInquiry()
    }
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
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          fontSize: '13px', color: '#6B7384',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '0 0 22px', fontFamily: font.body, fontWeight: 500,
        }}
      >
        <ArrowLeft size={14} strokeWidth={2} /> Back to Inquiries
      </button>

      {/* Two-column layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 340px',
        gap: '24px',
        alignItems: 'flex-start',
      }}>

        {/* ── LEFT ──────────────────────────────────────────────────────── */}
        <div>
          {/* Products container */}
          <div style={{
            background: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: '16px',
            padding: '16px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          }}>
            {/* Header */}
            <div style={{
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: '#8C94A6',
              marginBottom: '16px',
            }}>
              Products · {items.length}
            </div>

            {/* Product cards */}
            {items.length === 0 ? (
              <div style={{ fontSize: '13px', color: colors.muted, padding: '8px 0 16px' }}>
                No products yet. Search below to add.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px' }}>
                {items.map((item, idx) => {
                  const prod = item.showroom_products
                  const rateVal = parseFloat(itemEdits[item.id]?.rate ?? '')
                  const effectiveRate = (isNaN(rateVal) || rateVal <= 0) ? item.mrp_at_time : rateVal
                  const lineTotal = effectiveRate * item.quantity
                  const isRemoving = removingId === item.id
                  const primaryImg = prod?.images?.[0] ?? prod?.image_url ?? null
                  const hasCustomNote = (itemEdits[item.id]?.note ?? '').trim().length > 0

                  const dimParts: string[] = []
                  if (prod?.dimensions) {
                    const d = prod.dimensions
                    const u = d.unit === 'inches' ? '"' : ` ${d.unit ?? 'in'}`
                    if (d.width  != null) dimParts.push(`W ${d.width}${u}`)
                    if (d.depth  != null) dimParts.push(`D ${d.depth}${u}`)
                    if (d.height != null) dimParts.push(`H ${d.height}${u}`)
                  }
                  const dimStr = dimParts.length > 0 ? dimParts.join(' × ') : null

                  return (
                    <div
                      key={item.id}
                      style={{
                        position: 'relative',
                        background: '#ffffff',
                        border: '1px solid #e5e7eb',
                        borderRadius: '14px',
                        padding: '12px 16px 12px 52px',
                        overflow: 'hidden',
                        opacity: isRemoving ? 0.4 : 1,
                        transition: 'opacity 0.2s',
                        boxSizing: 'border-box',
                      }}
                    >
                      {/* # badge — absolute top-left */}
                      <div style={{
                        position: 'absolute', top: '16px', left: '11px',
                        width: '30px', height: '30px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: '#F3F4F6', borderRadius: '7px',
                        fontSize: '10px', fontWeight: 700, color: '#6B7384',
                        fontFamily: font.body, flexShrink: 0,
                      }}>
                        #{idx + 1}
                      </div>

                      {/* Code + delete — absolute top-right */}
                      <div style={{
                        position: 'absolute', top: '20px', right: '14px',
                        display: 'flex', alignItems: 'center', gap: '7px',
                      }}>
                        <span style={{
                          fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          fontFeatureSettings: '"tnum" 1',
                          fontSize: '10px', fontWeight: 700,
                          color: '#4A5568', background: '#ECEEF2',
                          borderRadius: '6px', padding: '2px 8px',
                          letterSpacing: '0.05em',
                        }}>
                          {prod?.product_code ?? '—'}
                        </span>
                        <button
                          onClick={() => handleRemove(item.id)}
                          disabled={isRemoving}
                          title="Remove item"
                          style={{
                            background: 'none', border: 'none',
                            color: '#C8D0DC', cursor: isRemoving ? 'default' : 'pointer',
                            display: 'flex', alignItems: 'center', padding: '2px',
                            borderRadius: '4px',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#EF4444' }}
                          onMouseLeave={e => { e.currentTarget.style.color = '#C8D0DC' }}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </div>

                      {/* Body: image | right content */}
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: '170px minmax(0, 1fr)',
                        gap: '16px',
                        alignItems: 'flex-start',
                        height: '100%',
                      }}>
                        {/* Image */}
                        <div style={{
                          width: 160, height: 160,
                          borderRadius: '12px',
                          overflow: 'hidden',
                          background: '#F4F5F7',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                          alignSelf: 'flex-start',
                          marginTop: '2px',
                        }}>
                          {primaryImg ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={primaryImg}
                              alt={prod?.name ?? ''}
                              loading="lazy"
                              decoding="async"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            <Package size={32} color="#C0C8D8" strokeWidth={1.2} />
                          )}
                        </div>

                        {/* Right: grid rows, compact */}
                        <div style={{
                          minWidth: 0, width: '100%', overflow: 'hidden',
                          display: 'grid',
                          gridTemplateRows: 'auto auto auto',
                          rowGap: '8px',
                          alignContent: 'flex-start',
                          paddingTop: '2px',
                        }}>
                          {/* Title block */}
                          <div>
                            <div style={{
                              fontSize: '19px', fontWeight: 700,
                              color: '#0F1117', lineHeight: 1.2,
                              fontFamily: 'var(--font-inter, Inter, sans-serif)',
                              letterSpacing: '-0.02em',
                              paddingRight: '150px',
                            }}>
                              {prod?.name ?? 'Unknown product'}
                            </div>
                            <div style={{
                              fontSize: '14px', color: '#6B7384', fontWeight: 400,
                              marginTop: '3px',
                            }}>
                              {prod?.category}
                            </div>
                          </div>

                          {/* Info row: all 4 in one line */}
                          <div style={{
                            display: 'grid',
                            gridTemplateColumns: '190px 1px 1fr 1px 1fr 1px 1fr',
                            alignItems: 'center',
                          }}>
                            {/* Dimensions — fixed width so MRP always aligns */}
                            <div style={{ width: 190, flexShrink: 0 }}>
                              {dimStr ? (
                                <div style={{
                                  display: 'flex', alignItems: 'flex-start', gap: '6px',
                                  background: '#F8F9FB',
                                  border: '1px solid #E8EAED',
                                  borderRadius: '7px', padding: '6px 9px',
                                }}>
                                  <Box size={10} color="#94A3B8" strokeWidth={1.8} style={{ flexShrink: 0, marginTop: '2px' }} />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{
                                      fontSize: '8px', fontWeight: 700, color: '#94A3B8',
                                      textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '2px',
                                    }}>
                                      Dimensions
                                    </div>
                                    <div style={{
                                      fontSize: '11px', fontWeight: 600, color: '#475569',
                                      fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                      fontFeatureSettings: '"tnum" 1',
                                      whiteSpace: 'nowrap',
                                    }}>
                                      {dimStr}
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div style={{ padding: '6px 0' }}>
                                  <div style={{
                                    fontSize: '8px', fontWeight: 700, color: '#94A3B8',
                                    textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '2px',
                                  }}>
                                    Dimensions
                                  </div>
                                  <div style={{
                                    fontSize: '11px', fontWeight: 400, color: '#C0C8D8',
                                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                  }}>
                                    Not added
                                  </div>
                                </div>
                              )}
                            </div>

                            <div style={{ width: '1px', height: '40px', alignSelf: 'center', background: '#E8EAED', flexShrink: 0 }} />

                            {/* MRP / PC */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', paddingLeft: '12px' }}>
                              <div style={{
                                fontSize: '9px', fontWeight: 700, color: '#9AA3B2',
                                textTransform: 'uppercase', letterSpacing: '0.1em',
                              }}>
                                MRP / PC
                              </div>
                              <div style={{
                                fontSize: '17px', fontWeight: 700, color: '#1A2035',
                                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                fontFeatureSettings: '"tnum" 1', letterSpacing: '-0.01em',
                              }}>
                                ₹{Number(item.mrp_at_time).toLocaleString('en-IN')}
                              </div>
                            </div>

                            <div style={{ width: '1px', height: '40px', alignSelf: 'center', background: '#E8EAED', flexShrink: 0 }} />

                            {/* QTY */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', paddingLeft: '12px' }}>
                              <div style={{
                                fontSize: '9px', fontWeight: 700, color: '#9AA3B2',
                                textTransform: 'uppercase', letterSpacing: '0.1em',
                              }}>
                                QTY
                              </div>
                              <input
                                type="number"
                                min={1}
                                value={pendingQty[item.id] ?? item.quantity}
                                onChange={e => setPendingQty(p => ({ ...p, [item.id]: e.target.value }))}
                                onBlur={() => handleQtyBlur(item)}
                                style={{
                                  width: '76px', height: '36px',
                                  padding: '0 6px',
                                  fontSize: '15px', fontWeight: 700, textAlign: 'center',
                                  border: '1.5px solid #E8EAED', borderRadius: '7px',
                                  background: '#fff', color: '#0F1117',
                                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                  fontFeatureSettings: '"tnum" 1',
                                  outline: 'none', boxSizing: 'border-box',
                                }}
                              />
                            </div>

                            <div style={{ width: '1px', height: '40px', alignSelf: 'center', background: '#E8EAED', flexShrink: 0 }} />

                            {/* Line Total */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', paddingLeft: '12px' }}>
                              <div style={{
                                fontSize: '9px', fontWeight: 700, color: '#9AA3B2',
                                textTransform: 'uppercase', letterSpacing: '0.1em',
                              }}>
                                Line Total
                              </div>
                              <div style={{
                                fontSize: '18px', fontWeight: 800, color: '#0F1117',
                                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                letterSpacing: '-0.03em', fontFeatureSettings: '"tnum" 1',
                                lineHeight: 1,
                              }}>
                                ₹{Math.round(lineTotal).toLocaleString('en-IN')}
                              </div>
                            </div>
                          </div>

                          {/* Customization note */}
                          <div style={{
                            borderRadius: '7px',
                            border: `1px solid ${hasCustomNote ? '#facc15' : '#e5e7eb'}`,
                            background: hasCustomNote ? '#fffbeb' : '#F9FAFB',
                            padding: '8px 12px',
                            width: '100%',
                            maxWidth: '600px',
                            boxSizing: 'border-box',
                            minHeight: '58px', maxHeight: '64px',
                          }}>
                            <div style={{
                              fontSize: '9px', fontWeight: 700, color: '#9AA3B2',
                              textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px',
                            }}>
                              Customization Note
                            </div>
                            <input
                              type="text"
                              value={itemEdits[item.id]?.note ?? ''}
                              onChange={e => setItemEdits(prev => ({
                                ...prev,
                                [item.id]: { ...(prev[item.id] ?? { rate: '', note: '' }), note: e.target.value },
                              }))}
                              placeholder="e.g. custom fabric, color change…"
                              style={{
                                width: '100%', padding: '0',
                                fontSize: '14px', fontFamily: font.body,
                                border: 'none', background: 'transparent',
                                color: '#0F1117', outline: 'none', boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Search + Add Product row */}
            <div style={{
              borderTop: items.length > 0 ? '1px solid #f0f1f3' : 'none',
              paddingTop: '14px',
              position: 'relative',
              display: 'flex', gap: '12px', alignItems: 'center',
            }}>
              <div style={{
                flex: 1,
                display: 'flex', alignItems: 'center', gap: '10px',
                border: `1px solid ${searchOpen ? '#1A2035' : '#E8EAED'}`,
                borderRadius: '10px', padding: '0 14px', background: '#fff',
                height: '44px',
                transition: 'border-color 0.14s',
              }}>
                <Search size={14} color="#8C94A6" strokeWidth={1.8} />
                <input
                  value={search}
                  onChange={e => { setSearch(e.target.value); setSearchOpen(true) }}
                  onFocus={() => setSearchOpen(true)}
                  placeholder="Search product by name or code to add…"
                  style={{
                    flex: 1, border: 'none', outline: 'none',
                    fontSize: '13px', color: '#0F1117', background: 'transparent',
                    fontFamily: font.body,
                  }}
                />
              </div>

              <button
                onClick={() => setSearchOpen(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  height: '44px', padding: '0 18px',
                  background: '#fff', color: '#1A2035',
                  border: '1.5px solid #E8EAED', borderRadius: '10px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  fontFamily: font.body, flexShrink: 0,
                }}
              >
                <Plus size={14} strokeWidth={2.5} />
                Add Product
              </button>

              {searchOpen && searchResults.length > 0 && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 160,
                  background: '#fff',
                  border: '1px solid #E8EAED',
                  borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                  zIndex: 10, overflow: 'hidden',
                }}>
                  {searchResults.map(prod => (
                    <button
                      key={prod.id}
                      onClick={() => handleAddProduct(prod)}
                      disabled={addingId === prod.id}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        width: '100%', padding: '10px 16px',
                        background: 'none', border: 'none',
                        borderBottom: '1px solid #F3F4F6',
                        cursor: addingId === prod.id ? 'default' : 'pointer',
                        fontFamily: font.body, textAlign: 'left',
                        opacity: addingId === prod.id ? 0.5 : 1,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#F8F9FB' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                    >
                      <div>
                        <span style={{
                          fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          fontFeatureSettings: '"tnum" 1',
                          fontSize: '10px', fontWeight: 700,
                          color: '#4A5261', background: 'rgba(0,0,0,0.06)',
                          borderRadius: '4px', padding: '1px 6px', marginRight: '8px',
                        }}>
                          {prod.product_code}
                        </span>
                        <span style={{ fontSize: '13px', color: '#0F1117', fontWeight: 500 }}>{prod.name}</span>
                        <span style={{ fontSize: '11px', color: '#8C94A6', marginLeft: '6px' }}>{prod.category}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        <span style={{
                          fontSize: '12.5px', fontWeight: 700, color: '#0F1117',
                          fontFamily: 'var(--font-inter, Inter, sans-serif)', fontFeatureSettings: '"tnum" 1',
                        }}>
                          ₹{Number(prod.mrp).toLocaleString('en-IN')}
                        </span>
                        <Plus size={13} color="#1A2035" strokeWidth={2.2} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── Quotation Summary ─────────────────────────────────────── */}
            {items.length > 0 && (
              <div style={{
                borderTop: '1px solid #E5E7EB',
                marginTop: '14px',
                paddingTop: '24px',
              }}>
                {/* Section label */}
                <div style={{
                  fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: '#8C94A6',
                  marginBottom: '20px',
                }}>
                  Quotation Summary
                </div>

                {/* Rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

                  {/* Subtotal */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500, color: '#6B7384', fontFamily: font.body }}>Subtotal</span>
                    <span style={{
                      fontSize: '15px', fontWeight: 600, color: '#1A2035',
                      fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      fontFeatureSettings: '"tnum" 1',
                    }}>₹{Math.round(subtotal).toLocaleString('en-IN')}</span>
                  </div>

                  {/* Discount % */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500, color: '#6B7384', fontFamily: font.body }}>Discount</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        type="number" min={0} max={100} step={0.5}
                        value={discountPercent}
                        onChange={e => setDiscountPercent(e.target.value)}
                        placeholder="0"
                        style={{
                          width: '64px', height: '32px', padding: '0 8px',
                          fontSize: '15px', fontWeight: 600, textAlign: 'right',
                          border: '1.5px solid #E8EAED', borderRadius: '7px',
                          background: '#fff', color: '#1A2035',
                          fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          fontFeatureSettings: '"tnum" 1',
                          outline: 'none', boxSizing: 'border-box',
                        }}
                      />
                      <span style={{
                        fontSize: '15px', fontWeight: 600, color: '#1A2035',
                        fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      }}>%</span>
                    </div>
                  </div>

                  {/* Discount Amount */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500, color: '#6B7384', fontFamily: font.body }}>Discount Amount</span>
                    <span style={{
                      fontSize: '15px', fontWeight: 600, color: '#DC2626',
                      fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      fontFeatureSettings: '"tnum" 1',
                    }}>−₹{Math.round(discountAmount).toLocaleString('en-IN')}</span>
                  </div>
                </div>

                {/* Divider before final value */}
                <div style={{ height: '1px', background: '#E5E7EB', margin: '20px 0 28px' }} />

                {/* Final Quotation Value */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#6B7384', fontFamily: font.body }}>Final Quotation Value</span>
                  <span style={{
                    fontSize: '32px', fontWeight: 800, color: '#0F1117',
                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    letterSpacing: '-0.03em', fontFeatureSettings: '"tnum" 1',
                    lineHeight: 1,
                  }}>₹{Math.round(finalTotal).toLocaleString('en-IN')}</span>
                </div>

                {/* Alerts */}
                {(saveError || saveEditsErr) && (
                  <div style={{ marginTop: '16px' }}>
                    <AlertBanner variant="red">{saveError || saveEditsErr}</AlertBanner>
                  </div>
                )}
                {(saveOk && saveEditsOk) && (
                  <div style={{ marginTop: '16px' }}>
                    <AlertBanner variant="green">Quotation saved</AlertBanner>
                  </div>
                )}

                {/* Save Quotation button */}
                <button
                  onClick={handleSaveQuotation}
                  disabled={savingQuotation}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                    padding: '12px 18px',
                    background: savingQuotation ? '#3D4760' : '#1A2035', color: '#ffffff',
                    border: 'none', borderRadius: '10px',
                    fontSize: '13.5px', fontWeight: 600,
                    cursor: savingQuotation ? 'default' : 'pointer',
                    opacity: savingQuotation ? 0.7 : 1,
                    fontFamily: font.body, width: '100%', minHeight: '44px',
                    marginTop: '20px',
                  }}
                >
                  <Save size={15} strokeWidth={1.8} />
                  {savingQuotation ? 'Saving…' : 'Save Quotation'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: sticky sidebar ─────────────────────────────────────── */}
        <div style={{ position: 'sticky', top: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

          {/* 1 · Inquiry Details */}
          <div style={sideCardStyle}>
            <SideLabel>Inquiry Details</SideLabel>

            {/* Quotation number — prominent */}
            <div style={{ marginBottom: '18px' }}>
              <div style={{
                fontSize: '9.5px', fontWeight: 700, color: '#9AA3B2',
                textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '5px',
              }}>
                Quotation No.
              </div>
              <div style={{
                fontSize: '22px', fontWeight: 800, color: '#1A2035',
                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '-0.02em', fontFeatureSettings: '"tnum" 1', lineHeight: 1.1,
              }}>
                {inquiry.quotation_no || 'Not generated yet'}
              </div>
            </div>

            <div style={{ height: '1px', background: '#F0F1F3', marginBottom: '18px' }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <IconDetailRow
                icon={<User size={13} color="#94A3B8" strokeWidth={1.8} />}
                label="Customer"
                value={inquiry.customer_name}
              />
              <IconDetailRow
                icon={<Phone size={13} color="#94A3B8" strokeWidth={1.8} />}
                label="Mobile"
                value={inquiry.customer_mobile}
              />
              <IconDetailRow
                icon={<CalendarDays size={13} color="#94A3B8" strokeWidth={1.8} />}
                label="Created"
                value={
                  new Date(inquiry.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) +
                  ' · ' +
                  new Date(inquiry.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                }
              />
            </div>
          </div>

          {/* 2 · Share & Export */}
          <div style={sideCardStyle}>
            <SideLabel>Share & Export</SideLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>

              <button
                onClick={handleDownloadQuotation}
                disabled={pdfLoading || items.length === 0}
                title={items.length === 0 ? 'Add products before generating a quotation' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  padding: '11px 16px',
                  background: '#fff',
                  color: (pdfLoading || items.length === 0) ? '#9CA3AF' : '#1A2035',
                  border: `1px solid ${(pdfLoading || items.length === 0) ? '#E8EAED' : '#D1D5DB'}`,
                  borderRadius: '10px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: (pdfLoading || items.length === 0) ? 'default' : 'pointer',
                  fontFamily: font.body, width: '100%', minHeight: '44px',
                }}
              >
                <FileDown size={15} strokeWidth={1.8} />
                {pdfLoading ? 'Generating PDF…' : 'Generate Quotation PDF'}
              </button>

              <button
                onClick={handleWhatsAppShare}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  padding: '11px 16px',
                  background: '#fff', color: '#15803D',
                  border: '1px solid #D1D5DB',
                  borderRadius: '10px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer', fontFamily: font.body,
                  width: '100%', minHeight: '44px',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#15803D" aria-hidden="true">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  <path d="M12 0C5.373 0 0 5.373 0 12c0 2.122.554 4.112 1.523 5.837L.057 23.492a.75.75 0 0 0 .921.921l5.655-1.466A11.945 11.945 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.907 0-3.686-.528-5.207-1.44l-.374-.22-3.877 1.005 1.006-3.877-.22-.374A9.96 9.96 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                </svg>
                WhatsApp Share
              </button>

              <button
                onClick={handleCopyShareLink}
                title="Copy shareable link for customer"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  padding: '11px 16px',
                  background: copied ? '#F0FDF4' : '#fff',
                  color: copied ? '#065F46' : '#4A5261',
                  border: `1px solid ${copied ? '#A7F3D0' : '#D1D5DB'}`,
                  borderRadius: '10px',
                  fontSize: '13px', fontWeight: 600,
                  cursor: 'pointer', fontFamily: font.body,
                  width: '100%', minHeight: '44px',
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                }}
              >
                {copied ? <Check size={14} strokeWidth={2.5} /> : <Link2 size={14} strokeWidth={2} />}
                {copied ? 'Copied!' : 'Copy Share Link'}
              </button>

              {pdfError && <AlertBanner variant="red">{pdfError}</AlertBanner>}
            </div>
          </div>

          {/* 3 · Quotation Timeline */}
          <div style={sideCardStyle}>
            <SideLabel>Quotation Timeline</SideLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              <TimelineRow
                label="Inquiry Created"
                timestamp={inquiry.created_at}
                done
              />
              <TimelineRow
                label="Quotation Generated"
                timestamp={inquiry.quotation_sent_at}
              />
              <TimelineRow
                label="Quotation Shared"
                timestamp={inquiry.shared_at}
              />
              {inquiry.lost_at ? (
                <TimelineRow
                  label="Lost"
                  timestamp={inquiry.lost_at}
                  variant="lost"
                  last
                />
              ) : (
                <TimelineRow
                  label="Converted"
                  timestamp={inquiry.converted_at}
                  variant="converted"
                  last
                />
              )}
            </div>
          </div>

        </div>
      </div>
    </ShowroomAdminLayout>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sideCardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #E8EAED',
  borderRadius: '16px',
  padding: '20px 22px 22px',
  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
}

function SideLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em',
      textTransform: 'uppercase', color: '#8C94A6', marginBottom: '16px',
    }}>
      {children}
    </div>
  )
}

function IconDetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
      <div style={{ marginTop: '1px', flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{
          fontSize: '9.5px', fontWeight: 700, color: '#9AA3B2',
          textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: '2px',
        }}>
          {label}
        </div>
        <div style={{ fontSize: '13px', fontWeight: 500, color: '#0F1117', lineHeight: 1.3 }}>{value}</div>
      </div>
    </div>
  )
}

function fmtTimestamp(ts: string): string {
  const d = new Date(ts)
  return (
    d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  )
}

function TimelineRow({
  label,
  timestamp,
  done = false,
  variant,
  last = false,
}: {
  label: string
  timestamp: string | null
  done?: boolean
  variant?: 'converted' | 'lost'
  last?: boolean
}) {
  const filled = done || !!timestamp
  const dotColor =
    variant === 'converted' ? '#059669' :
    variant === 'lost'      ? '#DC2626' :
    filled                  ? '#1A2035' : '#D1D5DB'

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', paddingBottom: last ? 0 : '14px' }}>
      {/* Dot + line */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: dotColor, marginTop: '3px', flexShrink: 0,
          transition: 'background 0.2s',
        }} />
        {!last && (
          <div style={{ width: '1px', flex: 1, minHeight: '22px', background: '#E8EAED', marginTop: '3px' }} />
        )}
      </div>
      {/* Text */}
      <div style={{ paddingBottom: last ? 0 : '0' }}>
        <div style={{
          fontSize: '12px', fontWeight: 600,
          color: variant === 'converted' ? '#059669' : variant === 'lost' ? '#DC2626' : '#1A2035',
          lineHeight: 1.2,
        }}>
          {label}
        </div>
        <div style={{
          fontSize: '11px', marginTop: '2px',
          color: filled ? '#6B7384' : '#C0C8D8',
          fontFamily: 'var(--font-inter, Inter, sans-serif)',
        }}>
          {timestamp ? fmtTimestamp(timestamp) : 'Not yet'}
        </div>
      </div>
    </div>
  )
}
