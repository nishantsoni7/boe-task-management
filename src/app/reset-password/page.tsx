'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'
import { AuthShell, authButtonStyle, authLinkStyle } from '@/components/auth/AuthShell'
import {
  readRecoveryLink,
  newPasswordProblem,
  isFreshRecoverySession,
  EXPIRED_LINK_MESSAGE,
  MIN_PASSWORD_LENGTH,
} from '@/lib/auth/recoveryLink'

// Where the "reset your password" email lands. The link signs the person in
// for the sole purpose of choosing a new password; once it is saved, every
// other session on the account is signed out, because a forgotten password is
// also the moment someone else might have been using it.

type Stage =
  | { kind: 'checking' }
  | { kind: 'ready'; email: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'done' }

export default function ResetPasswordPage() {
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [stage,    setStage]    = useState<Stage>({ kind: 'checking' })
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [visible,  setVisible]  = useState(false)
  const [error,    setError]    = useState('')
  const [saving,   setSaving]   = useState(false)

  useEffect(() => {
    const init = async () => {
      const link = readRecoveryLink(window.location.search, window.location.hash)

      if (link.kind === 'error') {
        setStage({ kind: 'invalid', message: link.message })
        return
      }

      if (link.kind === 'token_hash') {
        const { error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: 'recovery' })
        if (error) {
          setStage({ kind: 'invalid', message: EXPIRED_LINK_MESSAGE })
          return
        }
      }

      // For a ?code= link the browser client has already exchanged the code
      // while initialising; getSession() waits for that. A link that did not
      // work leaves any earlier session in place, so the session is only
      // trusted when its token says a reset link created it in the last hour —
      // never a colleague left signed in on this browser.
      const { data: { session } } = await supabase.auth.getSession()

      // The one-time values have done their job; keep them out of history.
      window.history.replaceState(null, '', '/reset-password')

      if (!session || !isFreshRecoverySession(session.access_token, Math.floor(Date.now() / 1000))) {
        setStage({
          kind: 'invalid',
          message: link.kind === 'code'
            ? 'This reset link could not be used here. Open it in the same browser you requested it from, or request a new one.'
            : EXPIRED_LINK_MESSAGE,
        })
        return
      }
      setStage({ kind: 'ready', email: session.user.email ?? '' })
    }
    init()
  }, [supabase])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const problem = newPasswordProblem(password, confirm)
    if (problem) { setError(problem); return }

    setSaving(true)
    setError('')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setSaving(false)
      setError(error.message || 'Could not update your password. Please try again.')
      return
    }
    // Best effort: the new password is already saved even if this fails.
    await supabase.auth.signOut({ scope: 'others' })
    setSaving(false)
    setPassword('')
    setConfirm('')
    setStage({ kind: 'done' })
  }

  if (stage.kind === 'checking') return <LoadingScreen />

  if (stage.kind === 'invalid') {
    return (
      <AuthShell title="Reset link not valid">
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '13px', lineHeight: 1.5 }}>{stage.message}</p>
        </AlertBanner>
        <Link
          href="/forgot-password"
          className="boe-btn boe-btn-primary"
          style={{ ...authButtonStyle, marginTop: '16px', textDecoration: 'none' }}
        >
          Request a new link
        </Link>
        <Link href="/login" style={authLinkStyle}>Back to sign in</Link>
      </AuthShell>
    )
  }

  if (stage.kind === 'done') {
    return (
      <AuthShell title="Password updated">
        <AlertBanner variant="green">
          <p style={{ color: colors.green, fontSize: '13px', lineHeight: 1.5 }}>
            Your new password is saved. Use it the next time you sign in.
          </p>
        </AlertBanner>
        <button
          type="button"
          onClick={() => router.replace('/')}
          className="boe-btn boe-btn-primary"
          style={{ ...authButtonStyle, marginTop: '16px' }}
        >
          Continue to BOE One
        </button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={handleSave} noValidate>
        {stage.email && (
          <p style={{ color: colors.tertiary, fontSize: '12.5px', lineHeight: 1.5, marginBottom: '16px' }}>
            For <strong style={{ color: colors.primary }}>{stage.email}</strong>
          </p>
        )}

        <div style={{ marginBottom: '12px' }}>
          <label htmlFor="reset-new-password" className="boe-input-label">New password</label>
          <div style={{ position: 'relative' }}>
            <input
              id="reset-new-password"
              type={visible ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={e => { setPassword(e.target.value); setError('') }}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              aria-invalid={!!error || undefined}
              className="boe-input"
              style={{ paddingRight: '40px' }}
            />
            <button
              type="button"
              onClick={() => setVisible(v => !v)}
              aria-label={visible ? 'Hide passwords' : 'Show passwords'}
              aria-pressed={visible}
              style={{
                position: 'absolute', top: 0, right: 0, bottom: 0, width: 38,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.tertiary,
              }}
            >
              {visible ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label htmlFor="reset-confirm-password" className="boe-input-label">Confirm new password</label>
          <input
            id="reset-confirm-password"
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirm}
            onChange={e => { setConfirm(e.target.value); setError('') }}
            placeholder="Re-enter new password"
            aria-invalid={!!error || undefined}
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
          disabled={saving}
          aria-busy={saving}
          className="boe-btn boe-btn-primary"
          style={authButtonStyle}
        >
          {saving ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </AuthShell>
  )
}
