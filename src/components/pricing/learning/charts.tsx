// Price learning: the three charts, drawn as SVG with one scale each (no chart library). Every label names a value the
// chart actually reaches.

import type { TestedLine } from '@/lib/pricing/learning/blindTest'
import l from './learning.module.css'

/** The average miss the pricing desk aims for. Fixed in piece 1; a setting later. */
export const TARGET_MISS = 8

type Point = { batch_no: number; value: number }

/** Average miss of each batch, with the target line and the batches still to come. */
export function MissChart({ points, slots = 12 }: { points: Point[]; slots?: number }) {
  const N = Math.max(slots, ...points.map(p => p.batch_no))
  const W = 700, H = 262, left = 46, right = 18, top = 22, bottom = 52
  const x = (i: number) => left + ((i - 1) * (W - left - right)) / Math.max(1, N - 1)
  const top30 = Math.max(30, Math.ceil(Math.max(...points.map(p => p.value), 0) / 10) * 10)
  const y = (v: number) => top + (1 - v / top30) * (H - top - bottom)
  const ticks = Array.from({ length: top30 / 10 + 1 }, (_, i) => i * 10)
  const done = new Set(points.map(p => p.batch_no))
  const sorted = [...points].sort((a, b) => a.batch_no - b.batch_no)
  const last = Math.max(0, ...points.map(p => p.batch_no))
  return (
    <svg className={l.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Average miss by batch: ${sorted.map(p => `batch ${p.batch_no} ${p.value} percent`).join(', ')}; target ${TARGET_MISS} percent`}>
      {ticks.map(v => <g key={v}><line x1={left} x2={W - right} y1={y(v)} y2={y(v)} stroke="#ECE7E0" /><text x={left - 8} y={y(v) + 4} textAnchor="end">{v}%</text></g>)}
      <line x1={left} x2={W - right} y1={y(TARGET_MISS)} y2={y(TARGET_MISS)} stroke="#276247" strokeDasharray="5 4" strokeWidth={1.5} />
      <text x={W - right} y={y(TARGET_MISS) - 6} textAnchor="end" style={{ fill: '#276247', fontWeight: 600 }}>Target {TARGET_MISS}%</text>
      {Array.from({ length: N }, (_, k) => k + 1).map(i => <text key={i} x={x(i)} y={H - 28} textAnchor="middle" className={done.has(i) ? l.b : l.mut}>{i}</text>)}
      {last > 0 && <text x={(x(1) + x(last)) / 2} y={H - 10} textAnchor="middle" className={l.mut}>Batches done</text>}
      {last < N && <text x={(x(last + 1) + x(N)) / 2} y={H - 10} textAnchor="middle" className={l.mut}>Batches still to upload</text>}
      <polyline fill="none" stroke="#B9472E" strokeWidth={2.5} strokeLinejoin="round" points={sorted.map(p => `${x(p.batch_no)},${y(p.value)}`).join(' ')} />
      {sorted.map(p => <g key={p.batch_no}><circle cx={x(p.batch_no)} cy={y(p.value)} r={5} fill="#B9472E" stroke="#fff" strokeWidth={2} /><text x={x(p.batch_no)} y={y(p.value) - 12} textAnchor="middle" className={l.b}>{p.value}%</text></g>)}
    </svg>
  )
}

/** Share of lines within ±10% of the PI price, batch by batch. */
export function HitChart({ points }: { points: Point[] }) {
  const sorted = [...points].sort((a, b) => a.batch_no - b.batch_no).slice(-8)
  const W = 360, H = 215, left = 40, right = 12, top = 22, bottom = 52
  const y = (v: number) => top + (1 - v / 100) * (H - top - bottom)
  const bw = Math.min(44, (W - left - right) / Math.max(1, sorted.length) - 8), gap = (W - left - right - bw * sorted.length) / Math.max(1, sorted.length)
  return (
    <svg className={l.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Share of lines within 10 percent: ${sorted.map(p => `batch ${p.batch_no} ${p.value} percent`).join(', ')}`}>
      {[0, 50, 100].map(v => <g key={v}><line x1={left} x2={W - right} y1={y(v)} y2={y(v)} stroke="#ECE7E0" /><text x={left - 8} y={y(v) + 4} textAnchor="end">{v}%</text></g>)}
      {sorted.map((p, i) => {
        const bx = left + gap / 2 + i * (bw + gap)
        return <g key={p.batch_no}><rect x={bx} y={y(p.value)} width={bw} height={y(0) - y(p.value)} rx={5} fill={i === sorted.length - 1 ? '#B9472E' : '#E8C4B8'} /><text x={bx + bw / 2} y={y(p.value) - 7} textAnchor="middle" className={l.b}>{p.value}%</text><text x={bx + bw / 2} y={H - 28} textAnchor="middle" className={l.b}>{p.batch_no}</text></g>
      })}
      <text x={(left + W - right) / 2} y={H - 10} textAnchor="middle" className={l.mut}>Batch</text>
    </svg>
  )
}

const LETTERS = 'ABCDEF'

/** What the model said against the PI price, one dot per line, on log scales, with the ±10% band and the worst misses lettered. */
export function Scatter({ lines, worst }: { lines: TestedLine[]; worst: TestedLine[] }) {
  const priced = lines.filter(t => t.model !== null)
  const W = 560, H = 400, left = 58, right = 16, top = 14, bottom = 48
  const prices = priced.flatMap(t => [t.price, t.model!.price]).filter(v => v > 0)
  const lo = Math.max(100, Math.pow(10, Math.floor(Math.log10(Math.min(...prices, 2000) * 0.9) * 2) / 2))
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...prices, 5000) * 1.1) * 2) / 2)
  const span = Math.log(hi) - Math.log(lo)
  const sx = (v: number) => left + ((Math.log(v) - Math.log(lo)) / span) * (W - left - right)
  const sy = (v: number) => top + (1 - (Math.log(v) - Math.log(lo)) / span) * (H - top - bottom)
  const clamp = (v: number) => Math.min(hi, Math.max(lo, v))
  const ticks = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000].filter(v => v >= lo && v <= hi)
  const fmt = (v: number) => (v >= 1000 ? `₹${v / 1000}k` : `₹${v}`)
  const sample = priced.length > 400 ? priced.filter((_, i) => i % Math.ceil(priced.length / 400) === 0) : priced
  const dotColor = (m: number) => { const o = Math.abs(m); return o <= 10 ? '#276247' : o <= 25 ? '#C28A1C' : '#B9472E' }
  return (
    <svg className={l.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="What the model said against the price in the PI, one dot per line; dots inside the band are within 10 percent">
      <defs><clipPath id="learningScatterClip"><rect x={left} y={top} width={W - left - right} height={H - top - bottom} /></clipPath></defs>
      {ticks.map(v => <g key={v}><line x1={left} x2={W - right} y1={sy(v)} y2={sy(v)} stroke="#F1EEE9" /><line y1={top} y2={H - bottom} x1={sx(v)} x2={sx(v)} stroke="#F1EEE9" /><text x={left - 8} y={sy(v) + 4} textAnchor="end">{fmt(v)}</text><text x={sx(v)} y={H - bottom + 18} textAnchor="middle">{fmt(v)}</text></g>)}
      <g clipPath="url(#learningScatterClip)">
        <path d={`M ${sx(lo)} ${sy(clamp(lo * 1.1))} L ${sx(hi)} ${sy(clamp(hi * 1.1))} L ${sx(hi)} ${sy(clamp(hi * 0.9))} L ${sx(lo)} ${sy(clamp(lo * 0.9))} Z`} fill="#BCD8C8" opacity={0.55} />
        <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="#276247" strokeWidth={1.2} />
        {sample.map((t, i) => <circle key={i} cx={sx(t.price)} cy={sy(clamp(t.model!.price))} r={3.2} fill={dotColor(t.missPct!)} opacity={0.78} />)}
        {worst.slice(0, 4).map((t, i) => <g key={i}><circle cx={sx(t.price)} cy={sy(clamp(t.model!.price))} r={9} fill="#303536" /><text x={sx(t.price)} y={sy(clamp(t.model!.price)) + 4} textAnchor="middle" style={{ fill: '#fff', fontWeight: 700 }}>{LETTERS[i]}</text></g>)}
      </g>
      <text x={(left + W - right) / 2} y={H - 6} textAnchor="middle" className={l.mut}>Price in the PI (per piece)</text>
      <text transform={`translate(14 ${(top + H - bottom) / 2}) rotate(-90)`} textAnchor="middle" className={l.mut}>What the model said</text>
    </svg>
  )
}
export { LETTERS }
