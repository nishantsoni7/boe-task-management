'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import {
  Users, ChevronDown, LogOut, Settings,
  Eye, X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { useViewAs } from '@/hooks/useViewAs'
import { createClient } from '@/lib/supabase/client'
import { employeeSubtitle } from '@/lib/users/designationLevels'

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
// Bottom sidebar block: the Switch User dropdown (admin only) above one user
// identity control that opens Account Settings and Sign Out — see UserMenu.
// When impersonating, shows the viewed-user chip + Exit View Mode instead.
// Renders nothing if profile is null.
//
// Every module layout mounts this, so the identity control is the same on the
// Task Management, Orders, Finance, Assets, Meetings, Samples, Attendance,
// Payroll, Customer Reviews, Image Editor, Showroom and Control Center shells,
// and on the launcher.

export function ViewModeSidebarSection({
  profile,
  onSignOut,
  accountSettingsHref,
}: {
  profile: UserProfile | null
  onSignOut: () => void
  /** If provided, shows an Account Settings link navigating to this URL. */
  accountSettingsHref?: string
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
        .select('id, full_name, email, phone, role, team, position, designation_level, is_active, created_at')
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
              <div style={{ fontSize: '10.5px', color: '#D97706' }}>
                {viewAsProfile ? employeeSubtitle(viewAsProfile) : ''}
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
        /* ── Normal mode: the user menu + the admin View As switcher ── */
        <>
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
                            {/* Their designation, not `member` — the switcher
                                names people the way the rest of the app does. */}
                            <div style={{ fontSize: '10.5px', color: '#8C94A6' }}>
                              {employeeSubtitle(member)}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ONE identity control, in place of the chip + two loose buttons
              that used to sit here. Account Settings and Sign Out are the two
              things it opens, and Control Center deliberately is not among
              them: that is application navigation for authorized
              administrators, not an account action. */}
          <UserMenu
            profile={profile}
            accountSettingsHref={accountSettingsHref}
            onSignOut={onSignOut}
          />
        </>
      )}
    </div>
  )
}

// ─── UserMenu ─────────────────────────────────────────────────────────────────
//
// The signed-in person, and the two actions that belong to their account.
//
// WHAT IT SHOWS. Avatar, name, and the same secondary line every other screen
// uses — job title, or the organisational level when there is no title,
// qualified by department. Never `member`: that is the authorization role, and
// showing an employee a technical label as though it described their job is the
// exact confusion this work exists to remove. employeeSubtitle cannot leak it,
// because it is not given `role` at all.
//
// BEHAVIOUR. Click outside closes. Escape closes and returns focus to the
// trigger, so a keyboard user is never stranded. Up/Down move between the two
// items and Home/End jump to the ends; opening moves focus to the first item.
// The trigger carries aria-haspopup="menu" and aria-expanded, and the popover is
// role="menu" with role="menuitem" children, so a screen reader announces a menu
// rather than two anonymous buttons.
//
// SIGN OUT IS UNCHANGED — it calls the same `onSignOut` each layout already
// passed, which is that layout's own supabase.auth.signOut() plus its redirect.
// Account Settings navigates to the same `accountSettingsHref` the old button
// did, per-layout returnTo included.
function UserMenu({
  profile, accountSettingsHref, onSignOut,
}: {
  profile: UserProfile
  accountSettingsHref?: string
  onSignOut: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs   = useRef<(HTMLButtonElement | null)[]>([])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  // Escape anywhere closes it — a menu that only closes when you find its
  // trigger again is a trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Focus the first item on open, which is what makes the menu usable from the
  // keyboard at all: Enter on the trigger lands somewhere.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus()
  }, [open])

  const items: { label: string; icon: React.ReactNode; onSelect: () => void }[] = [
    ...(accountSettingsHref ? [{
      label: 'Account Settings',
      icon: <Settings size={14} strokeWidth={1.8} />,
      onSelect: () => { setOpen(false); router.push(accountSettingsHref) },
    }] : []),
    {
      label: 'Sign Out',
      icon: <LogOut size={14} strokeWidth={1.8} />,
      onSelect: () => { setOpen(false); onSignOut() },
    },
  ]

  const onItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); itemRefs.current[(index + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); itemRefs.current[(index - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Home')      { e.preventDefault(); itemRefs.current[0]?.focus() }
    else if (e.key === 'End')       { e.preventDefault(); itemRefs.current[items.length - 1]?.focus() }
    else if (e.key === 'Tab')       { close(false) }
  }

  const subtitle = employeeSubtitle(profile)

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${profile.full_name}`}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
          padding: '8px 10px', borderRadius: '8px',
          background: open ? 'rgba(0,0,0,0.05)' : 'transparent',
          border: 'none', cursor: 'pointer', textAlign: 'left',
          font: 'inherit', transition: 'background 0.12s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)' }}
        onMouseLeave={e => { e.currentTarget.style.background = open ? 'rgba(0,0,0,0.05)' : 'transparent' }}
      >
        <span style={{
          width: 30, height: 30, borderRadius: '8px',
          background: '#1A2035',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: 700,
          color: '#DC1F2E', flexShrink: 0,
          letterSpacing: '0.02em',
        }}>
          {initials(profile.full_name)}
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'block', fontSize: '12.5px', fontWeight: 600, color: '#111318',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {profile.full_name}
          </span>
          {subtitle && (
            <span style={{
              display: 'block', fontSize: '10.5px', color: '#8C94A6',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {subtitle}
            </span>
          )}
        </span>
        <ChevronDown
          size={13} strokeWidth={2}
          style={{
            flexShrink: 0, color: '#8C94A6',
            transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s',
          }}
        />
      </button>

      {open && (
        <>
          {/* Click-away. A fixed full-screen catcher rather than a document
              listener, so a tap anywhere on mobile closes the menu without
              also activating what is underneath. */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onClick={() => close(false)}
          />
          <div
            role="menu"
            aria-label="Account"
            style={{
              position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0,
              background: '#fff',
              border: '1px solid #E5E7EB',
              borderRadius: '10px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              zIndex: 50,
              padding: '5px',
            }}
          >
            {items.map((item, index) => (
              <button
                key={item.label}
                ref={el => { itemRefs.current[index] = el }}
                type="button"
                role="menuitem"
                onClick={item.onSelect}
                onKeyDown={e => onItemKeyDown(e, index)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '9px',
                  padding: '8px 10px', borderRadius: '7px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  textAlign: 'left', font: 'inherit',
                  fontSize: '12.5px', color: '#3D4455',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                <span style={{ color: '#8C94A6', display: 'flex' }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
