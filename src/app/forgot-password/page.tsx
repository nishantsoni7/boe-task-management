'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { AlertBanner } from '@/components/ui/atoms'
import { AuthShell, authButtonStyle, authLinkStyle } from '@/components/auth/AuthShell'

// Signed-out self-service: someone who has forgotten their password asks for a
// reset link by email, instead of waiting for an admin to set one for them.
//
// The confirmation is deliberately the same whether or not the address belongs
// to a BOE account, so this page cannot be used to find out who works here.
export default function ForgotPasswordPage() {
  const [email,   setEmail]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [sent,    setSent]    = useState(false)

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    const address = email.trim()
    if (!address) return

    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(address, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setLoading(false)

    if (error) {
      setError(
        error.status === 429
          ? 'Too many reset requests. Please wait a few minutes and try again.'
          : error.message || 'Could not send the reset email. Please try again.',
      )
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <AlertBanner variant="green">
          <p style={{ color: colors.green, fontSize: '13px', lineHeight: 1.5 }}>
            If <strong>{email.trim()}</strong> belongs to a BOE One account, a password reset
            link is on its way. Open it on this device and choose a new password.
          </p>
        </AlertBanner>
        <p style={{ color: colors.tertiary, fontSize: '12.5px', lineHeight: 1.5, marginTop: '14px' }}>
          Nothing arrived after a few minutes? Check your spam folder, or send the link again.
        </p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="boe-btn boe-btn-ghost"
          style={{ ...authButtonStyle, marginTop: '16px' }}
        >
          Send again
        </button>
        <Link href="/login" style={authLinkStyle}>Back to sign in</Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Reset your password">
      <form onSubmit={handleSend} noValidate>
        <p style={{ color: colors.tertiary, fontSize: '12.5px', lineHeight: 1.5, marginBottom: '16px' }}>
          Enter the email you sign in with. We&apos;ll send you a link to choose a new password.
        </p>

        <div style={{ marginBottom: '20px' }}>
          <label htmlFor="forgot-email" className="boe-input-label">Email</label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@bestofexports.com"
            className="boe-input"
          />
        </div>

        {error && (
          <div role="alert" style={{ marginBottom: '16px' }}>
            <AlertBanner variant="red">
              <p style={{ color: colors.red, fontSize: '13px' }}>{error}</p>
            </AlertBanner>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !email.trim()}
          aria-busy={loading}
          className="boe-btn boe-btn-primary"
          style={authButtonStyle}
        >
          {loading ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <Link href="/login" style={authLinkStyle}>Back to sign in</Link>
    </AuthShell>
  )
}
