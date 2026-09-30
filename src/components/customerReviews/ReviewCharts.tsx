'use client'

import { colors } from '@/lib/tokens'
import { axisMax, barSegments } from '@/lib/customerReviews/reviewReport'

// A small stacked-bar chart, drawn as inline SVG like BOE's other charts (there is
// no charting library in the project, and none was added).
//
// TEXT AND IMAGE ARE TWO SEGMENTS OF ONE BAR: the two types are mutually
// exclusive, so the bar's height IS the submitted total.
//
// ACCESSIBLE WITHOUT SEEING IT. The figure has a role, a title and a description
// that states the totals, and the same numbers are one click away as a plain table.
// Colour is never the only carrier: the legend names both types and the table
// gives every value.
//
// RESPONSIVE. The drawing is a viewBox scaled to its container, so it never widens
// the page; on a phone the labels are thinned rather than shrunk.

export const TYPE_FILL = { text: '#94A3B8', image: '#0891B2' } as const

export type BarDatum = { key: string; label: string; text: number; image: number }

export function StackedBarChart({
  bars, title, description, tickEvery, unitLabel = 'reviews',
}: {
  bars: BarDatum[]
  title: string
  description: string
  /** Show every Nth x label (the daily chart shows a few of 31). */
  tickEvery: number
  unitLabel?: string
}) {
  const W = Math.max(bars.length * 22, 320)
  const H = 150
  const PAD_T = 8
  const PAD_B = 22
  const PAD_L = 26
  const plotH = H - PAD_T - PAD_B
  const highest = Math.max(0, ...bars.map(b => b.text + b.image))
  const max = axisMax(highest)
  const slot = (W - PAD_L) / Math.max(bars.length, 1)
  const barW = Math.max(4, Math.min(20, slot * 0.68))
  const total = bars.reduce((t, b) => t + b.text + b.image, 0)
  const ticks = [0, Math.round(max / 2), max]

  return (
    <figure style={{ margin: 0, minWidth: 0 }}>
      <svg
        role="img"
        aria-labelledby={`${title.replace(/\s+/g, '-')}-t ${title.replace(/\s+/g, '-')}-d`}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
      >
        <title id={`${title.replace(/\s+/g, '-')}-t`}>{title}</title>
        <desc id={`${title.replace(/\s+/g, '-')}-d`}>{description}</desc>

        {ticks.map(t => {
          const y = PAD_T + plotH - (t / max) * plotH
          return (
            <g key={t}>
              <line x1={PAD_L} x2={W} y1={y} y2={y} stroke={colors.borderSoft} strokeWidth={1} />
              <text x={PAD_L - 5} y={y + 3} textAnchor="end" fontSize={9} fill={colors.muted}>{t}</text>
            </g>
          )
        })}

        {bars.map((b, i) => {
          const { textH, imageH } = barSegments(b.text, b.image, max, plotH)
          const x = PAD_L + i * slot + (slot - barW) / 2
          const baseY = PAD_T + plotH
          return (
            <g key={b.key}>
              <title>{`${b.label}: ${b.text + b.image} ${unitLabel} (${b.text} text, ${b.image} image)`}</title>
              {b.text > 0 && <rect x={x} y={baseY - textH} width={barW} height={textH} fill={TYPE_FILL.text} rx={1} />}
              {b.image > 0 && <rect x={x} y={baseY - textH - imageH} width={barW} height={imageH} fill={TYPE_FILL.image} rx={1} />}
              {i % tickEvery === 0 && (
                <text x={x + barW / 2} y={H - 7} textAnchor="middle" fontSize={9} fill={colors.muted}>{b.label}</text>
              )}
            </g>
          )
        })}
      </svg>

      <figcaption style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', marginTop: '6px', fontSize: '11.5px', color: colors.secondary }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: TYPE_FILL.text }} /> Text
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: TYPE_FILL.image }} /> Image
        </span>
        <span style={{ color: colors.muted }}>{total} {unitLabel} in view</span>
      </figcaption>

      <details style={{ marginTop: '6px', fontSize: '12px' }}>
        <summary style={{ cursor: 'pointer', color: colors.secondary }}>Show as a table</summary>
        <div style={{ overflowX: 'auto', marginTop: '6px' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '12px', minWidth: '260px' }}>
            <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{title}</caption>
            <thead>
              <tr>
                <th scope="col" style={cell(true)}>Period</th>
                <th scope="col" style={cell(false)}>Text</th>
                <th scope="col" style={cell(false)}>Image</th>
                <th scope="col" style={cell(false)}>Total</th>
              </tr>
            </thead>
            <tbody>
              {bars.map(b => (
                <tr key={b.key}>
                  <th scope="row" style={cell(true)}>{b.label}</th>
                  <td style={cell(false)}>{b.text}</td>
                  <td style={cell(false)}>{b.image}</td>
                  <td style={cell(false)}>{b.text + b.image}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

function cell(left: boolean): React.CSSProperties {
  return {
    padding: '3px 10px', textAlign: left ? 'left' : 'right', fontWeight: left ? 600 : 400,
    borderBottom: `1px solid ${colors.borderSoft}`, color: colors.primary, fontVariantNumeric: 'tabular-nums',
  }
}
