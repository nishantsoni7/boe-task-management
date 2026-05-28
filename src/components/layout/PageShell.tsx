'use client'

import { colors, font } from '@/lib/tokens'

// ─── PageShell ────────────────────────────────────────────────────────────────
// Wraps every authenticated page with topbar + scrollable body.
// Used by: dashboard, manager

type PageShellProps = {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  narrow?: boolean
  children: React.ReactNode
}

export function PageShell({
  title,
  subtitle,
  actions,
  narrow = false,
  children,
}: PageShellProps) {
  const containerClass = narrow ? 'boe-container-narrow' : 'boe-container'

  return (
    <div style={{ minHeight: '100vh', backgroundColor: colors.void }}>

      <div className="boe-topbar">
        <div
          className={containerClass}
          style={{
            padding: '14px 22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div>
            <h1
              style={{
                color: colors.primary,
                fontFamily: font.display,
                fontWeight: 600,
                fontSize: '17px',
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
              }}
            >
              {title}
            </h1>
            {subtitle && (
              <p style={{ color: colors.secondary, fontSize: '12px', marginTop: '2px' }}>
                {subtitle}
              </p>
            )}
          </div>

          {actions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              {actions}
            </div>
          )}
        </div>
      </div>

      <div className={containerClass} style={{ padding: '18px 22px' }}>
        {children}
      </div>

    </div>
  )
}

// ─── BackBarShell ─────────────────────────────────────────────────────────────
// Topbar with a back button on the left.
// Used by: task detail, create task, members

type BackBarShellProps = {
  title: string
  onBack: () => void
  actions?: React.ReactNode
  narrow?: boolean
  children: React.ReactNode
}

export function BackBarShell({
  title,
  onBack,
  actions,
  narrow = true,
  children,
}: BackBarShellProps) {
  const containerClass = narrow ? 'boe-container-narrow' : 'boe-container'

  return (
    <div style={{ minHeight: '100vh', backgroundColor: colors.void }}>

      <div className="boe-topbar">
        <div
          className={containerClass}
          style={{
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <button
            onClick={onBack}
            style={{
              color: colors.tertiary,
              fontSize: '13px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 0',
              flexShrink: 0,
            }}
          >
            ← Back
          </button>

          <h1
            style={{
              color: colors.primary,
              fontFamily: font.display,
              fontWeight: 600,
              fontSize: '16px',
              flex: 1,
            }}
          >
            {title}
          </h1>

          {actions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              {actions}
            </div>
          )}
        </div>
      </div>

      <div
        className={containerClass}
        style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
      >
        {children}
      </div>

    </div>
  )
}