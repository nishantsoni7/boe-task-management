'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Printer } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { AssetModal, AssetField, AssetModalActions, AssetModalError } from './AssetModal'
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
import { assetConditionLabel, type Asset, type EmployeeAsset } from '@/lib/assets/types'
import {
  ASSET_HANDOVER_ACKNOWLEDGEMENT,
  ASSET_HANDOVER_TERMS_HEADING,
  buildHandoverSheet,
  handoverTermsLines,
  type HandoverSheet,
  type HandoverSheetLine,
} from '@/lib/assets/handover'

// The two employee-facing halves of an asset handover: the acknowledgement
// dialog, and the sheet that is printed and hand-signed.
//
// This EXTENDS the acceptance flow that already existed — the Accept button in
// My Assets and accept_employee_asset() — rather than adding a second one.
// There is still exactly one acceptance per custody period, still recorded on
// the same employee_assets row, and still refused for anyone but the allocated
// employee (by the RPC, not by this file).

// ─── Shared presentation ──────────────────────────────────────────────────────

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
      <div style={{
        flex: '0 0 132px', fontSize: '10.5px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      <div style={{
        flex: 1, minWidth: 0, fontSize: '12.5px', color: colors.primary,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        ...(mono ? { fontFamily: 'monospace' } : {}),
      }}>
        {value}
      </div>
    </div>
  )
}

/**
 * The terms, as a numbered list.
 *
 * `acceptedTerms` is the stored snapshot when there is one; handoverTermsLines
 * decides, and this component never reaches for the current text on its own —
 * see the note in src/lib/assets/handover.ts about why a sheet must not restate
 * an old acceptance in today's words.
 */
export function HandoverTerms({ acceptedTerms }: { acceptedTerms?: string | null }) {
  const lines = handoverTermsLines(acceptedTerms)
  return (
    <div>
      <div style={{ fontSize: '12px', fontWeight: 700, color: colors.primary, marginBottom: '6px' }}>
        {ASSET_HANDOVER_TERMS_HEADING}
      </div>
      <ol style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {lines.map(line => (
          // The stored body is already numbered — that is the exact text the
          // employee agreed to — so the marker is suppressed and the line is
          // printed verbatim rather than renumbered by the browser.
          <li key={line} style={{ listStyle: 'none', marginLeft: '-18px', fontSize: '11.5px', color: colors.secondary, lineHeight: 1.5 }}>
            {line}
          </li>
        ))}
      </ol>
    </div>
  )
}

// ─── Accept ───────────────────────────────────────────────────────────────────

/**
 * What the employee is shown before they acknowledge.
 *
 * The tick-box gates the button here AND `p_accept_terms` gates the write in
 * the database. Both, deliberately: the checkbox is the honest interaction, and
 * the server check is what makes the record true even if a future screen change
 * forgets the checkbox.
 */
export function AcceptHandoverModal({
  assignment, asset, supabase, employeeName, issuedByName, onClose, onAccepted,
}: {
  assignment: EmployeeAsset
  asset: Asset | null
  supabase: SupabaseClient
  employeeName?: string | null
  issuedByName?: string | null
  onClose: () => void
  onAccepted: () => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (saving) return
    if (!acknowledged) {
      setError('Tick the acknowledgement to accept this handover.')
      return
    }
    setSaving(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('accept_employee_asset', {
      p_assignment_id: assignment.id,
      p_accept_terms: true,
    })
    setSaving(false)
    if (rpcError) {
      logAssetFailure('accept', rpcError)
      setError(assetErrorMessage('accept', rpcError))
      return
    }
    onAccepted()
  }

  return (
    <AssetModal title="Accept Handover" onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <DetailRow label="Asset / Device" value={asset?.asset_name ?? 'Unknown asset'} />
        <DetailRow
          label="Asset ID / Serial"
          value={[asset?.asset_code, asset?.serial_no].filter(Boolean).join(' · ') || 'Not recorded'}
          mono
        />
        {/* Both parties named, so the dialog states the same handover the
            printed sheet does. */}
        <DetailRow label="Issued To" value={employeeName?.trim() || 'You'} />
        <DetailRow label="Issued By" value={issuedByName?.trim() || 'Not recorded'} />
        <DetailRow
          label="Issued Condition"
          value={assignment.handover_condition ? assetConditionLabel(assignment.handover_condition) : 'Not recorded'}
        />
        <DetailRow label="Accessories" value={assignment.handover_accessories?.trim() || 'Not recorded'} />
        <DetailRow
          label="Existing Issues"
          value={assignment.handover_existing_issues?.trim() || 'None recorded at handover'}
        />
      </div>

      <div style={{
        borderTop: `1px solid ${colors.border}`, paddingTop: '12px',
        maxHeight: '220px', overflowY: 'auto',
      }}>
        <HandoverTerms />
      </div>

      <AssetField label="Acknowledgement">
        <label style={{ display: 'flex', gap: '9px', alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => { setAcknowledged(e.target.checked); setError(null) }}
            style={{ marginTop: '2px', flexShrink: 0 }}
          />
          <span style={{ fontSize: '12.5px', color: colors.primary, lineHeight: 1.45 }}>
            {ASSET_HANDOVER_ACKNOWLEDGEMENT}
          </span>
        </label>
      </AssetField>

      {error && <AssetModalError message={error} />}
      <AssetModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        disabled={!acknowledged}
        saveLabel="Accept Handover"
      />
    </AssetModal>
  )
}

// ─── Print ────────────────────────────────────────────────────────────────────

// Everything outside the sheet is removed for print, including the module
// chrome and this overlay's own buttons. The result is one A4 page carrying the
// document and nothing else.
//
// A print-only overlay rather than a separate route: the sheet is read from
// rows the page has already loaded, so a route would re-fetch the same custody
// record to render the same words, and it would need its own authorization
// story. The overlay inherits the page's.
const PRINT_STYLES = `
  @media print {
    body { background: #fff !important; }
    body > *:not(.boe-handover-print-root) { display: none !important; }
    .boe-handover-print-root { position: static !important; background: #fff !important; }
    .boe-handover-print-root .boe-handover-no-print { display: none !important; }
    .boe-handover-sheet {
      box-shadow: none !important; border: none !important;
      width: auto !important; max-width: none !important;
      margin: 0 !important; padding: 0 !important;
      max-height: none !important; overflow: visible !important;
    }
    @page { size: A4; margin: 16mm; }
  }
`

function SheetSection({ title, lines }: { title: string; lines: HandoverSheetLine[] }) {
  return (
    <section style={{ marginBottom: '14px' }}>
      <h2 style={{
        fontSize: '11px', fontWeight: 700, color: '#111318', margin: '0 0 6px',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {title}
      </h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <tbody>
          {lines.map(line => (
            <tr key={line.label}>
              <th style={{
                textAlign: 'left', verticalAlign: 'top', padding: '3px 12px 3px 0',
                width: '38%', fontWeight: 500, color: '#4A5261',
              }}>
                {line.label}
              </th>
              <td style={{
                padding: '3px 0', color: '#111318', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {line.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** The A4 document itself. Pure presentation over a model built by handover.ts. */
export function HandoverSheetDocument({ sheet }: { sheet: HandoverSheet }) {
  return (
    <div
      className="boe-handover-sheet"
      style={{
        background: '#fff', color: '#111318',
        width: '210mm', maxWidth: '100%',
        maxHeight: 'calc(100vh - 120px)', overflowY: 'auto',
        padding: '20mm 18mm', margin: '0 auto',
        boxShadow: '0 6px 28px rgba(0,0,0,0.18)', borderRadius: '4px',
        fontSize: '12px', lineHeight: 1.5,
      }}
    >
      <header style={{ borderBottom: '2px solid #111318', paddingBottom: '10px', marginBottom: '16px' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '-0.01em' }}>{sheet.company}</div>
        <div style={{ fontSize: '13px', color: '#4A5261', marginTop: '2px' }}>{sheet.title}</div>
      </header>

      <SheetSection title="Asset Details" lines={sheet.assetLines} />
      <SheetSection title="Condition at Handover" lines={sheet.handoverLines} />

      <section style={{ marginBottom: '14px' }}>
        <h2 style={{
          fontSize: '11px', fontWeight: 700, margin: '0 0 6px',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          {sheet.termsHeading}
        </h2>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {sheet.terms.map(line => (
            <li key={line} style={{ marginBottom: '4px', color: '#111318' }}>{line}</li>
          ))}
        </ol>
      </section>

      <section style={{ marginBottom: '18px' }}>
        <h2 style={{
          fontSize: '11px', fontWeight: 700, margin: '0 0 6px',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Online Acceptance
        </h2>
        <p style={{ margin: '0 0 6px', color: '#111318' }}>{sheet.acceptanceStatement}</p>
        {sheet.acceptanceLines.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <tbody>
              {sheet.acceptanceLines.map(line => (
                <tr key={line.label}>
                  <th style={{
                    textAlign: 'left', verticalAlign: 'top', padding: '3px 12px 3px 0',
                    width: '38%', fontWeight: 500, color: '#4A5261',
                  }}>
                    {line.label}
                  </th>
                  <td style={{ padding: '3px 0' }}>{line.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* The physical half. Present whether or not the online acceptance
          happened: the two evidence different things and the sheet is signed in
          the room. */}
      <section style={{ display: 'flex', gap: '32px', marginTop: '28px' }}>
        {sheet.signatures.map(sig => (
          <div key={sig.label} style={{ flex: 1 }}>
            <div style={{ borderBottom: '1px solid #111318', height: '42px' }} />
            <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '5px' }}>{sig.label}</div>
            <div style={{ fontSize: '11px', color: '#4A5261' }}>{sig.caption}</div>
            <div style={{ fontSize: '11px', color: '#4A5261', marginTop: '8px' }}>Date: ____________________</div>
          </div>
        ))}
      </section>
    </div>
  )
}

/**
 * The sheet, over the page, with Print and Close.
 *
 * `formatDateTime` is injected rather than chosen here so the sheet reads dates
 * the same way the page around it does.
 */
export function HandoverSheetOverlay({
  assignment, asset, employeeName, issuedByName, acceptedByName, formatDateTime, onClose,
}: {
  assignment: EmployeeAsset
  asset: Asset | null
  employeeName?: string | null
  issuedByName?: string | null
  acceptedByName?: string | null
  formatDateTime: (iso: string) => string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const sheet = buildHandoverSheet({
    assetName: asset?.asset_name,
    assetCode: asset?.asset_code,
    serialNo: asset?.serial_no,
    assetType: asset?.asset_type,
    employeeName,
    issuedByName,
    assignedAt: assignment.assigned_at,
    condition: assignment.handover_condition,
    accessories: assignment.handover_accessories,
    existingIssues: assignment.handover_existing_issues,
    acceptedAt: assignment.accepted_at,
    acceptedByName: acceptedByName ?? employeeName,
    acceptanceVersion: assignment.acceptance_version,
    acceptedTerms: assignment.accepted_terms,
    formatDateTime,
  })

  // PORTALLED TO document.body, AND THE PRINT RULE IS WHY.
  //
  // PRINT_STYLES hides everything beside the sheet with
  // `body > *:not(.boe-handover-print-root)`. Rendered in place, this overlay is
  // a descendant of div.boe-app-shell — which IS a direct child of body, so the
  // rule would hide the app shell AND the sheet inside it, and the printout
  // would be a blank page. Found in local browser QA, where the sheet rendered
  // perfectly on screen and would have printed nothing.
  //
  // The portal makes the overlay the body child the selector is written for.
  // Everything else — the fixed positioning, the z-index above the sidebar, the
  // Escape handler, the scroll lock — is unchanged by it.
  //
  // No mounted-flag effect: this component is only ever rendered after a click,
  // so it never runs during SSR, and `typeof document` cannot change between
  // renders on a client.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="boe-handover-print-root"
      role="dialog"
      aria-modal="true"
      aria-label="Asset Handover Sheet"
      style={{
        position: 'fixed', inset: 0, zIndex: 210,
        background: 'rgba(17,19,24,0.55)',
        overflowY: 'auto', padding: '24px 16px',
      }}
    >
      <style>{PRINT_STYLES}</style>
      <div
        className="boe-handover-no-print"
        style={{
          display: 'flex', justifyContent: 'flex-end', gap: '10px',
          maxWidth: '210mm', margin: '0 auto 12px',
        }}
      >
        <button
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 16px', fontSize: '13px', background: colors.base }}
          onClick={onClose}
        >
          Close
        </button>
        <button
          className="boe-btn boe-btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '8px 18px', fontSize: '13px' }}
          onClick={() => window.print()}
        >
          <Printer size={14} strokeWidth={2} />
          Print
        </button>
      </div>
      <HandoverSheetDocument sheet={sheet} />
    </div>,
    document.body,
  )
}
