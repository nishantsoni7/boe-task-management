'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Eye, LogOut, Search, UserCog, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { createClient as createIsolatedClient } from '@supabase/supabase-js'
import { initials } from '@/lib/ui'
import {
  IMPERSONATION_STASH_KEY,
  readStash,
  writeStash,
  type ImpersonationMember,
  type ImpersonationStash,
} from '@/lib/impersonation'

// FLOATING "LOGIN AS MEMBER" — mounted once from Providers, so it floats over
// every page of every module, including the launcher. Rules and the session
// model are in src/lib/impersonation.ts.

const PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password']

function tokenExpiresSoon(jwt: string): boolean {
  try {
    const exp = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp as number
    return exp * 1000 - Date.now() < 60_000
  } catch {
    return true
  }
}

// The administrator's access token while a member's session is live. Refreshes
// through an isolated client so the shared browser session is never touched, and
// stores the rotated tokens back, since a refresh token is single-use.
async function freshAdminToken(s: ImpersonationStash): Promise<string | null> {
  if (!tokenExpiresSoon(s.admin.accessToken)) return s.admin.accessToken
  const iso = createIsolatedClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )
  const { data, error } = await iso.auth.setSession({
    access_token: s.admin.accessToken,
    refresh_token: s.admin.refreshToken,
  })
  if (error || !data.session) return null
  writeStash({
    ...s,
    admin: { ...s.admin, accessToken: data.session.access_token, refreshToken: data.session.refresh_token },
  })
  return data.session.access_token
}

function subtitleOf(m: ImpersonationMember): string {
  return [m.position || m.designation_level, m.team].filter(Boolean).join(' · ')
}

export default function LoginAsMemberWidget() {
  const pathname = usePathname() ?? ''
  const supabase = useMemo(() => createClient(), [])

  const [stash, setStash] = useState<ImpersonationStash | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<ImpersonationMember[] | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Identity: a real admin, or a stash proving we are mid-impersonation.
  useEffect(() => {
    let cancelled = false
    const sync = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return
      const s = readStash()
      // A stash that no longer matches the live session (signed out, or signed
      // in as somebody else) is stale — drop it so nobody is shown a false state.
      if (s && (!session || (session.user.id !== s.target.id && session.user.id !== s.admin.id))) {
        writeStash(null)
        setStash(null)
      } else {
        setStash(s)
      }
      if (!session) { setIsAdmin(false); return }
      if (s && session.user.id === s.target.id) { setIsAdmin(false); return }
      const { data } = await supabase.from('users').select('role').eq('id', session.user.id).maybeSingle()
      if (!cancelled) setIsAdmin(data?.role === 'admin')
    }
    void sync()
    const { data: sub } = supabase.auth.onAuthStateChange(() => { void sync() })
    const onStorage = (e: StorageEvent) => { if (e.key === IMPERSONATION_STASH_KEY) void sync() }
    window.addEventListener('storage', onStorage)
    return () => { cancelled = true; sub.subscription.unsubscribe(); window.removeEventListener('storage', onStorage) }
  }, [supabase])

  const impersonating = !!stash

  const loadMembers = useCallback(async () => {
    setError('')
    // While impersonating, the live session is the member's; the list needs the admin's.
    const token = stash ? await freshAdminToken(stash) : (await supabase.auth.getSession()).data.session?.access_token
    if (!token) { setError('Your admin session has expired. Return to your admin account.'); return }
    const res = await fetch('/api/impersonation/members', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) { setError('Could not load members.'); return }
    const json = await res.json() as { members: ImpersonationMember[] }
    setMembers(json.members)
  }, [supabase, stash])

  const toggle = () => {
    if (!open) {
      if (members === null) void loadMembers()
      setTimeout(() => searchRef.current?.focus(), 30)
    }
    setOpen(o => !o)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Put the administrator's own session back. Never signOut(): that revokes
  // refresh tokens and would take the stashed admin session with it.
  const restoreAdmin = useCallback(async (stale: ImpersonationStash): Promise<boolean> => {
    // Re-read: freshAdminToken may have rotated the stashed tokens since render.
    const s = readStash() ?? stale
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        await fetch('/api/impersonation/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ sessionId: s.sessionId }),
        }).catch(() => {})
      }
      const { error: err } = await supabase.auth.setSession({
        access_token: s.admin.accessToken,
        refresh_token: s.admin.refreshToken,
      })
      if (err) return false
      writeStash(null)
      return true
    } catch {
      return false
    }
  }, [supabase])

  const exit = async () => {
    if (!stash) return
    setBusyId('exit'); setError('')
    const ok = await restoreAdmin(stash)
    if (!ok) {
      writeStash(null)
      await supabase.auth.signOut()
      window.location.assign('/login')
      return
    }
    window.location.assign('/modules')
  }

  const loginAs = async (member: ImpersonationMember) => {
    setBusyId(member.id); setError('')
    try {
      // Switching member = return to admin first, so the start call is the admin's.
      if (stash && !(await restoreAdmin(stash))) {
        writeStash(null)
        await supabase.auth.signOut()
        window.location.assign('/login')
        return
      }
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setError('You are signed out.'); setBusyId(null); return }

      const res = await fetch('/api/impersonation/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ targetUserId: member.id }),
      })
      const json = await res.json().catch(() => ({})) as { error?: string; tokenHash?: string; sessionId?: string }
      if (!res.ok || !json.tokenHash || !json.sessionId) {
        setError(json.error ?? 'Could not start the session.'); setBusyId(null); return
      }

      const { data: me } = await supabase.from('users').select('full_name').eq('id', session.user.id).maybeSingle()
      // Stash BEFORE the swap: if the tab dies between the two steps, the
      // administrator can still be restored.
      writeStash({
        sessionId: json.sessionId,
        admin: {
          id: session.user.id,
          fullName: me?.full_name ?? 'Admin',
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
        },
        target: { id: member.id, fullName: member.full_name, subtitle: subtitleOf(member) },
        startedAt: new Date().toISOString(),
      })
      const { error: otpErr } = await supabase.auth.verifyOtp({ token_hash: json.tokenHash, type: 'magiclink' })
      if (otpErr) {
        writeStash(null)
        setError(otpErr.message); setBusyId(null); return
      }
      window.location.assign('/modules')
    } catch {
      setError('Something went wrong. Try again.'); setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = members ?? []
    if (!q) return list
    return list.filter(m =>
      [m.full_name, m.email, m.team, m.position, m.designation_level, m.employee_code, m.role]
        .some(v => (v ?? '').toLowerCase().includes(q)))
  }, [members, query])

  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))) return null
  if (!impersonating && !isAdmin) return null

  const accent = impersonating ? '#805B0D' : '#303536'
  const accentBg = impersonating ? '#FAF0DA' : '#303536'

  return (
    <div style={{ position: 'fixed', right: 16, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)', zIndex: 9999 }}>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: -1 }} onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Login as member"
            style={{
              position: 'absolute', right: 0, bottom: 'calc(100% + 10px)',
              width: 'min(360px, calc(100vw - 32px))', maxHeight: 'min(560px, 70vh)',
              display: 'flex', flexDirection: 'column',
              background: '#fff', border: '1px solid #E4DED7', borderRadius: 14,
              boxShadow: '0 16px 48px rgba(0,0,0,0.22)', overflow: 'hidden',
            }}
          >
            <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid #F0EBE4' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#303536' }}>
                  {impersonating ? 'Switch member' : 'Login as member'}
                </div>
                <button type="button" aria-label="Close" onClick={() => setOpen(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#686D6C', display: 'flex' }}>
                  <X size={16} />
                </button>
              </div>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#686D6C' }} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search name, team, position…"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px 8px 30px',
                    border: '1px solid #E4DED7', borderRadius: 8, fontSize: 13, outline: 'none',
                  }}
                />
              </div>
              {error && <div style={{ marginTop: 8, fontSize: 12, color: '#B9472E' }}>{error}</div>}
            </div>

            <div style={{ overflowY: 'auto', padding: 6, flex: 1 }}>
              {members === null && !error && (
                <div style={{ padding: 16, fontSize: 12.5, color: '#686D6C' }}>Loading members…</div>
              )}
              {members !== null && filtered.length === 0 && (
                <div style={{ padding: 16, fontSize: 12.5, color: '#686D6C' }}>No members match.</div>
              )}
              {filtered.map(m => {
                const isCurrent = stash?.target.id === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busyId !== null || isCurrent}
                    onClick={() => void loginAs(m)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', borderRadius: 8, border: 'none', textAlign: 'left',
                      background: isCurrent ? '#FAF0DA' : 'none',
                      cursor: busyId !== null || isCurrent ? 'default' : 'pointer',
                      opacity: m.is_active ? 1 : 0.65,
                    }}
                    onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = '#FBFAF8' }}
                    onMouseLeave={e => { e.currentTarget.style.background = isCurrent ? '#FAF0DA' : 'none' }}
                  >
                    <span style={{
                      width: 30, height: 30, borderRadius: 8, background: '#303536', color: '#B9472E',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700, flexShrink: 0,
                    }}>{initials(m.full_name)}</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#303536', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {m.full_name}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: '#686D6C', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {subtitleOf(m) || m.role}
                      </span>
                    </span>
                    {!m.is_active && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#686D6C', border: '1px solid #E4DED7', borderRadius: 6, padding: '1px 6px' }}>
                        Inactive
                      </span>
                    )}
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#963B27', background: '#F8EAE4', borderRadius: 6, padding: '1px 6px' }}>
                      {busyId === m.id ? 'Signing in…' : isCurrent ? 'Current' : m.role}
                    </span>
                  </button>
                )
              })}
            </div>

            {impersonating && stash && (
              <div style={{ padding: 10, borderTop: '1px solid #F0EBE4', background: '#FBFAF8' }}>
                <button type="button" onClick={() => void exit()} disabled={busyId !== null}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '9px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: '#303536', color: '#fff', fontSize: 13, fontWeight: 600,
                  }}>
                  <LogOut size={14} /> Return to {stash.admin.fullName}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
        {impersonating && stash && (
          <button type="button" onClick={toggle}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, maxWidth: 'calc(100vw - 96px)',
              padding: '8px 12px', borderRadius: 999, cursor: 'pointer',
              background: '#FAF0DA', color: '#78350F', border: '1.5px solid #FCD34D',
              boxShadow: '0 6px 20px rgba(0,0,0,0.18)', fontSize: 12.5, fontWeight: 600,
            }}>
            <Eye size={14} style={{ flexShrink: 0 }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Acting as {stash.target.fullName}
            </span>
          </button>
        )}
        {impersonating && (
          <button type="button" onClick={() => void exit()} disabled={busyId !== null} aria-label="Return to admin account"
            title="Return to admin account"
            style={{
              width: 44, height: 44, borderRadius: '50%', cursor: 'pointer', border: 'none',
              background: '#303536', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
            }}>
            <LogOut size={18} />
          </button>
        )}
        {!impersonating && (
          <button type="button" onClick={toggle} aria-label="Login as member" title="Login as member"
            style={{
              width: 48, height: 48, borderRadius: '50%', cursor: 'pointer', border: 'none',
              background: accentBg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: `0 6px 20px rgba(0,0,0,0.25), 0 0 0 2px ${accent}33`,
            }}>
            {open ? <X size={20} /> : <UserCog size={20} />}
          </button>
        )}
      </div>
    </div>
  )
}
