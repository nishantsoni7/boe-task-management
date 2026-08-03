'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { AssetModal, AssetField, AssetModalActions, AssetModalError } from '@/components/assets/AssetModal'
import { assetErrorMessage, logAssetFailure, type AssetAction } from '@/lib/assets/errors'
import {
  ASSET_CONDITION_OPTIONS,
  ASSET_SERVICE_TYPE_OPTIONS,
  ASSET_SERVICE_TYPE_LABEL,
  ASSET_CONDITION_LABEL,
  type Asset,
  type AssetEmployee,
  type AssetServiceRecord,
} from '@/lib/assets/types'
import {
  validateAssignment,
  validateRecovery,
  validateTransfer,
  transferCandidates,
  type TransferTarget,
} from '@/lib/assets/transfers'
import { validateServiceRecord } from '@/lib/assets/service'
import { validateWarrantyDates } from '@/lib/assets/warranty'
import { notifyAssetEvent } from '@/lib/assets/notifyClient'
import {
  ASSET_DOCUMENT_ACCEPT,
  ASSET_DOCUMENT_BUCKET,
  ASSET_DOCUMENT_TYPES_LABEL,
  buildDocumentPath,
  sanitizeDocumentName,
  validateDocument,
} from '@/lib/assets/documents'
import type { AssetDocumentType } from '@/lib/assets/types'

// Every write the asset detail page performs, one modal each.
//
// They all follow the same shape and the same rules:
//   * validation runs client-side FIRST, using the same pure helpers the tests
//     assert, so the reader is told before a round-trip;
//   * the write is a single SECURITY DEFINER RPC, so the custody row, the asset
//     row, the movement record and the audit entry move together or not at all;
//   * a failure keeps the modal open with every entered value intact and shows
//     one sentence inside the dialog (assetErrorMessage), while the console
//     keeps the driver error;
//   * the notification is dispatched only AFTER the RPC succeeded, and is never
//     awaited — see notifyClient.ts.

const inputStyle = { width: '100%' } as const

type CommonProps = {
  asset: Asset
  supabase: SupabaseClient
  onClose: () => void
  onDone: (message: string) => void
}

/** Shared submit plumbing: one in-flight guard, one error slot, one console log. */
function useSubmit(action: AssetAction) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // PromiseLike, not Promise: a Supabase query builder is thenable but is not a
  // Promise, so demanding one here would force every call site to wrap itself.
  const run = async (fn: () => PromiseLike<{ error: unknown }>): Promise<boolean> => {
    // The guard AND the visible in-progress state are the same flag, so a form
    // can never show "Saving…" without also refusing a second submit.
    if (saving) return false
    setSaving(true)
    setError(null)
    const { error: err } = await fn()
    setSaving(false)
    if (err) {
      logAssetFailure(action, err as { message?: string; code?: string })
      setError(assetErrorMessage(action, err as { message?: string; code?: string }))
      return false
    }
    return true
  }

  return { saving, error, setError, run }
}

function ConditionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="boe-input" value={value} onChange={e => onChange(e.target.value)} style={inputStyle}>
      <option value="">Not recorded</option>
      {ASSET_CONDITION_OPTIONS.map(c => (
        <option key={c} value={c}>{ASSET_CONDITION_LABEL[c]}</option>
      ))}
    </select>
  )
}

// ─── Assign ───────────────────────────────────────────────────────────────────

export function AssignAssetModal({
  asset, supabase, employees, onClose, onDone,
}: CommonProps & { employees: AssetEmployee[] }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [condition, setCondition] = useState(asset.condition ?? '')
  const [remarks, setRemarks] = useState('')
  const { saving, error, setError, run } = useSubmit('assign')

  const submit = async () => {
    const invalid = validateAssignment({ assetStatus: asset.status, employeeId: employeeId || null })
    if (invalid) { setError(invalid); return }

    const ok = await run(() => supabase.rpc('assign_asset', {
      p_asset_id: asset.id,
      p_employee_id: employeeId,
      p_effective_date: effectiveDate || null,
      p_condition: condition || null,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_assigned',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: employeeId,
      toName: employees.find(e => e.id === employeeId)?.full_name ?? null,
    })
    onDone('Asset assigned. The employee has been asked to accept it.')
  }

  return (
    <AssetModal title="Assign Asset" onClose={onClose}>
      <AssetField label="Employee">
        <select className="boe-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={inputStyle}>
          {employees.map(e => <option key={e.id} value={e.id}>{e.full_name} — {e.role}</option>)}
        </select>
      </AssetField>
      <AssetField label="Handover Date" hint="When the asset physically changed hands, if not today.">
        <input type="date" className="boe-input" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Condition at Handover">
        <ConditionSelect value={condition} onChange={setCondition} />
      </AssetField>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Assign Asset" />
    </AssetModal>
  )
}

// ─── Transfer ─────────────────────────────────────────────────────────────────

export function TransferAssetModal({
  asset, supabase, employees, currentEmployeeId, currentEmployeeName, onClose, onDone,
}: CommonProps & {
  employees: AssetEmployee[]
  currentEmployeeId: string | null
  currentEmployeeName: string | null
}) {
  const candidates = transferCandidates(employees, currentEmployeeId)
  const [mode, setMode] = useState<'employee' | 'location'>('employee')
  const [employeeId, setEmployeeId] = useState(candidates[0]?.id ?? '')
  const [location, setLocation] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [condition, setCondition] = useState('')
  const [remarks, setRemarks] = useState('')
  const { saving, error, setError, run } = useSubmit('transfer')

  const target: TransferTarget | null = mode === 'employee'
    ? (employeeId ? { kind: 'employee', employeeId } : null)
    : { kind: 'location', location }

  const submit = async () => {
    const invalid = validateTransfer({ assetStatus: asset.status, currentEmployeeId, target })
    if (invalid) { setError(invalid); return }

    const ok = await run(() => supabase.rpc('transfer_asset', {
      p_asset_id: asset.id,
      p_to_employee_id: mode === 'employee' ? employeeId : null,
      p_to_location: mode === 'location' ? location.trim() : null,
      p_effective_date: effectiveDate || null,
      p_condition: condition || null,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_transferred',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: mode === 'employee' ? employeeId : null,
      fromEmployeeId: currentEmployeeId,
      toName: mode === 'employee' ? (candidates.find(e => e.id === employeeId)?.full_name ?? null) : null,
      fromName: currentEmployeeName,
      toLocation: mode === 'location' ? location.trim() : null,
    })
    onDone('Transfer recorded.')
  }

  return (
    <AssetModal title="Transfer Asset" onClose={onClose}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        Currently with {currentEmployeeName ?? asset.location ?? 'the company'}. The previous custody
        record is kept — a transfer never erases who held the asset before.
      </div>
      <AssetField label="Transfer To">
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['employee', 'location'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`boe-btn ${mode === m ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
              style={{ padding: '6px 14px', fontSize: '12px' }}
            >
              {m === 'employee' ? 'An employee' : 'A company location'}
            </button>
          ))}
        </div>
      </AssetField>

      {mode === 'employee' ? (
        <AssetField label="Employee">
          <select className="boe-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={inputStyle}>
            {candidates.map(e => <option key={e.id} value={e.id}>{e.full_name} — {e.role}</option>)}
          </select>
        </AssetField>
      ) : (
        <AssetField label="Company Location" hint="For example: Store Room, Design Department.">
          <input className="boe-input" value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} />
        </AssetField>
      )}

      <AssetField label="Effective Handover Date">
        <input type="date" className="boe-input" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Condition at Transfer">
        <ConditionSelect value={condition} onChange={setCondition} />
      </AssetField>
      <AssetField label="Reason / Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Transfer Asset" />
    </AssetModal>
  )
}

// ─── Mark Returned ────────────────────────────────────────────────────────────

export function ReturnAssetModal({
  asset, supabase, currentEmployeeId, currentEmployeeName, onClose, onDone,
}: CommonProps & { currentEmployeeId: string | null; currentEmployeeName: string | null }) {
  const [condition, setCondition] = useState('')
  const [location, setLocation] = useState(asset.location ?? '')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const { saving, error, run } = useSubmit('return')

  const submit = async () => {
    const ok = await run(() => supabase.rpc('return_asset', {
      p_asset_id: asset.id,
      p_condition: condition || null,
      p_remarks: remarks.trim() || null,
      p_location: location.trim() || null,
      p_effective_date: effectiveDate || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_returned',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      fromEmployeeId: currentEmployeeId,
      fromName: currentEmployeeName,
      toLocation: location.trim() || null,
    })
    onDone('Asset marked returned and available again.')
  }

  return (
    <AssetModal title="Mark Returned" onClose={onClose}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        Returned by {currentEmployeeName ?? 'the current custodian'}. Their custody record stays on
        the asset permanently.
      </div>
      <AssetField label="Condition on Return">
        <ConditionSelect value={condition} onChange={setCondition} />
      </AssetField>
      <AssetField label="Stored At" hint="Where the asset sits now that nobody holds it.">
        <input className="boe-input" value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Effective Handover Date">
        <input type="date" className="boe-input" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Mark Returned" />
    </AssetModal>
  )
}

// ─── Mark Lost ────────────────────────────────────────────────────────────────

export function MarkLostModal({
  asset, supabase, currentEmployeeId, currentEmployeeName, onClose, onDone,
}: CommonProps & { currentEmployeeId: string | null; currentEmployeeName: string | null }) {
  const [remarks, setRemarks] = useState('')
  const { saving, error, run } = useSubmit('mark-lost')

  const submit = async () => {
    const ok = await run(() => supabase.rpc('mark_asset_lost', {
      p_asset_id: asset.id,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_lost',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      fromEmployeeId: currentEmployeeId,
      fromName: currentEmployeeName,
    })
    onDone('Asset marked lost.')
  }

  return (
    <AssetModal title="Mark Lost" onClose={onClose}>
      <div style={{
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '11.5px',
      }}>
        Writing an asset off is an accountability event. The last custodian and every administrator
        are notified, and the record is permanent — it can only be reversed by recording a recovery.
      </div>
      <AssetField label="What happened? (recommended)">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Mark Lost" destructive />
    </AssetModal>
  )
}

// ─── Recover ──────────────────────────────────────────────────────────────────

export function RecoverAssetModal({
  asset, supabase, employees, onClose, onDone,
}: CommonProps & { employees: AssetEmployee[] }) {
  const [mode, setMode] = useState<'location' | 'employee'>('location')
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [location, setLocation] = useState(asset.location ?? '')
  const [condition, setCondition] = useState('')
  const [remarks, setRemarks] = useState('')
  const { saving, error, setError, run } = useSubmit('recover')

  const target: TransferTarget | null = mode === 'employee'
    ? (employeeId ? { kind: 'employee', employeeId } : null)
    : { kind: 'location', location }

  const submit = async () => {
    const invalid = validateRecovery({ assetStatus: asset.status, target })
    if (invalid) { setError(invalid); return }

    const ok = await run(() => supabase.rpc('recover_lost_asset', {
      p_asset_id: asset.id,
      p_to_employee_id: mode === 'employee' ? employeeId : null,
      p_to_location: mode === 'location' ? location.trim() : null,
      p_condition: condition || null,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_recovered',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: mode === 'employee' ? employeeId : null,
      toName: mode === 'employee' ? (employees.find(e => e.id === employeeId)?.full_name ?? null) : null,
      toLocation: mode === 'location' ? location.trim() : null,
    })
    onDone('Recovery recorded. The asset is back in service.')
  }

  return (
    <AssetModal title="Record Recovery" onClose={onClose}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        The write-off stays in the history. This adds the recovery beside it rather than erasing it.
      </div>
      <AssetField label="Recovered To">
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['location', 'employee'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`boe-btn ${mode === m ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
              style={{ padding: '6px 14px', fontSize: '12px' }}
            >
              {m === 'location' ? 'A company location' : 'An employee'}
            </button>
          ))}
        </div>
      </AssetField>

      {mode === 'employee' ? (
        <AssetField label="Employee" hint="They will be asked to accept it, as with any assignment.">
          <select className="boe-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={inputStyle}>
            {employees.map(e => <option key={e.id} value={e.id}>{e.full_name} — {e.role}</option>)}
          </select>
        </AssetField>
      ) : (
        <AssetField label="Company Location">
          <input className="boe-input" value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} />
        </AssetField>
      )}

      <AssetField label="Condition">
        <ConditionSelect value={condition} onChange={setCondition} />
      </AssetField>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Record Recovery" />
    </AssetModal>
  )
}

// ─── Send for repair ──────────────────────────────────────────────────────────

export function SendForRepairModal({
  asset, supabase, currentEmployeeId, onClose, onDone,
}: CommonProps & { currentEmployeeId: string | null }) {
  const [serviceType, setServiceType] = useState<string>('repair')
  const [issue, setIssue] = useState('')
  const [description, setDescription] = useState('')
  const [vendor, setVendor] = useState('')
  const [sentDate, setSentDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const { saving, error, setError, run } = useSubmit('send-repair')

  const submit = async () => {
    const invalid = validateServiceRecord({ serviceType, vendor, sentDate })
    if (invalid) { setError(invalid); return }

    const ok = await run(() => supabase.rpc('send_asset_for_repair', {
      p_asset_id: asset.id,
      p_service_type: serviceType,
      p_issue: issue.trim() || null,
      p_description: description.trim() || null,
      p_vendor: vendor.trim() || null,
      p_sent_date: sentDate || null,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_repair_sent',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: currentEmployeeId,
      vendor: vendor.trim() || null,
    })
    onDone('Asset sent for service. Close the record when it comes back.')
  }

  return (
    <AssetModal title="Send for Repair / Service" onClose={onClose} width={520}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        Custody does not change. Whoever the asset is charged to stays accountable for it while the
        vendor has it.
      </div>
      <AssetField label="Service Type">
        <select className="boe-input" value={serviceType} onChange={e => setServiceType(e.target.value)} style={inputStyle}>
          {ASSET_SERVICE_TYPE_OPTIONS.map(t => (
            <option key={t} value={t}>{ASSET_SERVICE_TYPE_LABEL[t]}</option>
          ))}
        </select>
      </AssetField>
      <AssetField label="Issue / Complaint">
        <textarea className="boe-input" value={issue} onChange={e => setIssue(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      <AssetField label="Service Description">
        <textarea className="boe-input" value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      <AssetField label="Vendor / Service Provider">
        <input className="boe-input" value={vendor} onChange={e => setVendor(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Sent Date" hint="Defaults to today.">
        <input type="date" className="boe-input" value={sentDate} onChange={e => setSentDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Send for Service" />
    </AssetModal>
  )
}

// ─── Close an open service record ─────────────────────────────────────────────

export function CompleteServiceModal({
  asset, supabase, record, currentEmployeeId, onClose, onDone,
}: CommonProps & { record: AssetServiceRecord; currentEmployeeId: string | null }) {
  const [returnedDate, setReturnedDate] = useState('')
  const [cost, setCost] = useState('')
  const [conditionAfter, setConditionAfter] = useState('')
  const [nextServiceDate, setNextServiceDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const { saving, error, setError, run } = useSubmit('complete-service')

  const submit = async () => {
    const invalid = validateServiceRecord({
      serviceType: record.service_type,
      cost,
      sentDate: record.sent_date,
      returnedDate,
    })
    if (invalid) { setError(invalid); return }

    const ok = await run(() => supabase.rpc('complete_asset_service', {
      p_service_id: record.id,
      p_returned_date: returnedDate || null,
      p_cost: cost.trim() === '' ? null : Number(cost),
      p_condition_after: conditionAfter || null,
      p_remarks: remarks.trim() || null,
      p_next_service_date: nextServiceDate || null,
    }))
    if (!ok) return

    notifyAssetEvent({
      event: 'asset_repair_returned',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: currentEmployeeId,
      vendor: record.vendor,
    })
    onDone('Service record closed.')
  }

  return (
    <AssetModal title="Record Return from Service" onClose={onClose} width={520}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        {ASSET_SERVICE_TYPE_LABEL[record.service_type] ?? record.service_type}
        {record.vendor ? ` · ${record.vendor}` : ''}
      </div>
      <AssetField label="Returned Date" hint="Defaults to today.">
        <input type="date" className="boe-input" value={returnedDate} onChange={e => setReturnedDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Service Cost (₹)">
        <input
          className="boe-input"
          inputMode="decimal"
          value={cost}
          onChange={e => setCost(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0"
          style={inputStyle}
        />
      </AssetField>
      <AssetField label="Condition After Service">
        <ConditionSelect value={conditionAfter} onChange={setConditionAfter} />
      </AssetField>
      <AssetField label="Next Service Due">
        <input type="date" className="boe-input" value={nextServiceDate} onChange={e => setNextServiceDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Close Service Record" />
    </AssetModal>
  )
}

// ─── Add a historical service record ──────────────────────────────────────────

export function AddServiceRecordModal({
  asset, supabase, currentEmployeeId, onClose, onDone,
}: CommonProps & { currentEmployeeId: string | null }) {
  const [serviceType, setServiceType] = useState<string>('repair')
  const [issue, setIssue] = useState('')
  const [description, setDescription] = useState('')
  const [vendor, setVendor] = useState('')
  const [sentDate, setSentDate] = useState('')
  const [returnedDate, setReturnedDate] = useState('')
  const [cost, setCost] = useState('')
  const [conditionAfter, setConditionAfter] = useState('')
  const [nextServiceDate, setNextServiceDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const { saving, error, setError, run } = useSubmit('add-service')

  const submit = async () => {
    const invalid = validateServiceRecord({ serviceType, vendor, sentDate, returnedDate, cost, issue })
    if (invalid) { setError(invalid); return }

    const ok = await run(() => supabase.rpc('add_asset_service_record', {
      p_asset_id: asset.id,
      p_service_type: serviceType,
      p_issue: issue.trim() || null,
      p_description: description.trim() || null,
      p_vendor: vendor.trim() || null,
      p_sent_date: sentDate || null,
      p_returned_date: returnedDate || null,
      p_cost: cost.trim() === '' ? 0 : Number(cost),
      p_condition_after: conditionAfter || null,
      p_remarks: remarks.trim() || null,
      p_next_service_date: nextServiceDate || null,
    }))
    if (!ok) return
    // The person holding it is told a service was logged against it. Nobody
    // else is related: an asset on the shelf resolves to no recipient and
    // writes nothing.
    notifyAssetEvent({
      event: 'asset_service_added',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: currentEmployeeId,
      vendor: vendor.trim() || null,
    })
    onDone('Service record added.')
  }

  return (
    <AssetModal title="Add Repair / Service" onClose={onClose} width={520}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        For a service that has already been completed. To send the asset away now, use
        Send for Repair instead.
      </div>
      <AssetField label="Service Type">
        <select className="boe-input" value={serviceType} onChange={e => setServiceType(e.target.value)} style={inputStyle}>
          {ASSET_SERVICE_TYPE_OPTIONS.map(t => (
            <option key={t} value={t}>{ASSET_SERVICE_TYPE_LABEL[t]}</option>
          ))}
        </select>
      </AssetField>
      <AssetField label="Issue / Complaint">
        <textarea className="boe-input" value={issue} onChange={e => setIssue(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      <AssetField label="Service Description">
        <textarea className="boe-input" value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      <AssetField label="Vendor / Service Provider">
        <input className="boe-input" value={vendor} onChange={e => setVendor(e.target.value)} style={inputStyle} />
      </AssetField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <AssetField label="Sent Date">
          <input type="date" className="boe-input" value={sentDate} onChange={e => setSentDate(e.target.value)} style={inputStyle} />
        </AssetField>
        <AssetField label="Returned Date">
          <input type="date" className="boe-input" value={returnedDate} onChange={e => setReturnedDate(e.target.value)} style={inputStyle} />
        </AssetField>
      </div>
      <AssetField label="Service Cost (₹)">
        <input
          className="boe-input"
          inputMode="decimal"
          value={cost}
          onChange={e => setCost(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0"
          style={inputStyle}
        />
      </AssetField>
      <AssetField label="Condition After Service">
        <ConditionSelect value={conditionAfter} onChange={setConditionAfter} />
      </AssetField>
      <AssetField label="Next Service Due">
        <input type="date" className="boe-input" value={nextServiceDate} onChange={e => setNextServiceDate(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Add Service Record" />
    </AssetModal>
  )
}

// ─── Warranty & purchase details ──────────────────────────────────────────────
//
// A direct UPDATE on `assets`, not an RPC: the assets_update policy already
// governs who may change master details, and log_asset_edited() records both
// sides of every field that moved — including a separate warranty_updated
// entry. An RPC here would only add a second door to the same room.

export function WarrantyDetailsModal({
  asset, supabase, currentEmployeeId, onClose, onDone,
}: CommonProps & { currentEmployeeId: string | null }) {
  const [purchaseDate, setPurchaseDate] = useState(asset.purchase_date ?? '')
  const [purchasePrice, setPurchasePrice] = useState(
    asset.purchase_price === null || asset.purchase_price === undefined ? '' : String(asset.purchase_price),
  )
  const [vendor, setVendor] = useState(asset.vendor ?? '')
  const [invoiceNumber, setInvoiceNumber] = useState(asset.invoice_number ?? '')
  const [warrantyStart, setWarrantyStart] = useState(asset.warranty_start_date ?? '')
  const [warrantyExpiry, setWarrantyExpiry] = useState(asset.warranty_expiry_date ?? '')
  const [warrantyType, setWarrantyType] = useState(asset.warranty_type ?? '')
  const [warrantyRemarks, setWarrantyRemarks] = useState(asset.warranty_remarks ?? '')
  const { saving, error, setError, run } = useSubmit('edit')

  const submit = async () => {
    const invalid = validateWarrantyDates(warrantyStart || null, warrantyExpiry || null)
    if (invalid) { setError(invalid); return }

    if (purchasePrice.trim() !== '') {
      const n = Number(purchasePrice)
      if (!Number.isFinite(n) || n < 0) { setError('Purchase price must be a number of zero or more.'); return }
    }

    const ok = await run(() => supabase
      .from('assets')
      .update({
        purchase_date:        purchaseDate || null,
        purchase_price:       purchasePrice.trim() === '' ? null : Number(purchasePrice),
        vendor:               vendor.trim() || null,
        invoice_number:       invoiceNumber.trim() || null,
        warranty_start_date:  warrantyStart || null,
        warranty_expiry_date: warrantyExpiry || null,
        warranty_type:        warrantyType.trim() || null,
        warranty_remarks:     warrantyRemarks.trim() || null,
      })
      .eq('id', asset.id))
    if (!ok) return
    // The warranty COVER on an asset is not paperwork to the person holding it
    // — it decides whether a fault costs them a repair request or a purchase
    // order. The custodian is told; the expiring-soon reminder still comes from
    // the sweep separately.
    notifyAssetEvent({
      event: 'asset_warranty_updated',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: currentEmployeeId,
    })
    onDone('Warranty and purchase details saved.')
  }

  return (
    <AssetModal title="Warranty & Purchase Details" onClose={onClose} width={520}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <AssetField label="Purchase Date">
          <input type="date" className="boe-input" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} style={inputStyle} />
        </AssetField>
        <AssetField label="Purchase Price (₹)">
          <input
            className="boe-input"
            inputMode="decimal"
            value={purchasePrice}
            onChange={e => setPurchasePrice(e.target.value.replace(/[^0-9.]/g, ''))}
            style={inputStyle}
          />
        </AssetField>
      </div>
      <AssetField label="Vendor">
        <input className="boe-input" value={vendor} onChange={e => setVendor(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Invoice Number">
        <input className="boe-input" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} style={inputStyle} />
      </AssetField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <AssetField label="Warranty Start">
          <input type="date" className="boe-input" value={warrantyStart} onChange={e => setWarrantyStart(e.target.value)} style={inputStyle} />
        </AssetField>
        <AssetField label="Warranty Expiry">
          <input type="date" className="boe-input" value={warrantyExpiry} onChange={e => setWarrantyExpiry(e.target.value)} style={inputStyle} />
        </AssetField>
      </div>
      <AssetField label="Warranty Type" hint="For example: Manufacturer, Extended, On-site.">
        <input className="boe-input" value={warrantyType} onChange={e => setWarrantyType(e.target.value)} style={inputStyle} />
      </AssetField>
      <AssetField label="Warranty Remarks">
        <textarea className="boe-input" value={warrantyRemarks} onChange={e => setWarrantyRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Save Details" />
    </AssetModal>
  )
}

// ─── Upload a document ────────────────────────────────────────────────────────

export function UploadDocumentModal({
  asset, supabase, docType, currentEmployeeId, onClose, onDone,
}: CommonProps & { docType: AssetDocumentType; currentEmployeeId: string | null }) {
  const [file, setFile] = useState<File | null>(null)
  const { saving, error, setError, run } = useSubmit('upload-document')

  const label = docType === 'invoice' ? 'Invoice'
    : docType === 'warranty_card' ? 'Warranty Card'
    : 'Supporting Document'

  const submit = async () => {
    if (!file) { setError('Choose a file to upload.'); return }

    const check = validateDocument(file)
    if (!check.ok) { setError(check.error); return }

    const path = buildDocumentPath(asset.id, docType, file.name)

    const ok = await run(async () => {
      // Storage first, metadata second. The other order would leave a row
      // pointing at bytes that do not exist — a document the page offers and
      // then fails to open.
      const { error: uploadError } = await supabase.storage
        .from(ASSET_DOCUMENT_BUCKET)
        .upload(path, file, { contentType: check.contentType, upsert: false })
      if (uploadError) return { error: uploadError }

      const { error: insertError } = await supabase.from('asset_documents').insert({
        asset_id: asset.id,
        doc_type: docType,
        file_name: sanitizeDocumentName(file.name),
        storage_path: path,
        mime_type: check.contentType,
        file_size: file.size,
      })

      if (insertError) {
        // All-or-nothing: an orphaned object is invisible, an orphaned row is a
        // broken link somebody will click. Best-effort cleanup, and the insert
        // error is what the reader is told about either way.
        await supabase.storage.from(ASSET_DOCUMENT_BUCKET).remove([path]).catch(() => {})
        return { error: insertError }
      }
      return { error: null }
    })

    if (!ok) return
    // The custodian is told a document now sits on their asset — an invoice or
    // warranty card is what they will be asked for when something breaks.
    notifyAssetEvent({
      event: 'asset_document_uploaded',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      toEmployeeId: currentEmployeeId,
      documentKind: docType,
    })
    onDone(`${label} uploaded.`)
  }

  return (
    <AssetModal title={`Upload ${label}`} onClose={onClose}>
      <AssetField label="File" hint={`${ASSET_DOCUMENT_TYPES_LABEL}. Maximum 10 MB.`}>
        <input
          type="file"
          className="boe-input"
          accept={ASSET_DOCUMENT_ACCEPT}
          onChange={e => { setFile(e.target.files?.[0] ?? null); setError(null) }}
          style={inputStyle}
        />
      </AssetField>
      {file && (
        <div style={{ fontSize: '11.5px', color: colors.muted }}>
          Selected: {file.name}
        </div>
      )}
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Upload" disabled={!file} />
    </AssetModal>
  )
}

// ─── Remove a document ────────────────────────────────────────────────────────

export function RemoveDocumentModal({
  supabase, documentId, fileName, onClose, onDone,
}: {
  supabase: SupabaseClient
  documentId: string
  fileName: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [note, setNote] = useState('')
  const { saving, error, run } = useSubmit('remove-document')

  const submit = async () => {
    const ok = await run(() => supabase.rpc('remove_asset_document', {
      p_document_id: documentId,
      p_note: note.trim() || null,
    }))
    if (!ok) return
    onDone('Document removed from the record.')
  }

  return (
    <AssetModal title="Remove Document" onClose={onClose}>
      <div style={{ fontSize: '12px', color: colors.secondary }}>{fileName}</div>
      <div style={{
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '11.5px',
      }}>
        The document is taken off the asset and the removal is recorded in the activity history.
        The stored file itself is retained.
      </div>
      <AssetField label="Reason (optional)">
        <textarea className="boe-input" value={note} onChange={e => setNote(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Remove Document" destructive />
    </AssetModal>
  )
}

// ─── Retire / dispose / restore ───────────────────────────────────────────────

export function RetireAssetModal({
  asset, supabase, dispose, onClose, onDone,
}: CommonProps & { dispose: boolean }) {
  const [remarks, setRemarks] = useState('')
  const { saving, error, run } = useSubmit('retire')

  const submit = async () => {
    const ok = await run(() => supabase.rpc('retire_asset', {
      p_asset_id: asset.id,
      p_dispose: dispose,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return
    // Retirement is blocked while an assignment is open, so there is never a
    // custodian left to tell. 'admins' preserves the module's existing
    // responsibility model — BOE has no designated-reviewer column.
    notifyAssetEvent({
      event: dispose ? 'asset_disposed' : 'asset_retired',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
    })
    onDone(dispose ? 'Asset marked disposed.' : 'Asset retired from service.')
  }

  return (
    <AssetModal title={dispose ? 'Dispose Asset' : 'Retire Asset'} onClose={onClose}>
      <div style={{
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '11.5px',
      }}>
        {dispose
          ? 'Disposal ends this asset’s working life. It can be restored to service later, and its full history is kept either way.'
          : 'A retired asset cannot be assigned. It can be restored to service later, and its full history is kept either way.'}
      </div>
      <AssetField label="Reason / Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel={dispose ? 'Dispose Asset' : 'Retire Asset'}
        destructive
      />
    </AssetModal>
  )
}

export function RestoreAssetModal({ asset, supabase, onClose, onDone }: CommonProps) {
  const [remarks, setRemarks] = useState('')
  const { saving, error, run } = useSubmit('restore')

  const submit = async () => {
    const ok = await run(() => supabase.rpc('restore_asset', {
      p_asset_id: asset.id,
      p_remarks: remarks.trim() || null,
    }))
    if (!ok) return
    notifyAssetEvent({
      event: 'asset_restored',
      assetId: asset.id,
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
    })
    onDone('Asset restored and available again.')
  }

  return (
    <AssetModal title="Restore to Service" onClose={onClose}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        The asset goes back on the shelf as available. Assign it from there so the normal
        acceptance step still applies.
      </div>
      <AssetField label="Remarks">
        <textarea className="boe-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </AssetField>
      {error && <AssetModalError message={error} />}
      <AssetModalActions onClose={onClose} onSave={submit} saving={saving} saveLabel="Restore Asset" />
    </AssetModal>
  )
}

// ─── Delete permanently ───────────────────────────────────────────────────────
//
// The only action in this module that erases rather than records, and the only
// one an administrator alone may take — public.permanently_delete_asset
// (20260803000000) re-checks that server-side and removes the asset together
// with every record that belongs solely to it, in one transaction.
//
// Same modal shell, same destructive styling and same one-sentence failure slot
// as every dialog above: a different-looking dialog for the most consequential
// action would be the wrong kind of special.
//
// No notification is dispatched. Every asset_* recipient rule in
// assetNotifications.ts deep-links to /assets-access/<id>, and after this there
// is no id left to open.

export function DeleteAssetModal({ asset, supabase, onClose, onDone }: CommonProps) {
  const { saving, error, run } = useSubmit('delete')

  const submit = async () => {
    const ok = await run(() => supabase.rpc('permanently_delete_asset', {
      p_asset_id: asset.id,
    }))
    if (!ok) return
    onDone(`“${asset.asset_name}” has been permanently deleted.`)
  }

  return (
    <AssetModal title="Delete Asset Permanently" onClose={onClose}>
      <div style={{ fontSize: '12px', color: colors.secondary }}>
        {asset.asset_code ? `${asset.asset_name} (${asset.asset_code})` : asset.asset_name}
      </div>
      <div style={{
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '11.5px',
      }}>
        Permanently delete this asset? The asset and its complete assignment, custody,
        service, warranty, and activity history will be erased. This action cannot be undone.
      </div>
      {error && <AssetModalError message={error} />}
      <AssetModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel="Delete Permanently"
        destructive
      />
    </AssetModal>
  )
}
