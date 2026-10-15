'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { AlertBanner } from '@/components/ui/atoms'
import { AuthShell, authButtonStyle, authLinkStyle } from '@/components/auth/AuthShell'
import { safeReturnPath } from '@/lib/safeReturnPath'

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
    // Only an internal BOE path is followed: "//host" and "/\host" pass a bare
    // startsWith('/') check and would send someone off-site after signing in.
    router.push(safeReturnPath(redirect) ?? '/')
  }

  return (
    <AuthShell title="Sign in">
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
        style={authButtonStyle}
      >
        {loading ? 'Signing in...' : 'Sign in'}
      </button>

      <Link href="/forgot-password" style={authLinkStyle}>
        Forgot password?
      </Link>
    </AuthShell>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
