'use client'

import { Suspense, useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, CheckCircle2, AlertCircle, Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { colors } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { BoeOsLayout } from '@/components/layout/BoeOsLayout'
import { buildQuickActions } from '@/components/layout/QuickActions'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import { employeeSubtitle, designationLevelLabel } from '@/lib/users/designationLevels'
import { safeReturnPath } from '@/lib/safeReturnPath'

// Account Settings sits inside the same BoeOsLayout shell as the Modules
// launcher, so the sidebar — Home, the viewer's quick actions, View As and the
// identity menu with Sign Out — is the one the rest of BOE already shows. The
// page used to be a standalone header with a Back button; the sidebar replaces
// both, and Sign Out is not repeated in the body because the menu carries it.
export default function AccountPage() {
  // useSearchParams needs a Suspense boundary.
  return (
    <Suspense>
      <AccountPageInner />
    </Suspense>
  )
}

function AccountPageInner() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  // Every shell links here with ?returnTo=<where you came from>. Only an
  // internal BOE path is followed; anything else — or no parameter — means no
  // Back link at all, and the sidebar is the way out.
  const returnTo     = safeReturnPath(searchParams.get('returnTo'))
  const supabase     = useMemo(() => createClient(), [])

  // The sidebar's identity menu names the signed-in person, exactly as it does
  // on Modules. The page's own profile read below is kept for the details the
  // shared context does not select (position, designation level).
  const { profile: actorProfile } = usePermissionContext()

  // Same quick-action gate as the launcher, asked of the same display subject,
  // so the sidebar is identical on both screens. It grants nothing: the
  // destination route and RLS still decide.
  const { ready: permsReady, subjectRole, subjectPermissionsByModule } = useDisplaySubject()
  const financeCaps = deriveFinanceCapabilities(
    subjectRole,
    subjectPermissionsByModule.get('finance') ?? [],
  )
  const quickActions = buildQuickActions({
    canQuickAddExpense: permsReady && financeCaps.canCreatePaymentRecord,
  })

  const [profile,         setProfile]         = useState<UserProfile | null>(null)
  const [loading,         setLoading]         = useState(true)
  const [newPassword,     setNewPassword]     = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPasswords,   setShowPasswords]   = useState(false)
  const [pwError,         setPwError]         = useState('')
  const [pwSuccess,       setPwSuccess]       = useState('')
  const [pwLoading,       setPwLoading]       = useState(false)

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, designation_level, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      setProfile(data as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError('')
    setPwSuccess('')

    if (!newPassword) { setPwError('New password is required.'); return }
    if (newPassword.length < 8) { setPwError('Password must be at least 8 characters.'); return }
    if (newPassword !== confirmPassword) { setPwError('Passwords do not match.'); return }

    setPwLoading(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setPwLoading(false)

    if (error) {
      setPwError(error.message || 'Failed to update password. Please try again.')
    } else {
      setPwSuccess('Password updated successfully.')
      setNewPassword('')
      setConfirmPassword('')
      setShowPasswords(false)
    }
  }

  if (loading) return <LoadingScreen />

  const level    = designationLevelLabel(profile?.designation_level)
  // Designation and department — the employee's own words for their job. The
  // authorization `role` (e.g. "member") is deliberately not shown here: it is
  // not a description of anybody's job.
  const subtitle = profile ? employeeSubtitle(profile) : ''

  return (
    <BoeOsLayout
      profile={actorProfile ?? profile}
      title="Account Settings"
      subtitle="Your profile details and sign-in password"
      onSignOut={handleSignOut}
      quickActions={quickActions}
      contentMaxWidth={760}
      headerActions={returnTo ? (
        <Link href={returnTo} className="boe-btn boe-btn-ghost">
          <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" /> Back
        </Link>
      ) : null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Account identity */}
        {profile && (
          <section aria-labelledby="account-profile-heading" style={card}>
            <h2 id="account-profile-heading" style={sectionTitle}>Profile</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                background: '#1A2035',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, fontWeight: 700, color: '#DC1F2E',
                flexShrink: 0, letterSpacing: '0.02em',
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: colors.primary, overflowWrap: 'anywhere' }}>
                  {profile.full_name}
                </div>
                {subtitle && (
                  <div style={{ fontSize: 12.5, color: colors.tertiary, marginTop: 2 }}>{subtitle}</div>
                )}
              </div>
            </div>

            <dl style={{
              margin: '18px 0 0', paddingTop: 16,
              borderTop: `1px solid ${colors.border}`,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px 24px',
            }}>
              <Detail label="Role" value={subtitle || '—'} />
              {level && <Detail label="Level" value={level} />}
              <Detail label="Email" value={profile.email || '—'} />
            </dl>
          </section>
        )}

        {/* Change password */}
        <section aria-labelledby="account-password-heading" style={card}>
          <h2 id="account-password-heading" style={sectionTitle}>Change Password</h2>
          <p style={{ margin: '4px 0 18px', fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
            Choose a new password for signing in to BOE.
          </p>

          <form
            onSubmit={handleChangePassword}
            noValidate
            style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 420 }}
          >
            <PasswordField
              id="account-new-password"
              label="New password"
              value={newPassword}
              onChange={v => { setNewPassword(v); setPwSuccess('') }}
              placeholder="Enter new password"
              visible={showPasswords}
              onToggleVisible={() => setShowPasswords(s => !s)}
              hint="At least 8 characters."
              invalid={!!pwError}
            />
            <PasswordField
              id="account-confirm-password"
              label="Confirm new password"
              value={confirmPassword}
              onChange={v => { setConfirmPassword(v); setPwSuccess('') }}
              placeholder="Re-enter new password"
              visible={showPasswords}
              onToggleVisible={() => setShowPasswords(s => !s)}
              invalid={!!pwError}
            />

            {pwError && (
              <div role="alert" style={{ ...message, color: '#B91C1C', background: '#FEF2F2', borderColor: '#FECACA' }}>
                <AlertCircle size={15} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
                {pwError}
              </div>
            )}
            {pwSuccess && (
              <div role="status" style={{ ...message, color: '#15803D', background: '#F0FDF4', borderColor: '#BBF7D0' }}>
                <CheckCircle2 size={15} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
                {pwSuccess}
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={pwLoading}
                aria-busy={pwLoading}
                style={{
                  padding: '9px 20px', fontSize: 13.5, fontWeight: 600,
                  background: colors.primary, color: '#fff',
                  border: 'none', borderRadius: 7,
                  cursor: pwLoading ? 'not-allowed' : 'pointer',
                  opacity: pwLoading ? 0.7 : 1,
                  transition: 'opacity 0.15s',
                }}
              >
                {pwLoading ? 'Updating…' : 'Update Password'}
              </button>
            </div>
          </form>
        </section>

      </div>
    </BoeOsLayout>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#fff',
  border: `1px solid ${colors.border}`,
  borderRadius: 12,
  padding: '20px 22px',
}

const sectionTitle: React.CSSProperties = {
  margin: 0, fontSize: 15, fontWeight: 600, color: colors.primary,
}

const message: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8,
  margin: 0, padding: '9px 12px',
  fontSize: 13, lineHeight: 1.4,
  border: '1px solid', borderRadius: 7,
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt style={{ fontSize: 11.5, fontWeight: 500, color: colors.tertiary, marginBottom: 3 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13.5, color: colors.primary, overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  )
}

function PasswordField({
  id, label, value, onChange, placeholder, visible, onToggleVisible, hint, invalid,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  visible: boolean
  onToggleVisible: () => void
  hint?: string
  invalid: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label htmlFor={id} style={{ fontSize: 12.5, fontWeight: 500, color: colors.secondary }}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          style={{
            width: '100%', boxSizing: 'border-box',
            fontSize: 13.5, padding: '8px 40px 8px 12px',
            border: `1px solid ${invalid ? '#FCA5A5' : colors.border}`,
            borderRadius: 7, outline: 'none',
            background: '#FAFAFA', color: colors.primary,
          }}
        />
        <button
          type="button"
          onClick={onToggleVisible}
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
      {hint && (
        <div id={`${id}-hint`} style={{ fontSize: 11.5, color: colors.tertiary }}>{hint}</div>
      )}
    </div>
  )
}
