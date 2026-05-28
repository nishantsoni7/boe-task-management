// ─── Small reusable UI atoms ──────────────────────────────────────────────────
// Import individual named exports as needed.

import { initials, statusBadgeClass } from '@/lib/ui'
import type { TaskStatus } from '@/lib/types'
import { colors } from '@/lib/tokens'

// ─── Avatar ───────────────────────────────────────────────────────────────────
type AvatarProps = {
  name: string
  size?: number  // px, default 28
}

export function Avatar({ name, size = 28 }: AvatarProps) {
  return (
    <div
      className="boe-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name)}
    </div>
  )
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────
type StatusBadgeProps = {
  status: TaskStatus | string
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={statusBadgeClass(status)}>{status}</span>
  )
}

// ─── AlertBanner ──────────────────────────────────────────────────────────────
type AlertVariant = 'red' | 'amber' | 'green'

type AlertBannerProps = {
  variant: AlertVariant
  children: React.ReactNode
}

export function AlertBanner({ variant, children }: AlertBannerProps) {
  return (
    <div className={`boe-alert-${variant}`}>
      {children}
    </div>
  )
}

// ─── SectionLabel ─────────────────────────────────────────────────────────────
type SectionLabelProps = {
  children: React.ReactNode
  count?: number
}

export function SectionLabel({ children, count }: SectionLabelProps) {
  return (
    <div className="boe-section-label">
      {children}
      {count !== undefined && (
        <span style={{
          marginLeft: 'auto',
          fontSize: '10px',
          padding: '1px 6px',
          borderRadius: '3px',
          background: 'rgba(255,255,255,0.03)',
          border: `1px solid ${colors.border}`,
          color: colors.secondary,
          fontFamily: 'var(--font-mono)',
        }}>
          {count}
        </span>
      )}
    </div>
  )
}

// ─── EmptyState ───────────────────────────────────────────────────────────────
type EmptyStateProps = {
  message: string
  hint?: string
}

export function EmptyState({ message, hint }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '64px 0' }}>
      <p style={{ color: colors.muted, fontSize: '13px' }}>{message}</p>
      {hint && (
        <p style={{ color: '#2E3340', fontSize: '12px', marginTop: '4px' }}>{hint}</p>
      )}
    </div>
  )
}

// ─── LoadingScreen ────────────────────────────────────────────────────────────
type LoadingScreenProps = {
  message?: string
}

export function LoadingScreen({ message = 'Loading...' }: LoadingScreenProps) {
  return (
    <div className="boe-loading">
      <p>{message}</p>
    </div>
  )
}