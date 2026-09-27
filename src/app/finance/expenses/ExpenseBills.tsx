'use client'

// ── Bills and invoices on an expense ─────────────────────────────────────────
//
// THE PAYMENT-PROOF PATTERN, applied to expenses (20270205120000 §5):
//
//   1. the file goes into the PRIVATE bucket under {expense}/{random}.{ext};
//   2. a row in expense_bill_attachments names it;
//   3. if (2) fails, (1) is removed — the uploader may delete their own upload
//      that no row names, and nothing else.
//
// A file is opened through a signed URL that lives two minutes, never a public
// URL. Whether it opens at all is the storage rule's decision: whoever may read
// the expense. A bill is optional — nothing here or in the database requires one.

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { createClient } from '@/lib/supabase/client'
import {
  EXPENSE_BILL_ACCEPT,
  EXPENSE_BILL_BUCKET,
  EXPENSE_BILL_URL_TTL_SECONDS,
  billDisplayName,
  billFileProblem,
  billStoragePath,
  formatFileSize,
  type ExpenseBillRow,
} from '@/lib/finance/expenseReimbursements'

type Supabase = ReturnType<typeof createClient>

const BILL_COLUMNS = 'id, expense_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, created_at, removed_at'

/**
 * Upload one bill and record it. Returns null on success, or what went wrong in
 * words. Never leaves an unrecorded file behind if it can help it.
 */
export async function uploadExpenseBill(
  supabase: Supabase,
  expenseId: string,
  file: File,
  userId: string,
): Promise<string | null> {
  const problem = billFileProblem(file)
  if (problem) return problem
  const path = billStoragePath(expenseId, crypto.randomUUID(), file.type)
  const { error: uploadError } = await supabase.storage.from(EXPENSE_BILL_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) return `${file.name} could not be uploaded.`
  const { error: rowError } = await supabase.from('expense_bill_attachments').insert({
    expense_id: expenseId,
    storage_path: path,
    file_name: billDisplayName(file.name),
    mime_type: file.type,
    size_bytes: file.size,
    uploaded_by: userId,
  })
  if (rowError) {
    // Compensation: the file is not left in the bucket with nothing naming it.
    await supabase.storage.from(EXPENSE_BILL_BUCKET).remove([path])
    return rowError.code === '42501'
      ? `${file.name}: you cannot attach bills to this expense.`
      : `${file.name} could not be saved.`
  }
  return null
}

async function openBill(supabase: Supabase, bill: ExpenseBillRow, download: boolean): Promise<string | null> {
  const { data, error } = await supabase.storage.from(EXPENSE_BILL_BUCKET)
    .createSignedUrl(bill.storage_path, EXPENSE_BILL_URL_TTL_SECONDS, download ? { download: bill.file_name } : undefined)
  if (error || !data?.signedUrl) return `${bill.file_name} could not be opened.`
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  return null
}

type UploadStatus = { key: string; name: string; state: 'uploading' | 'done' | 'failed'; message?: string }

/** The bills already on an expense: list, view, download, add, remove. */
export function ExpenseBills({
  supabase,
  expenseId,
  userId,
  mayAttach,
  mayRemove = mayAttach,
  reimbursed,
  personName,
  onChanged,
}: {
  supabase: Supabase
  expenseId: string
  userId: string
  /** May ADD a bill — can_add_expense_bill(): the author, finance.manage, or the named payer. */
  mayAttach: boolean
  /** May REMOVE one — can_attach_expense_bill(): the author or finance.manage only. */
  mayRemove?: boolean
  /** A reimbursed expense's bills cannot be removed (the database refuses it too). */
  reimbursed: boolean
  personName: (id: string) => string
  onChanged?: (liveCount: number) => void
}) {
  const [bills, setBills] = useState<ExpenseBillRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<UploadStatus[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const onChangedRef = useRef(onChanged)
  useEffect(() => { onChangedRef.current = onChanged }, [onChanged])

  const fetchBills = useCallback(async (): Promise<ExpenseBillRow[] | null> => {
    const { data, error: readError } = await supabase
      .from('expense_bill_attachments')
      .select(BILL_COLUMNS)
      .eq('expense_id', expenseId)
      .is('removed_at', null)
      .order('created_at', { ascending: true })
    return readError ? null : ((data ?? []) as ExpenseBillRow[])
  }, [supabase, expenseId])

  const apply = useCallback((list: ExpenseBillRow[] | null) => {
    if (list === null) {
      setError('The bills could not be loaded.')
      setBills([])
    } else {
      setBills(list)
      setError(null)
      onChangedRef.current?.(list.length)
    }
    setLoading(false)
  }, [])

  const load = useCallback(async () => { apply(await fetchBills()) }, [fetchBills, apply])

  useEffect(() => {
    let live = true
    void fetchBills().then(list => { if (live) apply(list) })
    return () => { live = false }
  }, [fetchBills, apply])

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || busy) return
    setBusy(true)
    const batch: UploadStatus[] = files.map(f => ({ key: crypto.randomUUID(), name: f.name, state: 'uploading' }))
    setUploads(prev => [...prev.filter(u => u.state === 'failed'), ...batch])
    for (let i = 0; i < files.length; i++) {
      const message = await uploadExpenseBill(supabase, expenseId, files[i], userId)
      setUploads(prev => prev.map(u => u.key === batch[i].key
        ? { ...u, state: message ? 'failed' : 'done', message: message ?? undefined }
        : u))
    }
    await load()
    setBusy(false)
  }

  const remove = async (bill: ExpenseBillRow) => {
    if (busy) return
    if (!window.confirm(`Remove ${bill.file_name}? It stays in the history but is no longer shown.`)) return
    setBusy(true)
    const { data, error: removeError } = await supabase.from('expense_bill_attachments')
      .update({ removed_by: userId, removed_at: new Date().toISOString() })
      .eq('id', bill.id)
      .is('removed_at', null)
      .select('id')
    if (removeError || (data?.length ?? 0) === 0) {
      setError(removeError?.message?.includes('reimbursed')
        ? 'The bills of a reimbursed expense cannot be removed.'
        : `${bill.file_name} could not be removed.`)
    }
    await load()
    setBusy(false)
  }

  const act = async (bill: ExpenseBillRow, download: boolean) => {
    const message = await openBill(supabase, bill, download)
    if (message) setError(message)
  }

  return (
    <div data-testid="expense-bills" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {loading ? (
        <div style={{ fontSize: '12px', color: colors.muted }}>Loading bills…</div>
      ) : bills.length === 0 ? (
        <div style={{ fontSize: '12px', color: colors.muted }}>No bill attached.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {bills.map(bill => (
            <li key={bill.id} style={{
              display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
              padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: '8px',
            }}>
              <FileText size={15} strokeWidth={1.8} color={colors.tertiary} aria-hidden="true" style={{ flexShrink: 0 }} />
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                <div style={{ fontSize: '12.5px', color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={bill.file_name}>
                  {bill.file_name}
                </div>
                <div style={{ fontSize: '11px', color: colors.muted }}>
                  {formatFileSize(bill.size_bytes)} · {personName(bill.uploaded_by)} · Uploaded
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: '36px', padding: '4px 10px', fontSize: '12px' }}
                  onClick={() => void act(bill, false)} aria-label={`View ${bill.file_name}`}>View</button>
                <button type="button" className="boe-btn boe-btn-ghost" style={{ minHeight: '36px', padding: '4px 10px', fontSize: '12px' }}
                  onClick={() => void act(bill, true)} aria-label={`Download ${bill.file_name}`}>Download</button>
                {mayRemove && !reimbursed && (
                  <button type="button" className="boe-btn boe-btn-ghost" disabled={busy}
                    style={{ minHeight: '36px', padding: '4px 8px', fontSize: '12px', color: '#C13030' }}
                    onClick={() => void remove(bill)} aria-label={`Remove ${bill.file_name}`} title="Remove">
                    <X size={14} strokeWidth={2} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <UploadStatusList uploads={uploads} />

      {error && <div role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{error}</div>}

      {mayAttach && (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={EXPENSE_BILL_ACCEPT}
            style={{ display: 'none' }}
            aria-hidden="true"
            tabIndex={-1}
            onChange={e => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              void addFiles(files)
            }}
          />
          <button type="button" className="boe-btn boe-btn-ghost" disabled={busy}
            style={{ alignSelf: 'flex-start', minHeight: '40px', fontSize: '12.5px' }}
            onClick={() => inputRef.current?.click()}>
            <Paperclip size={14} strokeWidth={2} style={{ marginRight: '6px', verticalAlign: '-2px' }} />
            {busy ? 'Uploading…' : 'Add bill'}
          </button>
        </>
      )}
    </div>
  )
}

export function UploadStatusList({ uploads }: { uploads: readonly UploadStatus[] }) {
  if (uploads.length === 0) return null
  return (
    <ul aria-live="polite" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
      {uploads.map(u => (
        <li key={u.key} style={{ fontSize: '11.5px', color: u.state === 'failed' ? '#C13030' : colors.tertiary }}>
          {u.state === 'uploading' ? `Uploading ${u.name}…` : u.state === 'done' ? `${u.name} uploaded` : (u.message ?? `${u.name} failed`)}
        </li>
      ))}
    </ul>
  )
}

/**
 * Files chosen on the Add form BEFORE the expense exists. They are uploaded
 * after the expense is saved, because the key names the expense.
 */
export function PendingBillPicker({
  files,
  onChange,
  disabled,
}: {
  files: readonly File[]
  onChange: (files: File[]) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const problems = files.map(billFileProblem).filter((p): p is string => p !== null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {files.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: colors.secondary }}>
              <FileText size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
              <span style={{ color: colors.muted, flexShrink: 0 }}>{formatFileSize(file.size)}</span>
              <button type="button" className="boe-btn boe-btn-ghost" disabled={disabled}
                style={{ minHeight: '32px', padding: '2px 8px' }}
                onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`Remove ${file.name}`}>
                <X size={13} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problems.map(p => <div key={p} role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{p}</div>)}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={EXPENSE_BILL_ACCEPT}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
        onChange={e => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          onChange([...files, ...picked])
        }}
      />
      <button type="button" className="boe-btn boe-btn-ghost" disabled={disabled}
        style={{ alignSelf: 'flex-start', minHeight: '40px', fontSize: '12.5px' }}
        onClick={() => inputRef.current?.click()}>
        <Paperclip size={14} strokeWidth={2} style={{ marginRight: '6px', verticalAlign: '-2px' }} />
        Attach bill
      </button>
    </div>
  )
}
