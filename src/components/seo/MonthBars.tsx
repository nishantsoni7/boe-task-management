import { formatCount } from '@/lib/seo/report'
import s from './seo.module.css'

// One month's value per bar, as inline SVG like BOE's other charts (the project has no charting library). The
// drawing is a viewBox scaled to its container, so it never widens the page. The figures are also stated in text
// for screen readers, and a hover on a bar shows its value.

const WIDTH = 480
const HEIGHT = 180
const LEFT = 8
const BASE = 150
const TOP = 22

export function MonthBars({ title, bars }: { title: string; bars: { label: string; value: number | null }[] }) {
  const known = bars.map(b => b.value ?? 0)
  const max = Math.max(...known, 1)
  const peak = known.indexOf(max)
  const step = (WIDTH - LEFT * 2) / Math.max(bars.length, 1)
  const width = Math.max(step - 6, 4)
  const summary = bars.map(b => `${b.label} ${b.value === null ? 'no figure' : formatCount(b.value)}`).join(', ')

  return (
    <figure className={s.chart}>
      <figcaption className={s.chartTitle}>{title}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title}. ${summary}`}>
        <line x1={LEFT} x2={WIDTH - LEFT} y1={BASE} y2={BASE} stroke="#E4DED7" />
        {bars.map((bar, index) => {
          const x = LEFT + index * step + (step - width) / 2
          const height = ((bar.value ?? 0) / max) * (BASE - TOP)
          const middle = x + width / 2
          const named = index === peak || index === bars.length - 1
          return (
            <g key={`${bar.label}-${index}`}>
              <rect x={x} y={BASE - height} width={width} height={height} rx={3} fill="#335A86">
                <title>{`${bar.label}: ${bar.value === null ? 'no figure' : formatCount(bar.value)}`}</title>
              </rect>
              <text x={middle} y={BASE + 18} textAnchor="middle" fontSize={12} fill="#686D6C">{bar.label}</text>
              {named && bar.value !== null && (
                <text x={middle} y={BASE - height - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="#303536">
                  {formatCount(bar.value)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
