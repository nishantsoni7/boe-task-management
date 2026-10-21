'use client'

// ── Upload a bank statement: choose, check, import ──────────────────────────
//
// Step 1  the file is read on the server (/api/finance/bank/parse), which
//         writes nothing and answers with what importing it would do.
// Step 2  the owner sees the account, the period, the counts and the checks,
//         and presses Import. Only then does import_bank_statement run.
//
// Uploading the same period twice, or an overlapping one, is safe: lines the
// database already holds are skipped, never duplicated.

import { useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL, type BankAccountKey, type ParsedBankLine } from '@/lib/finance/bankStatement'
import { samePaise } from '@/lib/finance/bankMoney'
import { formatBankDate, monthOf, rpcMessage } from './bankStatementsModel'

type ParseResponse = {
  ok: true
  fileName: string
  accountNumber: string
  accountLast4: string
  statement: {
    periodFrom: string
    periodTo: string
    openingBalance: number
    closingBalance: number
    lines: ParsedBankLine[]
  }
  preview: {
    known_account: BankAccountKey | null
    total_lines: number
    existing_lines: number
    new_lines: number
    stored_balance_before: number | null
    stored_balance_date: string | null
  }
}

type Failure = { ok: false; message: string }

export function BankUploadModal({ supabase, onClose, onImported }: {
  supabase: SupabaseClient
  onClose: () => void
  onImported: (account: BankAccountKey, month: string, message: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParseResponse | null>(null)
  const [chosen, setChosen] = useState<BankAccountKey | null>(null)

  const read = async (f: File, account: BankAccountKey | null) => {
    setBusy('reading')
    setError(null)
    setParsed(null)
    try {
      const body = new FormData()
      body.append('file', f)
      if (account) body.append('account', account)
      const res = await fetch('/api/finance/bank/parse', { method: 'POST', body })
      const json = (await res.json()) as ParseResponse | Failure
      if (!json.ok) { setError(json.message); return }
      setParsed(json)
    } catch {
      setError('The file could not be sent. Check your connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  const pick = (f: File | undefined) => {
    if (!f) return
    setFile(f)
    setChosen(null)
    void read(f, null)
  }

  const account: BankAccountKey | null = parsed?.preview.known_account ?? chosen
  const needsChoice = parsed !== null && parsed.preview.known_account === null

  const choose = (a: BankAccountKey) => {
    setChosen(a)
    if (file) void read(file, a)
  }

  const doImport = async () => {
    if (!parsed || !account) return
    setBusy('importing')
    setError(null)
    const { data, error: err } = await supabase.rpc('import_bank_statement', {
      p_account: account,
      p_account_number: parsed.accountNumber,
      p_period_from: parsed.statement.periodFrom,
      p_period_to: parsed.statement.periodTo,
      p_opening_balance: parsed.statement.openingBalance,
      p_closing_balance: parsed.statement.closingBalance,
      p_file_name: parsed.fileName,
      p_lines: parsed.statement.lines,
    })
    setBusy(null)
    if (err) { setError(rpcMessage(err, 'The statement could not be imported.')); return }
    const added = (data as { new_lines?: number } | null)?.new_lines ?? 0
    onImported(account, monthOf(parsed.statement.periodTo), `${added} new line${added === 1 ? '' : 's'} imported into ${BANK_ACCOUNT_LABEL[account]}`)
  }

  const s = parsed?.statement
  const credits = s ? s.lines.filter(l => l.deposit > 0) : []
  const debits = s ? s.lines.filter(l => l.withdrawal > 0) : []
  const sum = (ls: ParsedBankLine[], k: 'deposit' | 'withdrawal') => ls.reduce((a, l) => a + Math.round(l[k] * 100), 0) / 100
  const continuity = parsed && parsed.preview.stored_balance_before !== null && s
    ? samePaise(parsed.preview.stored_balance_before, s.openingBalance)
    : null

  return (
    <FinanceModal title="Upload bank statement" onClose={onClose} width="600px" closeOnBackdropClick={busy === null && parsed === null}>
      <div
        className={`bank-drop${dragging ? ' is-dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0]) }}
      >
        <input ref={inputRef} type="file" accept=".xls,.xlsx" hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
        <div className="bank-drop-title">{file ? file.name : 'Drop the HDFC statement here, or click to choose'}</div>
        <div className="fin-muted" style={{ fontSize: 12 }}>The .xls file from NetBanking. Either account; overlapping periods are fine.</div>
      </div>

      {busy === 'reading' && <p className="fin-muted" style={{ margin: 0 }}>Reading the statement…</p>}
      {error && <div role="alert" className="bank-error">{error}</div>}

      {parsed && s && (
        <section className="bank-section">
          <h3>
            {account ? BANK_ACCOUNT_LABEL[account] : 'Which account is this?'}
            <span className="fin-muted" style={{ fontWeight: 400 }}> · account ending {parsed.accountLast4}</span>
          </h3>

          {needsChoice && (
            <div className="bank-choice">
              <span className="fin-muted" style={{ fontSize: 13 }}>
                This account number is new to the app. Choose which of your two accounts it is — it is remembered for next time.
              </span>
              <button className={`boe-btn ${chosen === 'hdfc' ? 'boe-btn-primary' : 'boe-btn-ghost'}`} onClick={() => choose('hdfc')}>HDFC PRI (main)</button>
              <button className={`boe-btn ${chosen === 'hdfc_sec' ? 'boe-btn-primary' : 'boe-btn-ghost'}`} onClick={() => choose('hdfc_sec')}>HDFC SEC (petty cash)</button>
            </div>
          )}

          <dl className="bank-summary">
            <div><dt>Period</dt><dd>{formatBankDate(s.periodFrom)} – {formatBankDate(s.periodTo)}</dd></div>
            <div><dt>Lines</dt><dd>{parsed.preview.total_lines}</dd></div>
            <div><dt>Money in</dt><dd>{credits.length} · {formatMoney(sum(credits, 'deposit'))}</dd></div>
            <div><dt>Money out</dt><dd>{debits.length} · {formatMoney(sum(debits, 'withdrawal'))}</dd></div>
            <div><dt>Opening → closing</dt><dd>{formatMoney(s.openingBalance)} → {formatMoney(s.closingBalance)}</dd></div>
          </dl>

          <ul className="bank-checks">
            <li className="ok">Every balance adds up to the paisa.</li>
            {continuity === true && <li className="ok">Opening balance equals the stored closing balance of {formatBankDate(parsed.preview.stored_balance_date!)}.</li>}
            {continuity === false && (
              <li className="warn">
                The opening balance ({formatMoney(s.openingBalance)}) differs from the stored balance before it ({formatMoney(parsed.preview.stored_balance_before)}).
                A statement between them may be missing.
              </li>
            )}
            {account && parsed.preview.existing_lines > 0 && (
              <li>{parsed.preview.existing_lines} line{parsed.preview.existing_lines === 1 ? ' is' : 's are'} already stored and will be skipped.</li>
            )}
            {account && <li><strong>{parsed.preview.new_lines} new line{parsed.preview.new_lines === 1 ? '' : 's'}</strong> will be added.</li>}
          </ul>

          <div className="bank-actions">
            <button className="boe-btn boe-btn-ghost" onClick={onClose} disabled={busy === 'importing'}>Cancel</button>
            <button
              className="boe-btn boe-btn-primary"
              disabled={busy !== null || !account || parsed.preview.new_lines === 0}
              onClick={doImport}
            >
              {busy === 'importing' ? 'Importing…' : parsed.preview.new_lines === 0 && account ? 'Nothing new to import' : 'Import statement'}
            </button>
          </div>
        </section>
      )}
    </FinanceModal>
  )
}
