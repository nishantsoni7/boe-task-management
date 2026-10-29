'use client'

// THE FABRIC & FINISH COST PAGE'S CONTENT (owner, 2026-10-29): what the PI
// workbook's two per-product sheets say, as tiles, a reconciliation with the
// PI's own figures, and one table. A FUNCTION OF ITS PROPS: nothing here
// fetches, writes, authorizes or decides; the page reads, the route parses.

import { formatInr } from '@/lib/pi/previewView'
import {
  FABRIC_COST_SHEET_NAME,
  FABRIC_FINISH_SHEET_NAME,
  lineDrift,
  reconcileWithPi,
  type FabricFinishLine,
  type FabricFinishSheets,
  type Reconciliation,
} from '@/lib/pi/fabricFinishSheets'

export const FF_PER_PRODUCT_TITLE = 'Per product'
export const FF_EMPTY = 'The workbook’s fabric and finish sheets name no products.'
export const FF_NO_COST_SHEET = `This workbook has no “${FABRIC_COST_SHEET_NAME}” sheet, so there are no fabric or packing figures to show.`
export const FF_NO_FINISH_SHEET = `This workbook has no “${FABRIC_FINISH_SHEET_NAME}” sheet, so there are no approvals to show.`
export const FF_SOURCE_NOTE =
  'Fabric per piece, the price per metre, packing per piece and the packing type are typed in the workbook; the totals are its own formulas. '
  + 'The approval columns are the “Fabric and Finish” sheet as uploaded — what the ERP side recorded that day, not what BOE One records under Fabric & Finish on the Order. '
  + 'Editing the PI in the app does not change these sheets; upload a corrected workbook to change them.'

/** The PI's own fabric and packing figures, and its lines' quantities by Master row. */
export type FabricFinishPiFacts = {
  fabricCost: number | null
  fabricCostText: string | null
  packingCost: number | null
  packingCostText: string | null
  piQuantityByRow: ReadonlyMap<number, number | null>
}

/** Metres, with up to two decimals and no trailing zeros: "502 m", "0.7 m". */
export function formatMetres(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 100) / 100
  return `${rounded.toLocaleString('en-IN', { maximumFractionDigits: 2 })} m`
}

/** A sheet figure as a short count: "6 of 8 lines". */
const ofLines = (n: number, total: number) => `${n} of ${total} line${total === 1 ? '' : 's'}`

function reconciliationLine(what: string, r: Reconciliation): { tone: 'green' | 'amber' | 'grey'; text: string } {
  switch (r.kind) {
    case 'match': return { tone: 'green', text: `${what} matches the PI’s Commercial breakdown.` }
    case 'differs': return { tone: 'amber', text: `${what} differs from the PI: the sheet adds up to ${formatInr(r.sheet)}, the PI states ${formatInr(r.pi)}.` }
    case 'pi_worded': return { tone: 'grey', text: `${what}: the PI states it as “${r.piText}”.` }
    case 'unknown': return { tone: 'grey', text: `${what}: the PI does not state a figure.` }
  }
}

/** PENDING and NA are the two words the sheet uses most; anything else is a person's own words. */
function ApprovalCell({ value }: { value: string | null }) {
  if (value === null) return <span className="pi-ff-pill pi-ff-pill--grey">—</span>
  const w = value.trim().toLowerCase()
  if (w === 'pending') return <span className="pi-ff-pill pi-ff-pill--amber">Pending</span>
  if (w === 'na' || w === 'n/a' || w === 'not applicable') return <span className="pi-ff-pill pi-ff-pill--grey">NA</span>
  if (/\bapproved\b|\bdone\b|\bok\b/.test(w)) return <span className="pi-ff-pill pi-ff-pill--green">{value}</span>
  return <span className="pi-ff-text">{value}</span>
}

function DriftNote({ line, pi }: { line: FabricFinishLine; pi: FabricFinishPiFacts }) {
  const drift = lineDrift(line, pi.piQuantityByRow)
  if (drift.kind === 'same') return null
  return (
    <span className="pi-ff-warn" role="note">
      {drift.kind === 'not_on_pi' ? 'Not on the PI now' : `PI line now ${drift.piQuantity} pcs`}
    </span>
  )
}

const money = (n: number | null) => (n === null ? '—' : formatInr(n))
const num = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const zeroClass = (n: number | null | undefined) => ((n ?? 0) > 0 ? '' : ' pi-ff-zero')

export function FabricFinishView({ sheets, pi }: { sheets: FabricFinishSheets; pi: FabricFinishPiFacts }) {
  const { lines, totals, costSheet, finishSheet } = sheets
  const approvalCols = finishSheet.approvalColumns
  const pendingLines = lines.filter(l => l.approvals.some(a => (a.value ?? '').trim().toLowerCase() === 'pending')).length
  const fabric = reconciliationLine('Fabric amount', reconcileWithPi(totals.fabricAmount, pi.fabricCost, pi.fabricCostText))
  const packing = reconciliationLine('Packing cost', reconcileWithPi(totals.packingTotal, pi.packingCost, pi.packingCostText))
  const showCost = costSheet.present
  const showFinish = finishSheet.present && approvalCols.length > 0

  return (
    <>
      <section className="pi-ff-card" aria-label="Totals">
        <div className="pi-ff-tiles">
          <div className="pi-ff-tile">
            <div className="pi-ff-tile-label">Total fabric</div>
            <div className="pi-ff-tile-value">{showCost ? formatMetres(totals.totalFabricMetres) : '—'}</div>
            <div className="pi-ff-tile-sub">{showCost ? `${ofLines(totals.linesWithFabric, lines.length)} use fabric` : 'no cost sheet'}</div>
          </div>
          <div className="pi-ff-tile">
            <div className="pi-ff-tile-label">Fabric amount</div>
            <div className="pi-ff-tile-value">{showCost ? money(totals.fabricAmount) : '—'}</div>
            <div className="pi-ff-tile-sub">{showCost ? 'metres × price per metre' : 'no cost sheet'}</div>
          </div>
          <div className="pi-ff-tile">
            <div className="pi-ff-tile-label">Packing cost</div>
            <div className="pi-ff-tile-value">{showCost ? money(totals.packingTotal) : '—'}</div>
            <div className="pi-ff-tile-sub">{showCost ? ofLines(totals.linesWithPacking, lines.length) : 'no cost sheet'}</div>
          </div>
          <div className="pi-ff-tile">
            <div className="pi-ff-tile-label">Approvals pending</div>
            <div className="pi-ff-tile-value">{showFinish ? ofLines(pendingLines, lines.length) : '—'}</div>
            <div className="pi-ff-tile-sub">{showFinish ? approvalCols.join(' · ') : 'no finish sheet'}</div>
          </div>
        </div>
        {showCost && (
          <ul className="pi-ff-recon">
            {[fabric, packing].map(r => (
              <li key={r.text} className={`pi-ff-recon-line pi-ff-recon-line--${r.tone}`}>
                <span className="pi-ff-dot" aria-hidden="true" />
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        )}
        {!showCost && <p className="pi-ff-note">{FF_NO_COST_SHEET}</p>}
        {!showFinish && <p className="pi-ff-note">{FF_NO_FINISH_SHEET}</p>}
      </section>

      <section className="pi-ff-card" aria-label={FF_PER_PRODUCT_TITLE}>
        <div className="pi-ff-card-head">
          <h2 className="pi-ff-card-title">{FF_PER_PRODUCT_TITLE}</h2>
          <span className="pi-ff-card-note">Quantities are the workbook’s; a line edited in the app since upload is flagged</span>
        </div>
        {lines.length === 0 ? (
          <p className="pi-ff-empty">{FF_EMPTY}</p>
        ) : (
          <div className="pi-ff-table-wrap">
            <table className="pi-ff-table">
              <thead>
                <tr className="pi-ff-group-row">
                  <th colSpan={2} />
                  {showCost && <th colSpan={4} className="pi-ff-group">Fabric</th>}
                  {showCost && <th colSpan={3} className="pi-ff-group">Packing</th>}
                  {showFinish && <th colSpan={approvalCols.length} className="pi-ff-group">Approvals (Fabric and Finish sheet)</th>}
                </tr>
                <tr>
                  <th>Code</th>
                  <th>Product</th>
                  {showCost && (
                    <>
                      <th className="pi-ff-group pi-ff-r">Per pc (m)</th>
                      <th className="pi-ff-r">Total (m)</th>
                      <th className="pi-ff-r">₹ / m</th>
                      <th className="pi-ff-r">Amount</th>
                      <th className="pi-ff-group pi-ff-r">₹ / pc</th>
                      <th className="pi-ff-r">Total</th>
                      <th>Type</th>
                    </>
                  )}
                  {showFinish && approvalCols.map((c, i) => <th key={c} className={i === 0 ? 'pi-ff-group' : undefined}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {lines.map(line => (
                  <tr key={line.sheetRow}>
                    <td className="pi-ff-code">{line.code ?? '—'}</td>
                    <td>
                      <div className="pi-ff-name">
                        {line.name ?? '—'}{line.quantity !== null ? ` · ${num(line.quantity)} pc${line.quantity === 1 ? '' : 's'}` : ''}
                      </div>
                      {line.material && <div className="pi-ff-material">{line.material}</div>}
                      <DriftNote line={line} pi={pi} />
                    </td>
                    {showCost && (
                      <>
                        <td className={`pi-ff-group pi-ff-r pi-ff-num${zeroClass(line.fabric?.perPiece)}`}>{num(line.fabric?.perPiece ?? null)}</td>
                        <td className={`pi-ff-r pi-ff-num${zeroClass(line.fabric?.total)}`}>{num(line.fabric?.total ?? null)}</td>
                        <td className={`pi-ff-r pi-ff-num${zeroClass(line.fabric?.pricePerMetre)}`}>{num(line.fabric?.pricePerMetre ?? null)}</td>
                        <td className={`pi-ff-r pi-ff-num${zeroClass(line.fabric?.amount)}`}>{money(line.fabric?.amount ?? null)}</td>
                        <td className={`pi-ff-group pi-ff-r pi-ff-num${zeroClass(line.packing?.perPiece)}`}>{num(line.packing?.perPiece ?? null)}</td>
                        <td className={`pi-ff-r pi-ff-num${zeroClass(line.packing?.total)}`}>{money(line.packing?.total ?? null)}</td>
                        <td className="pi-ff-type">{line.packing?.type ?? '—'}</td>
                      </>
                    )}
                    {showFinish && approvalCols.map((c, i) => {
                      const a = line.approvals.find(x => x.column === c)
                      return <td key={c} className={i === 0 ? 'pi-ff-group' : undefined}><ApprovalCell value={a?.value ?? null} /></td>
                    })}
                  </tr>
                ))}
              </tbody>
              {showCost && (
                <tfoot>
                  <tr>
                    <td />
                    <td>Total · {lines.length} line{lines.length === 1 ? '' : 's'}</td>
                    <td className="pi-ff-group" />
                    <td className="pi-ff-r pi-ff-num">{formatMetres(totals.totalFabricMetres)}</td>
                    <td />
                    <td className="pi-ff-r pi-ff-num">{money(totals.fabricAmount)}</td>
                    <td className="pi-ff-group" />
                    <td className="pi-ff-r pi-ff-num">{money(totals.packingTotal)}</td>
                    <td />
                    {showFinish && <td className="pi-ff-group" colSpan={approvalCols.length} />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        <p className="pi-ff-source"><b>Where these come from.</b> {FF_SOURCE_NOTE}</p>
      </section>
    </>
  )
}
