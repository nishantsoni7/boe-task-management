'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { colors, font } from '@/lib/tokens'
import { AlertBanner } from '@/components/ui/atoms'

function LoginForm() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const router = useRouter()
  const searchParams = useSearchParams()

  const handleLogin = async () => {
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    const redirect = searchParams.get('redirect')
    router.push(redirect && redirect.startsWith('/') ? redirect : '/')
  }

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: colors.void,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 16px',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/branding/boe-logo-full.png"
            alt="Best of Exports"
            style={{
              maxWidth: 'min(200px, 56vw)',
              height: 'auto',
              marginBottom: '16px',
              display: 'block',
              margin: '0 auto 16px',
            }}
          />
          <p style={{ color: colors.tertiary, fontSize: '12.5px', lineHeight: 1.5 }}>
            Tasks, follow-ups, accountability, and daily work tracking for the BOE team.
          </p>
        </div>

        {/* Form card */}
        <div className="boe-card" style={{ padding: '24px' }}>
          <h2 style={{
            color: colors.primary,
            fontFamily: font.display,
            fontWeight: 600,
            fontSize: '16px',
            marginBottom: '20px',
          }}>
            Sign in
          </h2>

          <div style={{ marginBottom: '12px' }}>
            <label className="boe-input-label">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@bestofexports.com"
              className="boe-input"
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label className="boe-input-label">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="boe-input"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
            />
          </div>

          {error && (
            <div style={{ marginBottom: '16px' }}>
              <AlertBanner variant="red">
                <p style={{ color: colors.red, fontSize: '13px' }}>{error}</p>
              </AlertBanner>
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading || !email || !password}
            className="boe-btn boe-btn-primary"
            style={{
              width: '100%',
              justifyContent: 'center',
              padding: '12px',
              fontSize: '14px',
            }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </div>

        <p style={{
          textAlign: 'center',
          color: colors.muted,
          fontSize: '11px',
          marginTop: '20px',
        }}>
          Best of Exports — Internal use only
        </p>

      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
