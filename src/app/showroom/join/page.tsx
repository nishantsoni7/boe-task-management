'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { colors, font } from '@/lib/tokens'
import { AlertBanner } from '@/components/ui/atoms'

// ── Inner component reads search params (must be inside Suspense) ─────────────

function JoinForm() {
  const searchParams   = useSearchParams()
  const salespersonId  = searchParams.get('sp') ?? ''

  const [salespersonName, setSalespersonName] = useState<string | null>(null)
  const [validating,      setValidating]      = useState(true)
  const [invalid,         setInvalid]         = useState(false)

  const [customerName,   setCustomerName]   = useState('')
  const [customerMobile, setCustomerMobile] = useState('')
  const [company,        setCompany]        = useState('')
  const [city,           setCity]           = useState('')
  const [projectName,    setProjectName]    = useState('')
  const [formError,      setFormError]      = useState('')
  const [submitting,     setSubmitting]     = useState(false)

  const router = useRouter()

  // Validate the salesperson ID on mount
  useEffect(() => {
    const validateSalesperson = () => {
      if (!salespersonId) { setInvalid(true); setValidating(false); return }

      fetch(`/api/showroom/salesperson/${encodeURIComponent(salespersonId)}`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((data: { full_name: string }) => {
          setSalespersonName(data.full_name)
          setValidating(false)
        })
        .catch(() => {
          setInvalid(true)
          setValidating(false)
        })
    }
    validateSalesperson()
  }, [salespersonId])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!customerName.trim()) { setFormError('Please enter your name'); return }
    if (!customerMobile.trim()) { setFormError('Please enter your mobile number'); return }
    if (!/^[0-9+\s\-]{7,15}$/.test(customerMobile.trim())) {
      setFormError('Please enter a valid mobile number')
      return
    }

    setSubmitting(true)

    // Save to localStorage so session survives new tabs opened by QR camera scanning
    localStorage.setItem('boe_sp', salespersonId)
    localStorage.setItem('boe_customer', JSON.stringify({
      customer_name:   customerName.trim(),
      customer_mobile: customerMobile.trim(),
      company:         company.trim() || null,
      city:            city.trim() || null,
      project_name:    projectName.trim() || null,
    }))

    router.push('/showroom/project-list')
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  if (validating) {
    return (
      <PageShell>
        <div style={{ textAlign: 'center', padding: '48px 0', color: colors.muted, fontSize: '14px' }}>
          Loading…
        </div>
      </PageShell>
    )
  }

  // ── Invalid QR ───────────────────────────────────────────────────────────────
  if (invalid) {
    return (
      <PageShell>
        <div style={{
          textAlign: 'center', padding: '48px 24px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: '12px',
            background: 'rgba(217,79,79,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '22px',
          }}>
            ✕
          </div>
          <div style={{ fontFamily: font.display, fontSize: '18px', fontWeight: 700, color: colors.primary }}>
            Invalid Showroom QR
          </div>
          <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '280px' }}>
            This QR code is not valid or has expired. Please ask your salesperson for a new QR code.
          </div>
        </div>
      </PageShell>
    )
  }

  // ── Join form ─────────────────────────────────────────────────────────────────
  return (
    <PageShell>
      {/* Salesperson context */}
      <div style={{
        background: 'rgba(26,32,53,0.05)',
        border: '1px solid rgba(26,32,53,0.10)',
        borderRadius: '10px',
        padding: '12px 16px',
        marginBottom: '24px',
        display: 'flex', alignItems: 'center', gap: '10px',
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '8px',
          background: '#1A2035',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '12px', fontWeight: 700, color: '#DC1F2E',
          flexShrink: 0,
        }}>
          {salespersonName?.[0]?.toUpperCase() ?? '?'}
        </div>
        <div>
          <div style={{ fontSize: '11px', color: colors.muted, fontWeight: 500 }}>Your showroom guide</div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>{salespersonName}</div>
        </div>
      </div>

      {/* Instruction */}
      <div style={{
        fontSize: '13px', color: colors.secondary, lineHeight: 1.6,
        marginBottom: '24px',
      }}>
        Please enter your details before selecting showroom products.
      </div>

      {formError && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="red">{formError}</AlertBanner>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

        <Field label="Your Name *">
          <input
            type="text"
            value={customerName}
            onChange={e => setCustomerName(e.target.value)}
            placeholder="Full name"
            autoComplete="name"
            inputMode="text"
            style={inputStyle}
          />
        </Field>

        <Field label="Mobile Number *">
          <input
            type="tel"
            value={customerMobile}
            onChange={e => setCustomerMobile(e.target.value)}
            placeholder="e.g. 98765 43210"
            autoComplete="tel"
            inputMode="tel"
            style={inputStyle}
          />
        </Field>

        <Field label="Company">
          <input
            type="text"
            value={company}
            onChange={e => setCompany(e.target.value)}
            placeholder="Company or organisation (optional)"
            autoComplete="organization"
            style={inputStyle}
          />
        </Field>

        <Field label="City">
          <input
            type="text"
            value={city}
            onChange={e => setCity(e.target.value)}
            placeholder="City (optional)"
            autoComplete="address-level2"
            style={inputStyle}
          />
        </Field>

        <Field label="Project Name">
          <input
            type="text"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            placeholder="e.g. Hotel lobby, Office redesign (optional)"
            style={inputStyle}
          />
        </Field>

        <button
          type="submit"
          disabled={submitting}
          style={{
            marginTop: '8px',
            width: '100%', padding: '14px',
            background: '#1A2035', color: '#fff',
            border: 'none', borderRadius: '10px',
            fontSize: '15px', fontWeight: 600,
            cursor: submitting ? 'default' : 'pointer',
            opacity: submitting ? 0.7 : 1,
            fontFamily: font.body,
            letterSpacing: '-0.01em',
          }}
        >
          {submitting ? 'Please wait…' : 'Enter Showroom →'}
        </button>

      </form>
    </PageShell>
  )
}

// ── Page shell — mobile-first card layout ──────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: colors.void,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '32px 16px 48px',
    }}>
      <div style={{ width: '100%', maxWidth: '420px' }}>

        {/* BOE header */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            marginBottom: '8px',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '7px',
              background: '#1A2035',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#DC1F2E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </div>
            <span style={{ fontSize: '13px', fontWeight: 700, color: colors.secondary, letterSpacing: '0.02em' }}>
              BOE Showroom
            </span>
          </div>
          <h1 style={{
            fontFamily: font.display,
            fontSize: '22px', fontWeight: 700,
            color: colors.primary,
            margin: 0, letterSpacing: '-0.02em',
          }}>
            Welcome
          </h1>
        </div>

        {/* Card */}
        <div style={{
          background: colors.base,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '16px',
          padding: '24px 20px 28px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Field wrapper ──────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <label style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Input style ────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 13px',
  fontSize: '15px',
  color: '#111318',
  background: '#fff',
  border: '1.5px solid rgba(0,0,0,0.13)',
  borderRadius: '8px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
  WebkitAppearance: 'none',
}

// ── Export with Suspense boundary (required for useSearchParams) ──────────────

export default function JoinPage() {
  return (
    <Suspense fallback={
      <div style={{
        minHeight: '100vh', background: colors.void,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '14px', color: colors.muted,
      }}>
        Loading…
      </div>
    }>
      <JoinForm />
    </Suspense>
  )
}
