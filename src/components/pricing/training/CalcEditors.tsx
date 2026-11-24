'use client'

// Pricing > Training: the editors for an element that is worked out (calc.ts): a wood cut list, a metal frame weighed as
// galaluminium.in and maiak-m.bg do it, an area of the product, or a percentage. The amount is worked out as the person
// types; nothing here saves anything.

import { Plus, Trash2 } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import { PROFILES, SWG, type ProfileKey } from '@/lib/pricing/costing/metal'
import { FACES_LABEL, emptyMetalPart, emptyWoodPart, faceArea, metalParts, weighedGap, type AreaCalc, type Calc, type Faces, type MetalCalc, type MetalPartRow, type PercentCalc, type Size, type WoodCalc, type WoodPart, type Worked } from '@/lib/pricing/training/calc'
import type { Metal, Wood } from '@/lib/pricing/training/api'
import t from './training.module.css'

const kgText = (x: number, d = 2) => x.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
const n = (v: string) => { const x = Number(String(v).replace(/[,\s₹]/g, '')); return v.trim() !== '' && Number.isFinite(x) ? x : null }

type Props = { calc: Calc; onChange: (c: Calc) => void; worked: Worked; size: Size; woodName: string; woods: Wood[]; metals: Metal[]; idPrefix: string }

/** The editor for one worked-out element, with the working and anything that stops it. */
export function CalcEditor(p: Props) {
  return (
    <div className={t.calc}>
      {p.calc.type === 'wood' && <WoodEditor {...p} calc={p.calc} />}
      {p.calc.type === 'metal' && <MetalEditor {...p} calc={p.calc} />}
      {p.calc.type === 'area' && <AreaEditor {...p} calc={p.calc} />}
      {p.calc.type === 'percent' && <PercentEditor {...p} calc={p.calc} />}
      {p.worked.note && !p.worked.problem && <p className={t.calcNote} aria-live="polite">{p.worked.note} = <b>{formatINR(p.worked.amount)}</b></p>}
      {p.worked.problem && <p className={t.calcBad} role="status">{p.worked.problem}</p>}
    </div>
  )
}

function Num({ label, value, onChange, placeholder, id }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; id: string }) {
  return <label className={t.field} htmlFor={id}><span className="boe-input-label">{label}</span><input id={id} className="boe-input" inputMode="decimal" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></label>
}

function WoodEditor({ calc, onChange, woodName, woods, idPrefix }: Props & { calc: WoodCalc }) {
  const set = (patch: Partial<WoodCalc>) => onChange({ ...calc, ...patch })
  const setPart = (i: number, patch: Partial<WoodPart>) => set({ parts: calc.parts.map((x, k) => (k === i ? { ...x, ...patch } : x)) })
  const listed = woods.find(w => w.name.trim().toLowerCase() === woodName.trim().toLowerCase())
  const listedRate = listed?.rate === null || listed?.rate === undefined ? null : Number(listed.rate)
  return <>
    <div className={t.scroll}>
      <table className={t.calcTable}>
        <thead><tr><th>Part</th><th>Pieces</th><th>Length in</th><th>Width in</th><th>Thick in</th><th className={t.num}>cu ft</th><th><span className="boe-sr-only">Remove</span></th></tr></thead>
        <tbody>
          {calc.parts.map((x, i) => {
            const cf = (n(x.qty) ?? 0) * (n(x.length) ?? 0) * (n(x.width) ?? 0) * (n(x.thick) ?? 0) / 1728
            return (
              <tr key={i}>
                <td><input className={`boe-input ${t.calcWide}`} aria-label={`Part ${i + 1}`} value={x.name} placeholder="e.g. Back legs" maxLength={60} onChange={e => setPart(i, { name: e.target.value })} /></td>
                {(['qty', 'length', 'width', 'thick'] as const).map(k => (
                  <td key={k}><input className={`boe-input ${t.calcIn}`} inputMode="decimal" aria-label={`Part ${i + 1} ${k === 'qty' ? 'pieces' : k}`} value={x[k]} onChange={e => setPart(i, { [k]: e.target.value })} /></td>
                ))}
                <td className={t.num}>{kgText(cf, 3)}</td>
                <td><button type="button" className={t.iconBtn} aria-label={`Remove part ${i + 1}`} onClick={() => set({ parts: calc.parts.filter((_, k) => k !== i) })}><Trash2 size={16} aria-hidden /></button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    <button type="button" className="boe-btn boe-btn-text" disabled={calc.parts.length >= 40} onClick={() => set({ parts: [...calc.parts, emptyWoodPart()] })}><Plus size={16} aria-hidden /> Add a part</button>
    <div className={t.calcGrid}>
      <Num id={`${idPrefix}-waste`} label="Waste on conversion %" value={calc.waste_pct} onChange={v => set({ waste_pct: v })} placeholder="e.g. 30" />
      <Num id={`${idPrefix}-rate`} label="Wood rate per cu ft (₹)" value={calc.rate} onChange={v => set({ rate: v })} placeholder={listedRate ? `List: ${formatINR(listedRate)}` : 'Pick the wood above'} />
      <Num id={`${idPrefix}-labour`} label="Labour (₹)" value={calc.labour} onChange={v => set({ labour: v })} />
      <Num id={`${idPrefix}-hardware`} label="Hardware (₹)" value={calc.hardware} onChange={v => set({ hardware: v })} />
    </div>
    {listedRate !== null && n(calc.rate) !== listedRate && <button type="button" className="boe-btn boe-btn-text" onClick={() => set({ rate: String(listedRate) })}>Use {formatINR(listedRate)} per cu ft from the wood list</button>}
  </>
}

const UNIT_SUFFIX = { mm: 'mm', in: 'in' } as const

function MetalEditor({ calc, onChange, metals, idPrefix }: Props & { calc: MetalCalc }) {
  const set = (patch: Partial<MetalCalc>) => onChange({ ...calc, ...patch })
  const setPart = (i: number, patch: Partial<MetalPartRow>) => set({ parts: calc.parts.map((x, k) => (k === i ? { ...x, ...patch } : x)) })
  const weights = metalParts(calc)
  const gap = weighedGap(calc)
  const listed = metals.find(m => m.name.trim().toLowerCase() === calc.metal.trim().toLowerCase())
  const listedRate = listed?.rate === null || listed?.rate === undefined ? null : Number(listed.rate)
  const listId = `${idPrefix}-metals`
  return <>
    <div className={t.calcGrid}>
      <label className={t.field} htmlFor={`${idPrefix}-metal`}><span className="boe-input-label">Metal</span>
        <input id={`${idPrefix}-metal`} className="boe-input" list={listId} value={calc.metal} maxLength={60} placeholder="Pick or type a metal"
          onChange={e => { const m = metals.find(x => x.name.trim().toLowerCase() === e.target.value.trim().toLowerCase()); set({ metal: e.target.value, ...(m ? { density: String(Number(m.density)), ...(m.rate !== null && !calc.rate ? { rate: String(Number(m.rate)) } : {}) } : {}) }) }} />
        <datalist id={listId}>{metals.map(m => <option key={m.name} value={m.name} />)}</datalist>
      </label>
      <Num id={`${idPrefix}-density`} label="Density (kg/m³)" value={calc.density} onChange={v => set({ density: v })} placeholder="Mild steel 7850" />
      <Num id={`${idPrefix}-rate`} label={calc.vendor ? 'Vendor rate per finished kg (₹)' : 'Rate per kg (₹)'} value={calc.rate} onChange={v => set({ rate: v })} placeholder={listedRate ? `List: ${formatINR(listedRate)}` : calc.vendor ? 'e.g. 135' : undefined} />
      {!calc.vendor && <Num id={`${idPrefix}-loss`} label="Cut loss %" value={calc.loss_pct} onChange={v => set({ loss_pct: v })} placeholder="e.g. 5" />}
      {!calc.vendor && <Num id={`${idPrefix}-fab`} label="Fabrication per kg (₹)" value={calc.fab_per_kg} onChange={v => set({ fab_per_kg: v })} />}
      <Num id={`${idPrefix}-coat`} label="Coating per sq ft (₹)" value={calc.coat_per_sqft} onChange={v => set({ coat_per_sqft: v })} />
      <Num id={`${idPrefix}-weighed`} label="Weighed bare frame (kg)" value={calc.weighed_kg} onChange={v => set({ weighed_kg: v })} placeholder="Optional: from the scale" />
    </div>
    <label className={t.field} htmlFor={`${idPrefix}-vendor`}>
      <span><input id={`${idPrefix}-vendor`} type="checkbox" checked={calc.vendor} onChange={e => set({ vendor: e.target.checked })} /> Made by a vendor who buys the steel: one rate per finished kg, no cut loss or fabrication</span>
    </label>
    {gap && <p className={t.calcNote}>Calculator {kgText(gap.calculated)} kg, scale {kgText(gap.weighed)} kg ({gap.pct >= 0 ? '+' : '−'}{kgText(Math.abs(gap.pct), 1)}%). The scale weight is used.</p>}
    {listedRate !== null && n(calc.rate) !== listedRate && <button type="button" className="boe-btn boe-btn-text" onClick={() => set({ rate: String(listedRate) })}>Use {formatINR(listedRate)} per kg from the metal list</button>}
    <div className={t.scroll}>
      <table className={t.calcTable}>
        <thead><tr><th>Part</th><th>Profile</th><th>Sizes</th><th>Wall / thickness</th><th>Length</th><th>Pieces</th><th className={t.num}>kg</th><th><span className="boe-sr-only">Remove</span></th></tr></thead>
        <tbody>
          {calc.parts.map((x, i) => {
            const spec = PROFILES[x.profile]
            const w = weights[i]
            const u = UNIT_SUFFIX[x.unit]
            return (
              <tr key={i}>
                <td><input className={`boe-input ${t.calcWide}`} aria-label={`Part ${i + 1}`} value={x.name} placeholder="e.g. Legs" maxLength={60} onChange={e => setPart(i, { name: e.target.value })} /></td>
                <td>
                  <select className="boe-input" aria-label={`Part ${i + 1} profile`} value={x.profile} onChange={e => setPart(i, { profile: e.target.value as ProfileKey })}>
                    {(Object.keys(PROFILES) as ProfileKey[]).map(k => <option key={k} value={k}>{PROFILES[k].label}</option>)}
                  </select>
                  {spec.tube && <select className="boe-input" aria-label={`Part ${i + 1} tube corners`} value={x.corners} onChange={e => setPart(i, { corners: e.target.value as 'round' | 'sharp' })}>
                    <option value="round">Rounded corners (maiak-m.bg)</option><option value="sharp">Sharp corners (galaluminium.in)</option>
                  </select>}
                </td>
                <td><div className={t.calcSizes}>
                  <input className={`boe-input ${t.calcIn}`} inputMode="decimal" aria-label={`Part ${i + 1} ${spec.sizes[0]} in ${u}`} placeholder={spec.sizes[0]} title={spec.sizes[0]} value={x.a} onChange={e => setPart(i, { a: e.target.value })} />
                  {spec.sizes[1] && <input className={`boe-input ${t.calcIn}`} inputMode="decimal" aria-label={`Part ${i + 1} ${spec.sizes[1]} in ${u}`} placeholder={spec.sizes[1]} title={spec.sizes[1]} value={x.b} onChange={e => setPart(i, { b: e.target.value })} />}
                  <select className="boe-input" aria-label={`Part ${i + 1} size unit`} value={x.unit} onChange={e => setPart(i, { unit: e.target.value as 'mm' | 'in' })}><option value="mm">mm</option><option value="in">in</option></select>
                </div></td>
                <td>{spec.sizes[2] ? <div className={t.calcSizes}>
                  <input className={`boe-input ${t.calcIn}`} inputMode="decimal" aria-label={`Part ${i + 1} ${spec.sizes[2]} in ${u}`} placeholder={spec.sizes[2]} value={x.gauge ? '' : x.t} disabled={!!x.gauge} onChange={e => setPart(i, { t: e.target.value })} />
                  <select className="boe-input" aria-label={`Part ${i + 1} gauge`} value={x.gauge} onChange={e => setPart(i, { gauge: e.target.value })}>
                    <option value="">or gauge</option>{Object.entries(SWG).map(([g, mm]) => <option key={g} value={g}>{g} SWG ({mm} mm)</option>)}
                  </select>
                </div> : <span className={t.muted}>none</span>}</td>
                <td>{spec.byLength ? <div className={t.calcSizes}>
                  <input className={`boe-input ${t.calcIn}`} inputMode="decimal" aria-label={`Part ${i + 1} length`} value={x.length} onChange={e => setPart(i, { length: e.target.value })} />
                  <select className="boe-input" aria-label={`Part ${i + 1} length unit`} value={x.length_unit} onChange={e => setPart(i, { length_unit: e.target.value as MetalPartRow['length_unit'] })}><option value="m">m</option><option value="mm">mm</option><option value="ft">ft</option><option value="in">in</option></select>
                </div> : <span className={t.muted}>per piece</span>}</td>
                <td><input className={`boe-input ${t.calcIn}`} inputMode="decimal" aria-label={`Part ${i + 1} pieces`} value={x.qty} onChange={e => setPart(i, { qty: e.target.value })} /></td>
                <td className={t.num}>{'error' in w ? '–' : <>{kgText(w.kg)}<small className={t.muted}><br />{kgText(w.per, 3)} {w.perUnit}</small></>}</td>
                <td><button type="button" className={t.iconBtn} aria-label={`Remove part ${i + 1}`} onClick={() => set({ parts: calc.parts.filter((_, k) => k !== i) })}><Trash2 size={16} aria-hidden /></button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    <button type="button" className="boe-btn boe-btn-text" disabled={calc.parts.length >= 40} onClick={() => set({ parts: [...calc.parts, emptyMetalPart()] })}><Plus size={16} aria-hidden /> Add a part</button>
  </>
}

function AreaEditor({ calc, onChange, size, idPrefix }: Props & { calc: AreaCalc }) {
  const sqft = faceArea(calc.faces, size)
  return (
    <div className={t.calcGrid}>
      <label className={t.field} htmlFor={`${idPrefix}-faces`}><span className="boe-input-label">Which faces</span>
        <select id={`${idPrefix}-faces`} className="boe-input" value={calc.faces} onChange={e => onChange({ ...calc, faces: e.target.value as Faces })}>
          {(Object.keys(FACES_LABEL) as Faces[]).map(f => <option key={f} value={f}>{FACES_LABEL[f]}</option>)}
        </select>
      </label>
      <Num id={`${idPrefix}-rate`} label="Rate per sq ft (₹)" value={calc.rate} onChange={v => onChange({ ...calc, rate: v })} />
      <div className={t.field}><span className="boe-input-label">From the size of the product</span><span className={t.amount}>{sqft === null ? '–' : `${kgText(sqft, 2)} sq ft`}</span></div>
    </div>
  )
}

function PercentEditor({ calc, onChange, idPrefix }: Props & { calc: PercentCalc }) {
  return (
    <div className={t.calcGrid}>
      <Num id={`${idPrefix}-pct`} label="Percentage" value={calc.pct} onChange={v => onChange({ ...calc, pct: v })} placeholder="e.g. 20" />
      <label className={t.field} htmlFor={`${idPrefix}-of`}><span className="boe-input-label">Of</span>
        <select id={`${idPrefix}-of`} className="boe-input" value={calc.of} onChange={e => onChange({ ...calc, of: e.target.value as PercentCalc['of'] })}>
          <option value="cost">The cost: every row that is not a % (percentages add up)</option>
          <option value="above">Everything above this row (percentages stack)</option>
        </select>
      </label>
    </div>
  )
}
