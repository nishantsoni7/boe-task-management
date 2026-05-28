'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { colors, font } from '@/lib/tokens'
import { AlertBanner } from '@/components/ui/atoms'

export default function LoginPage() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const router = useRouter()

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
    router.push('/dashboard')
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
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <h1 style={{
            fontFamily: font.display,
            fontSize: '22px',
            fontWeight: 700,
            color: colors.primary,
            letterSpacing: '-0.01em',
          }}>
            Best of Exports
          </h1>
          <p style={{ color: colors.tertiary, fontSize: '13px', marginTop: '3px' }}>
            Task Management
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