// ─── KpiCard and KpiGrid ──────────────────────────────────────────────────────
// Used on: dashboard, manager view

type KpiAccent = 'amber' | 'red' | 'green' | 'blue' | 'none'

type KpiCardProps = {
  label: string
  value: number | string
  meta?: string
  accent?: KpiAccent
}

export function KpiCard({ label, value, meta, accent = 'none' }: KpiCardProps) {
  const accentClass = accent !== 'none' ? `boe-kpi boe-kpi-${accent}` : 'boe-kpi'

  return (
    <div className={accentClass}>
      <span className="boe-kpi-label">{label}</span>
      <span className="boe-kpi-value">{value}</span>
      {meta && <span className="boe-kpi-meta">{meta}</span>}
    </div>
  )
}

// ─── KpiGrid ──────────────────────────────────────────────────────────────────
// 2-col on mobile, 4-col on tablet+ via .boe-kpi-grid CSS class

type KpiGridProps = {
  children: React.ReactNode
}

export function KpiGrid({ children }: KpiGridProps) {
  return (
    <div className="boe-kpi-grid">
      {children}
    </div>
  )
}