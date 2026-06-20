'use client'

import { useState, useMemo } from 'react'
import {
  Users, ChevronDown, LogOut, Settings,
  Eye, X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { useViewAs } from '@/hooks/useViewAs'
import { createClient } from '@/lib/supabase/client'

// ─── ViewModeBanner ───────────────────────────────────────────────────────────
// Amber "ADMIN VIEW MODE" inline banner rendered inside the page body.
// Renders nothing when not impersonating.

export function ViewModeBanner() {
  const { viewAsProfile, exitViewMode } = useViewAs()

  if (!viewAsProfile) return null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: '8px',
      padding: '12px 20px',
      background: '#FFFBEB',
      border: '1.5px solid #FCD34D',
      borderRadius: '10px',
      marginBottom: '20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Eye size={16} color="#D97706" strokeWidth={2.2} style={{ flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#78350F', letterSpacing: '-0.01em' }}>
            ADMIN VIEW MODE — Viewing as <strong>{viewAsProfile.full_name}</strong>
          </div>
          <div style={{ fontSize: '11.5px', color: '#92400E', marginTop: '1px' }}>
            You are observing this user&apos;s workspace. All actions are disabled.
          </div>
        </div>
        <span style={{
          fontSize: '10px', fontWeight: 700,
          color: '#B45309', background: '#FEF3C7',
          borderRadius: '4px', padding: '2px 8px',
          border: '1px solid #FDE68A',
          whiteSpace: 'nowrap',
        }}>
          READ ONLY
        </span>
      </div>
      <button
        onClick={exitViewMode}
        style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          fontSize: '12px', fontWeight: 600,
          color: '#92400E', background: '#FEF3C7',
          border: '1px solid #FDE68A', borderRadius: '6px',
          padding: '6px 14px', cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <X size={12} strokeWidth={2.5} />
        Exit View Mode
      </button>
    </div>
  )
}

// ─── ViewModeSidebarSection ───────────────────────────────────────────────────
// Bottom sidebar block: profile chip + Switch User dropdown (admin) + sign out.
// When impersonating, shows the viewed-user chip + Exit View Mode.
// Renders nothing if profile is null.

export function ViewModeSidebarSection({
  profile,
  onSignOut,
  showSettingsLink = false,
  onSettingsClick,
}: {
  profile: UserProfile | null
  onSignOut: () => void
  showSettingsLink?: boolean
  onSettingsClick?: () => void
}) {
  const { viewAsUserId, viewAsProfile, enterViewMode, exitViewMode } = useViewAs()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const supabase = useMemo(() => createClient(), [])

  const isRealAdmin = profile?.role === 'admin'
  const inViewMode  = !!viewAsUserId

  // Fetch member list once — only needed for the admin switcher
  const { data: members = [] } = useQuery<UserProfile[]>({
    queryKey: ['users', 'active-full'],
    queryFn: async () => {
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('is_active', true)
        .order('full_name')
      return (data as UserProfile[]) ?? []
    },
    enabled: isRealAdmin,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  })

  const handleEnterViewMode = (member: UserProfile) => {
    enterViewMode(member.id, member)
    setSwitcherOpen(false)
  }

  const handleExitViewMode = () => {
    exitViewMode()
  }

  if (!profile) return null

  return (
    <div style={{
      marginTop: 'auto',
      borderTop: '1px solid rgba(0,0,0,0.07)',
      padding: '10px 10px 6px',
    }}>
      {inViewMode ? (
        /* ── View mode active: show viewed-user chip + Exit button ── */
        <div style={{ padding: '8px 10px 6px' }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, color: '#D97706',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px',
          }}>
            Viewing As
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{
              width: 28, height: 28, borderRadius: '7px',
              background: '#FEF3C7',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '11px', fontWeight: 700, color: '#D97706', flexShrink: 0,
            }}>
              {initials(viewAsProfile?.full_name ?? '')}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {viewAsProfile?.full_name}
              </div>
              <div style={{ fontSize: '10.5px', color: '#D97706', textTransform: 'capitalize' }}>
                {viewAsProfile?.role} · {viewAsProfile?.team}
              </div>
            </div>
          </div>
          <button
            onClick={handleExitViewMode}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '6px', fontSize: '12px', fontWeight: 600,
              color: '#92400E', background: '#FEF3C7',
              border: '1px solid #FDE68A', borderRadius: '7px',
              padding: '6px 10px', cursor: 'pointer',
            }}
          >
            <X size={12} strokeWidth={2.5} />
            Exit View Mode
          </button>
        </div>
      ) : (
        /* ── Normal mode: profile chip + optional switcher + sign out ── */
        <>
          {/* Profile chip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px 6px' }}>
            <div style={{
              width: 30, height: 30, borderRadius: '8px',
              background: '#1A2035',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '11px', fontWeight: 700,
              color: '#DC1F2E', flexShrink: 0,
              letterSpacing: '0.02em',
            }}>
              {initials(profile.full_name)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {profile.full_name}
              </div>
              <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                {profile.role} · {profile.team}
              </div>
            </div>
          </div>

          {/* Switch User — admin only */}
          {isRealAdmin && members.length > 0 && (
            <div style={{ position: 'relative', margin: '4px 0 6px' }}>
              <button
                onClick={() => setSwitcherOpen(o => !o)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  fontSize: '12px', fontWeight: 500,
                  color: '#3D4455', background: 'rgba(0,0,0,0.04)',
                  border: '1px solid rgba(0,0,0,0.08)', borderRadius: '7px',
                  padding: '6px 10px', cursor: 'pointer',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Users size={13} strokeWidth={1.8} />
                  Switch User
                </span>
                <ChevronDown
                  size={12} strokeWidth={2}
                  style={{ transform: switcherOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                />
              </button>

              {switcherOpen && (
                <>
                  {/* Click-away backdrop */}
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                    onClick={() => setSwitcherOpen(false)}
                  />
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0,
                    background: '#fff',
                    border: '1px solid #E5E7EB',
                    borderRadius: '10px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                    zIndex: 50,
                    maxHeight: '260px',
                    overflowY: 'auto',
                    padding: '6px',
                  }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 8px 6px' }}>
                      View as member
                    </div>
                    {members
                      .filter(m => m.id !== profile.id)
                      .map(member => (
                        <button
                          key={member.id}
                          onClick={() => handleEnterViewMode(member)}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                            padding: '7px 8px', borderRadius: '7px',
                            background: 'none', border: 'none', cursor: 'pointer',
                            textAlign: 'left', transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                        >
                          <div style={{
                            width: 26, height: 26, borderRadius: '6px',
                            background: '#1A2035',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '10px', fontWeight: 700, color: '#DC1F2E', flexShrink: 0,
                          }}>
                            {initials(member.full_name)}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '12.5px', fontWeight: 500, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {member.full_name}
                            </div>
                            <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                              {member.role}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Account Settings — non-admin only, opt-in per layout */}
          {showSettingsLink && !isRealAdmin && onSettingsClick && (
            <button
              className="boe-nav-item"
              onClick={onSettingsClick}
              style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
            >
              <Settings size={14} strokeWidth={1.8} />
              Account Settings
            </button>
          )}

          {/* Sign out */}
          <button
            onClick={onSignOut}
            className="boe-nav-item"
            style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
          >
            <LogOut size={14} strokeWidth={1.8} />
            Sign out
          </button>
        </>
      )}
    </div>
  )
}
