'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { initials } from '@/lib/ui'
import { LogOut, Briefcase } from 'lucide-react'

type Module = {
  title: string
  description: string
  href: string
  available: boolean
  accent: string
  icon: React.ReactNode
}

const MODULES: Module[] = [
  {
    title: 'Task Management',
    description: 'Create, assign, and track tasks across your team.',
    href: '/dashboard',
    available: true,
    accent: '#1A2035',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    title: 'Attendance & Salary',
    description: 'Manage attendance records, leave requests, and payroll.',
    href: '/attendance',
    available: true,
    accent: '#0F766E',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
      </svg>
    ),
  },
  {
    title: 'Finance',
    description: 'Budgeting, expenses, and financial reporting.',
    href: '#',
    available: false,
    accent: '#92400E',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
  },
  {
    title: 'More Modules',
    description: 'Additional tools and workflows — coming soon.',
    href: '#',
    available: false,
    accent: '#6B7280',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
      </svg>
    ),
  },
]

export default function HomePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
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

  if (loading) return <LoadingScreen />

  return (
    <div style={{
      minHeight: '100vh',
      background: colors.void,
    }}>

      {/* Top bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        height: '56px',
        background: '#fff',
        borderBottom: `1px solid ${colors.border}`,
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 30, height: 30, borderRadius: '8px',
            background: '#1A2035',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Briefcase size={14} color="#E8A030" strokeWidth={2} />
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontFamily: font.display, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              Best of Exports
            </div>
            <div style={{ fontSize: '10.5px', color: colors.muted, lineHeight: 1 }}>
              Internal Platform
            </div>
          </div>
        </div>

        {profile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{
                width: 30, height: 30, borderRadius: '8px',
                background: '#1A2035',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#E8A030',
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, lineHeight: 1.2 }}>
                  {profile.full_name}
                </span>
                <span style={{ fontSize: '10.5px', color: colors.muted, textTransform: 'capitalize', lineHeight: 1 }}>
                  {profile.role} · {profile.team}
                </span>
              </div>
            </div>
            <button
              onClick={handleSignOut}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '12.5px', color: colors.tertiary,
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '6px 10px', borderRadius: '7px',
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = colors.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <LogOut size={14} strokeWidth={1.8} />
              Sign out
            </button>
          </div>
        )}
      </header>

      {/* Page content */}
      <main style={{
        maxWidth: 800,
        margin: '0 auto',
        padding: '56px 24px 48px',
      }}>

        {/* Hero text */}
        <div style={{ marginBottom: '48px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', color: colors.muted, textTransform: 'uppercase', marginBottom: '8px' }}>
            BOE INTERNAL PLATFORM
          </div>
          <h1 style={{
            fontFamily: font.display,
            fontSize: '28px',
            fontWeight: 700,
            color: colors.primary,
            letterSpacing: '-0.02em',
            margin: 0,
            lineHeight: 1.2,
          }}>
            Welcome back{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}.
          </h1>
          <p style={{ margin: '10px 0 0', fontSize: '14px', color: colors.tertiary, lineHeight: 1.6 }}>
            Select a module to get started.
          </p>
        </div>

        {/* Module cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '16px',
        }}>
          {MODULES.map(mod => (
            <ModuleCard key={mod.title} mod={mod} onNavigate={router.push} />
          ))}
        </div>

      </main>
    </div>
  )
}

function ModuleCard({ mod, onNavigate }: { mod: Module; onNavigate: (href: string) => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={() => mod.available && onNavigate(mod.href)}
      onMouseEnter={() => mod.available && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: '#fff',
        border: `1.5px solid ${hovered ? mod.accent : colors.border}`,
        borderRadius: '12px',
        padding: '24px',
        cursor: mod.available ? 'pointer' : 'default',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? `0 4px 16px rgba(0,0,0,0.08)` : '0 1px 3px rgba(0,0,0,0.04)',
        position: 'relative',
        opacity: mod.available ? 1 : 0.6,
      }}
    >
      {/* Icon */}
      <div style={{
        width: 48, height: 48, borderRadius: '12px',
        background: mod.available ? `${mod.accent}14` : colors.float,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: mod.available ? mod.accent : colors.muted,
        marginBottom: '16px',
      }}>
        {mod.icon}
      </div>

      {/* Coming soon badge */}
      {!mod.available && (
        <span style={{
          position: 'absolute', top: '16px', right: '16px',
          fontSize: '10px', fontWeight: 700,
          color: colors.muted,
          background: colors.float,
          border: `1px solid ${colors.border}`,
          borderRadius: '999px',
          padding: '2px 9px',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          Coming soon
        </span>
      )}

      {/* Text */}
      <div style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, marginBottom: '6px', fontFamily: font.display, letterSpacing: '-0.01em' }}>
        {mod.title}
      </div>
      <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.55 }}>
        {mod.description}
      </div>

      {/* Arrow for available modules */}
      {mod.available && (
        <div style={{
          marginTop: '20px',
          display: 'flex', alignItems: 'center', gap: '4px',
          fontSize: '12.5px', fontWeight: 600,
          color: hovered ? mod.accent : colors.muted,
          transition: 'color 0.15s',
        }}>
          Open module
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: hovered ? 'translateX(3px)' : 'none', transition: 'transform 0.15s' }}>
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </div>
      )}
    </div>
  )
}
