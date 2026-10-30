'use client'

// ── The product list's three tabs (owner, 2026-10-30) ────────────────────────
//
// Product details | F&P Cost | Approvals, on the PI Draft and the Confirmed
// Order. Code, Image, Product and Qty stay where they are and the columns to
// their right slide in, so a product keeps its place whichever tab is open. It
// replaces the panel that slid over the page and needed scrolling sideways.
//
// Product details stays each page's own table. These are the other two, drawn
// from one read (useProductCosts) and fabricFinishCost.ts's rules; nothing here
// does arithmetic. Typing lives in FabricFinishLineEditor, one product at a time.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatInr } from '@/lib/pi/previewView'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import {
  AS_APPLICABLE_TEXT,
  FINISH_FAMILY_LABELS,
  NO_FINISH_TEXT,
  TYPED_SOURCE_LABEL,
  effective,
  effectiveFinish,
  finishFamilies,
  finishHeadings,
  finishIsDone,
  lineApproval,
  lineFigures,
  type Comparison,
  type FabricFinishData,
  type FabricFinishLine,
  type FamilyCell,
} from '@/lib/orders/fabricFinishCost'
import {
  APPROVALS_LABEL,
  NO_FABRIC_TEXT,
  approvalsText,
  comparisonText,
  costLineFor,
  productCostSummary,
} from '@/lib/orders/productCostColumns'
import { FabricFinishLineEditor } from './FabricFinishLineEditor'

export type ProductView = 'details' | 'cost' | 'approvals'

export const PRODUCT_VIEWS: readonly { key: ProductView; label: string }[] = [
  { key: 'details', label: 'Product details' },
  { key: 'cost', label: 'F&P Cost' },
  { key: 'approvals', label: 'Approvals' },
]

const PICTURE_URL_TTL_SECONDS = 3600

/** What stays put across the tabs, as the page draws it. */
export type ProductViewRow = {
  id: string
  itemSequence: string | null
  /** The product's name, for labels read aloud. */
  label: string
  code: ReactNode
  image: (compact: boolean) => ReactNode
  product: ReactNode
  quantity: ReactNode
}

// ── The switch and what sits beside it ────────────────────────────────────────

export function ProductViewTabs({ view, onChange, pending }: {
  view: ProductView
  onChange: (view: ProductView) => void
  /** Products with an approval still open, once known. */
  pending: number | null
}) {
  return (
    <span className="pv-tabs" role="group" aria-label="What the product list shows">
      {PRODUCT_VIEWS.map(v => (
        <button
          key={v.key}
          type="button"
          className={`pv-tab${v.key === view ? ' is-on' : ''}`}
          aria-pressed={v.key === view}
          onClick={() => onChange(v.key)}
        >
          {v.label}
          {v.key === 'approvals' && pending !== null && pending > 0 && (
            <span className="pv-count">{pending}<span className="pv-count-word"> pending</span></span>
          )}
        </button>
      ))}
    </span>
  )
}

const metresText = (metres: number): string =>
  `${metres.toLocaleString('en-IN', { maximumFractionDigits: 2 })} m`

/** "Fabric matches the PI", under the totals; amber when it does not. */
function MatchChip({ label, comparison }: { label: string; comparison: Comparison }) {
  const text = comparisonText(comparison, formatInr)
  if (!text) return null
  return (
    <span className={comparison.state === 'matches' ? 'pv-chip-ok' : 'pv-pill'}>
      {label} {text.charAt(0).toLowerCase()}{text.slice(1)}
    </span>
  )
}

/**
 * Update from workbook: the file goes straight to private storage, and the
 * server reads it there. Only the two side sheets change; the PI does not.
 */
export function WorkbookRefresh({ submissionId, onDone }: { submissionId: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)

  const call = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/orders/fabric-finish/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    if (!res.ok || !json) throw new Error(typeof json?.message === 'string' ? json.message : 'The workbook could not be read. Please try again.')
    return json
  }

  const read = async (file: File) => {
    setBusy(true); setNote(null)
    try {
      const prepared = await call({ submissionId })
      const { error } = await createClient().storage.from(ORDER_FILES_BUCKET)
        .uploadToSignedUrl(String(prepared.path), String(prepared.token), file, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      if (error) throw new Error('The workbook could not be uploaded. Please try again.')
      const result = await call({ submissionId, path: prepared.path })
      const pictures = Number(result.pictures)
      setNote({ text: `Read ${String(result.products)} of ${String(result.total)} products and ${pictures} picture${pictures === 1 ? '' : 's'}.`, bad: false })
      onDone()
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'The workbook could not be read. Please try again.', bad: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="pv-refresh">
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f) }}
      />
      <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Reading…' : 'Update from workbook'}
      </button>
      {note && <span className={note.bad ? 'pv-problem' : 'pv-refresh-note'} role="status">{note.text}</span>}
    </span>
  )
}

// ── Pictures ──────────────────────────────────────────────────────────────────

/** Signed per object, under the reader's own access: one they may not open simply has none. */
function usePictureUrls(data: FabricFinishData | null | undefined): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!data) return
    const paths = [...new Set(data.lines.flatMap(l => effectiveFinish(l).flatMap(f => (f.entry.imagePath ? [f.entry.imagePath] : []))))]
    if (paths.length === 0) return
    let live = true
    void (async () => {
      const signed = await createClient().storage.from(ORDER_FILES_BUCKET).createSignedUrls(paths, PICTURE_URL_TTL_SECONDS)
      if (!live || signed.error) return
      const byPath: Record<string, string> = {}
      for (const s of signed.data ?? []) if (s.path && s.signedUrl) byPath[s.path] = s.signedUrl
      setUrls(u => ({ ...u, ...byPath }))
    })()
    return () => { live = false }
  }, [data])
  return urls
}

// ── One product's figures ─────────────────────────────────────────────────────

const money = (n: number | null) => (n === null ? '—' : formatInr(n))

function costCells(line: FabricFinishLine | null) {
  if (!line) return null
  const f = lineFigures(line)
  const hasFabric = f.metres !== null && f.metres > 0
  const packingType = effective(line, 'packingType')
  const typed = (['fabricMetresPerPiece', 'fabricPricePerMetre', 'packingCostPerPiece', 'packingType'] as const)
    .some(key => effective(line, key).source === 'typed')
  return {
    metresPerPiece: hasFabric ? effective(line, 'fabricMetresPerPiece').value : null,
    metres: hasFabric ? metresText(f.metres as number) : '—',
    rate: hasFabric ? money(effective(line, 'fabricPricePerMetre').value) : '—',
    fabric: !hasFabric ? NO_FABRIC_TEXT : f.fabricAmount === null ? 'Rate not given' : formatInr(f.fabricAmount),
    hasFabricFigure: hasFabric && f.fabricAmount !== null,
    packingPerPiece: money(effective(line, 'packingCostPerPiece').value),
    packing: f.packingAmount === null ? 'Not given' : formatInr(f.packingAmount),
    hasPackingFigure: f.packingAmount !== null,
    type: packingType.value ?? '—',
    typed,
    typedBy: line.typedByName,
  }
}

const TypedChip = ({ by }: { by: string | null }) => (
  <span className="pv-typed" title={by ? `Typed by ${by}` : undefined}>{TYPED_SOURCE_LABEL}</span>
)

const isNa = (value: string) => /^n\/?a$/i.test(value.trim())

function ApprovalCell({ cell, urls }: { cell: FamilyCell; urls: Readonly<Record<string, string>> }) {
  if (cell.entries.length === 0) return <span className="pv-pill">Pending</span>
  const several = cell.entries.length > 1
  return (
    <span className="pv-approvals">
      {cell.entries.map(({ entry, source }) => {
        const url = entry.imagePath ? urls[entry.imagePath] : undefined
        const value = entry.value.trim()
        return (
          <span key={entry.heading} className="pv-approval">
            {several && <span className="pv-approval-heading">{entry.heading}</span>}
            <span className="pv-approval-body">
              {url && (
                // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
                <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`${entry.heading} reference`} className="pv-swatch" /></a>
              )}
              {!finishIsDone(value) && !entry.imagePath
                ? <span className="pv-pill">Pending</span>
                : isNa(value) ? <span className="pv-muted">NA</span>
                : <span className="pv-approval-text">{value || 'See picture'}</span>}
              {source === 'typed' && <TypedChip by={null} />}
            </span>
          </span>
        )
      })}
    </span>
  )
}

// ── The two tabs ──────────────────────────────────────────────────────────────

const COST_COLUMNS: readonly { label: string; left?: true }[] = [
  { label: 'Fabric m / pc' }, { label: 'Total m' }, { label: '₹ / m' }, { label: 'Fabric ₹' },
  { label: 'Packing ₹ / pc' }, { label: 'Packing ₹' }, { label: 'Type', left: true },
]

export function ProductViewBody({ view, rows, data, isMobile, variant, submissionId, pieces, animate, onChanged }: {
  view: Exclude<ProductView, 'details'>
  rows: readonly ProductViewRow[]
  data: FabricFinishData | null | undefined
  isMobile: boolean
  /** Whose frozen columns these must line up with. */
  variant: 'pi' | 'order'
  submissionId: string
  /** Pieces across the lines, for the totals row. */
  pieces: number
  animate: boolean
  onChanged: () => void
}) {
  // One product at a time, in one tab: switching tabs closes the editor.
  const [editing, setEditing] = useState<string | null>(null)
  const editKey = (row: ProductViewRow) => `${view}:${row.id}`
  const urls = usePictureUrls(view === 'approvals' ? data : null)

  if (data === undefined) return <p className="pv-note" role="status">Reading the cost sheet…</p>
  if (data === null) return <p className="pv-note" role="status">The cost sheet could not be read.</p>

  const summary = productCostSummary(data)
  const families = finishFamilies(data.lines)
  const headings = finishHeadings(data.lines)
  const canEdit = data.canEdit
  const lineOf = (row: ProductViewRow) => costLineFor(data, row)
  const saved = () => { setEditing(null); onChanged() }

  const editor = (line: FabricFinishLine) => (
    <FabricFinishLineEditor
      key={line.itemSequence}
      submissionId={submissionId}
      line={line}
      part={view}
      headings={headings}
      pictureUrls={urls}
      onSaved={saved}
      onCancel={() => setEditing(null)}
    />
  )
  const editButton = (row: ProductViewRow, line: FabricFinishLine | null) => (canEdit && line ? (
    <button
      type="button"
      className="boe-btn boe-btn-ghost pv-edit"
      aria-expanded={editing === editKey(row)}
      aria-label={`Edit ${row.label}`}
      onClick={() => setEditing(editing === editKey(row) ? null : editKey(row))}
    >
      Edit
    </button>
  ) : null)

  const fabricTotal = summary.fabric.rounded === null ? AS_APPLICABLE_TEXT : formatInr(summary.fabric.rounded)
  const packingTotal = summary.packing.rounded === null ? AS_APPLICABLE_TEXT : formatInr(summary.packing.rounded)
  const approved = approvalsText(summary.approvals)

  // UNDER THE TOTALS (owner, 2026-10-30): the card's header keeps only the tabs
  // and Update from workbook, because figures up there crowded the list.
  const foot = (
    <div className="pv-foot">
      {view === 'cost' && (
        <>
          <MatchChip label="Fabric" comparison={summary.fabric.comparison} />
          <MatchChip label="Packing" comparison={summary.packing.comparison} />
        </>
      )}
      <p className="pv-legend">
        {data.sheetReadAt ? `Read from the PI workbook ${new Date(data.sheetReadAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. ` : 'Not read from a workbook yet. '}
        {view === 'cost' ? 'Totals are rounded to ₹10, like the workbook. ' : ''}
        {canEdit ? '' : 'Values can be typed by the PI’s salesperson, admins and managers.'}
      </p>
    </div>
  )

  if (isMobile) {
    return (
      <div className={animate ? 'pv-animate' : undefined}>
        {rows.map(row => {
          const line = lineOf(row)
          const c = costCells(line)
          const approval = line ? lineApproval(line, families) : null
          return (
            <div key={row.id} className="pv-card">
              <div className="pv-card-top">
                {row.image(true)}
                <div className="pv-card-name">
                  {row.code}
                  {row.product}
                  <span className="pv-muted">Qty {row.quantity}</span>
                </div>
              </div>
              <div className="pv-swap">
                {view === 'cost' && c && (
                  <dl className="pv-kv">
                    <dt>Fabric</dt><dd><b>{c.fabric}</b>{c.hasFabricFigure && <span className="pv-muted"> {c.metres} · {c.rate}/m</span>}</dd>
                    <dt>Packing</dt><dd><b>{c.packing}</b><span className="pv-muted"> {c.packingPerPiece}/pc</span></dd>
                    <dt>Type</dt><dd>{c.type}{c.typed && <TypedChip by={c.typedBy} />}</dd>
                  </dl>
                )}
                {view === 'approvals' && approval && (approval.state === 'none'
                  ? <span className="pv-pill">{NO_FINISH_TEXT}</span>
                  : (
                    <dl className="pv-kv">
                      {approval.cells.map(cell => (
                        <Fragment key={cell.family}>
                          <dt>{FINISH_FAMILY_LABELS[cell.family]}</dt>
                          <dd><ApprovalCell cell={cell} urls={urls} /></dd>
                        </Fragment>
                      ))}
                    </dl>
                  ))}
                {!line && <span className="pv-muted">—</span>}
              </div>
              {editButton(row, line)}
              {editing === editKey(row) && line && editor(line)}
            </div>
          )
        })}
        <div className="pv-card pv-card-total">
          <dl className="pv-kv">
            <dt>Total pieces</dt><dd><b>{pieces}</b></dd>
            {view === 'cost' ? (
              <>
                <dt>Fabric</dt><dd><b>{fabricTotal}</b>{summary.fabric.metres > 0 && <span className="pv-muted"> {metresText(summary.fabric.metres)}</span>}</dd>
                <dt>Packing</dt><dd><b>{packingTotal}</b></dd>
              </>
            ) : (
              <><dt>{APPROVALS_LABEL}</dt><dd><b>{approved}</b></dd></>
            )}
          </dl>
        </div>
        {foot}
      </div>
    )
  }

  const swapColumns = view === 'cost' ? COST_COLUMNS.length : families.length
  return (
    <div className={`pv-scroll${animate ? ' pv-animate' : ''}`}>
      <table className={`pv-table pv-table--${variant}`}>
        <colgroup>
          <col className="pv-col-code" /><col className="pv-col-image" /><col className="pv-col-product" /><col className="pv-col-qty" />
          {view === 'cost' && COST_COLUMNS.map(c => <col key={c.label} />)}
          {view === 'approvals' && families.map(f => <col key={f} />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Code</th><th scope="col">Image</th><th scope="col">Product</th>
            <th scope="col" className="pv-num">Qty</th>
            {view === 'cost' && COST_COLUMNS.map(c => (
              <th key={c.label} scope="col" className={`pv-swap${c.left ? '' : ' pv-num'}`}>{c.label}</th>
            ))}
            {view === 'approvals' && families.map(f => (
              <th key={f} scope="col" className="pv-swap">{FINISH_FAMILY_LABELS[f]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const line = lineOf(row)
            const c = costCells(line)
            const approval = line ? lineApproval(line, families) : null
            return (
              <Fragment key={row.id}>
                <tr>
                  <td>{row.code}</td>
                  <td>{row.image(false)}</td>
                  <td>{row.product}{editButton(row, line)}</td>
                  <td className="pv-num">{row.quantity}</td>
                  {view === 'cost' && (c ? (
                    <>
                      <td className="pv-swap pv-num pv-muted">{c.metresPerPiece ?? '—'}</td>
                      <td className="pv-swap pv-num pv-muted">{c.metres}</td>
                      <td className="pv-swap pv-num pv-muted">{c.rate}</td>
                      <td className={`pv-swap pv-num${c.hasFabricFigure ? ' pv-strong' : ' pv-muted'}`}>{c.fabric}</td>
                      <td className="pv-swap pv-num pv-muted">{c.packingPerPiece}</td>
                      <td className={`pv-swap pv-num${c.hasPackingFigure ? ' pv-strong' : ' pv-muted'}`}>{c.packing}</td>
                      <td className="pv-swap">{c.type}{c.typed && <TypedChip by={c.typedBy} />}</td>
                    </>
                  ) : <td className="pv-swap pv-muted" colSpan={swapColumns}>—</td>)}
                  {view === 'approvals' && (approval && approval.state !== 'none'
                    ? approval.cells.map(cell => <td key={cell.family} className="pv-swap"><ApprovalCell cell={cell} urls={urls} /></td>)
                    : <td className="pv-swap" colSpan={swapColumns}><span className="pv-pill">{NO_FINISH_TEXT}</span></td>)}
                </tr>
                {editing === editKey(row) && line && (
                  <tr className="pv-edit-row"><td colSpan={4 + swapColumns}>{editor(line)}</td></tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="pv-total">
            <td colSpan={3}>Total</td>
            <td className="pv-num">{pieces}</td>
            {view === 'cost' ? (
              <>
                <td className="pv-swap" />
                <td className="pv-swap pv-num">{summary.fabric.metres > 0 ? metresText(summary.fabric.metres) : ''}</td>
                <td className="pv-swap" />
                <td className="pv-swap pv-num">{fabricTotal}</td>
                <td className="pv-swap" />
                <td className="pv-swap pv-num">{packingTotal}</td>
                <td className="pv-swap" />
              </>
            ) : <td className="pv-swap" colSpan={swapColumns}>{approved}</td>}
          </tr>
        </tfoot>
      </table>
      {foot}
    </div>
  )
}
