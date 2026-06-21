'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, InquiryStatus } from '@/lib/types'
import { LoadingScreen, AlertBanner } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { ArrowLeft, Trash2, Search, Plus, FileDown } from 'lucide-react'

// ── Local types ───────────────────────────────────────────────────────────────

type InquiryItem = {
  id: string
  quantity: number
  mrp_at_time: number
  showroom_products: {
    id: string
    product_code: string
    name: string
    category: string
    mrp: number
    is_active: boolean
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
  created_at: string
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
  const [token,     setToken]     = useState('')

  // Editable fields
  const [status,          setStatus]          = useState<InquiryStatus>('new')
  const [discountPercent, setDiscountPercent] = useState('0')
  const [notes,           setNotes]           = useState('')

  // Item editing state: itemId → pending qty string
  const [pendingQty,   setPendingQty]   = useState<Record<string, string>>({})
  const [removingId,   setRemovingId]   = useState<string | null>(null)

  // Product search
  const [search,      setSearch]      = useState('')
  const [addingId,    setAddingId]    = useState<string | null>(null)
  const [searchOpen,  setSearchOpen]  = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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

      const [inqRes, prodRes] = await Promise.all([
        fetch(`/api/showroom/inquiry/${inquiryId}`, {
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
    const res = await fetch(`/api/showroom/inquiry/${inquiryId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (res.ok) {
      const data = await res.json()
      setInquiry(data.inquiry)
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
    const res = await fetch(`/api/showroom/quotation/${inquiryId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
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

  // ── Derived totals ────────────────────────────────────────────────────────────

  const items = inquiry?.showroom_inquiry_items ?? []
  const mrpTotal       = items.reduce((s, i) => s + i.mrp_at_time * i.quantity, 0)
  const discPct        = parseFloat(discountPercent) || 0
  const discountAmount = mrpTotal * discPct / 100
  const finalTotal     = mrpTotal - discountAmount

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
                const lineTotal = item.mrp_at_time * item.quantity
                const isRemoving = removingId === item.id
                return (
                  <div key={item.id} style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    background: colors.raised,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '9px', padding: '10px 14px',
                    opacity: isRemoving ? 0.4 : 1,
                  }}>
                    {/* Code + name */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{
                        fontFamily: font.mono, fontSize: '10px', fontWeight: 600,
                        color: '#1A2035', background: 'rgba(26,32,53,0.07)',
                        borderRadius: '3px', padding: '1px 5px',
                      }}>
                        {prod?.product_code ?? '—'}
                      </span>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: colors.primary, marginTop: '2px' }}>
                        {prod?.name ?? 'Unknown product'}
                      </div>
                      <div style={{ fontSize: '11px', color: colors.muted, fontFamily: font.mono }}>
                        ₹{Number(item.mrp_at_time).toLocaleString('en-IN')} each
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
                      ₹{lineTotal.toLocaleString('en-IN')}
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
                )
              })}
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
              <TotalRow label="MRP Total"       value={`₹${mrpTotal.toLocaleString('en-IN')}`} />
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
