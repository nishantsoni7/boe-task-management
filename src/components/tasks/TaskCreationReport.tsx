'use client'

import type { CreationReport } from '@/lib/tasks/taskReporting'

// Dashboard: self vs delegated tasks created, last 7 and 30 days. A plain table
// in the Dashboard's card language — no chart. "—" until the counts arrive; the
// Dashboard never waits for them.

const cellBase: React.CSSProperties = {
  padding: '9px 14px',
  borderTop: '1px solid #F0F1F4',
  fontSize: '13px',
}

export function TaskCreationReportCard({
  report, isMobile,
}: {
  report: CreationReport | undefined
  isMobile: boolean
}) {
  const rows = [
    { label: 'Self tasks created',      last7: report?.self7,      last30: report?.self30 },
    { label: 'Delegated tasks created', last7: report?.delegated7, last30: report?.delegated30 },
  ]
  const shown = (n: number | undefined) => (n === undefined ? '—' : String(n))
  const numeric: React.CSSProperties = {
    ...cellBase, textAlign: 'right', fontWeight: 700, color: '#111318',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    width: isMobile ? '84px' : '120px',
  }
  const header: React.CSSProperties = {
    padding: '10px 14px', fontSize: '11.5px', fontWeight: 600, color: '#6B7280',
    textAlign: 'right', whiteSpace: 'nowrap',
  }

  return (
    <div style={{
      background: '#fff', border: '1px solid #E7E9EE', borderRadius: '12px',
      overflowX: 'auto',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-busy={report ? undefined : true}>
        <thead>
          <tr>
            <th scope="col" style={{ ...header, textAlign: 'left' }}>Tasks</th>
            <th scope="col" style={header}>Last 7 days</th>
            <th scope="col" style={header}>Last 30 days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label}>
              <th scope="row" style={{ ...cellBase, textAlign: 'left', fontWeight: 500, color: '#3D4455' }}>
                {row.label}
              </th>
              <td style={numeric}>{shown(row.last7)}</td>
              <td style={numeric}>{shown(row.last30)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
