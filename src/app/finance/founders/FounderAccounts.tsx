'use client'

// ── Founders' payouts › Accounts ─────────────────────────────────────────────
//
// The people money is paid to: name, whose side, role in BOE (which decides the
// tax-free room), and the bank with the LAST digits only — the database refuses
// five digits in a row, so a full account number can never be stored. An
// account that is no longer used is switched off, never deleted: its payments
// stay in the years they belong to.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import { FOUNDER_TAX_ROLES, formatRupees, roleLabel, taxYearLabel, type FounderAccount, type FounderYear } from '@/lib/finance/founderPayouts'
import type { TaxRole } from '@/lib/finance/founderPayoutTax'
import { saveFounderAccount } from './founderPayoutsData'

const rolePill: Record<TaxRole, string> = {
  working_partner: 'partial',
  employee: 'partial',
  family: 'neutral',
  unset: 'zero',
}

export function FounderRolePill({ role }: { role: TaxRole }) {
  return <span className={`fin-pill fin-pill--${rolePill[role]}`}>{roleLabel(role)}</span>
}

export function FounderAccounts({
  supabase,
  year,
  sides,
  onChanged,
  show,
}: {
  supabase: SupabaseClient
  year: FounderYear
  sides: string[]
  onChanged: () => Promise<void>
  show: (message: string, variant?: 'success' | 'error') => void
}) {
  const [editing, setEditing] = useState<FounderAccount | 'new' | null>(null)

  return (
    <div data-testid="founder-accounts">
      <div className="fp-section-head">
        <p className="fin-muted">Everyone money is paid to. The role decides how much they can be paid tax-free.</p>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => setEditing('new')}>Add account</button>
      </div>
      <div className="fin-board">
        {year.accounts.length === 0 ? (
          <FinanceEmpty icon="box" title="No accounts yet"
            body="Add the accounts money goes into, for example Namrata and Jaishree on your side, and Nitish and his family on his." />
        ) : (
          <table className="fin-table" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Whose side</th>
                <th>Role in BOE</th>
                <th>Bank</th>
                <th className="fin-num">Paid in {taxYearLabel(year.taxYear)}</th>
              </tr>
            </thead>
            <tbody>
              {year.accounts.map(a => (
                <tr key={a.account.id} tabIndex={0} onClick={() => setEditing(a.account)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(a.account) } }}>
                  <td>
                    <span className="fin-primary-text">{a.account.displayName}</span>
                    {!a.account.isActive && <span className="fin-sub">Not used any more</span>}
                  </td>
                  <td>{a.account.side}</td>
                  <td><FounderRolePill role={a.account.taxRole} /></td>
                  <td className="fin-muted">{a.account.bankLabel ?? '—'}</td>
                  <td className="fin-num"><span className="fin-amount">{formatRupees(a.totalPaise)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <FounderAccountModal
          supabase={supabase}
          account={editing === 'new' ? null : editing}
          sides={sides}
          onClose={() => setEditing(null)}
          onSaved={async message => { setEditing(null); show(message); await onChanged() }}
        />
      )}
    </div>
  )
}

function FounderAccountModal({
  supabase,
  account,
  sides,
  onClose,
  onSaved,
}: {
  supabase: SupabaseClient
  account: FounderAccount | null
  sides: string[]
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const [name, setName] = useState(account?.displayName ?? '')
  const [side, setSide] = useState(account?.side ?? sides[0] ?? '')
  const [role, setRole] = useState<TaxRole>(account?.taxRole ?? 'unset')
  const [bank, setBank] = useState(account?.bankLabel ?? '')
  const [active, setActive] = useState(account?.isActive ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bankHasNumber = /\d{5}/.test(bank)
  const ready = name.trim() !== '' && side.trim() !== '' && !bankHasNumber

  const save = async () => {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    try {
      await saveFounderAccount(supabase, { id: account?.id ?? null, displayName: name, side, taxRole: role, bankLabel: bank, isActive: active })
      await onSaved(account ? `${name.trim()} saved` : `${name.trim()} added`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The account could not be saved. Try again.')
      setSaving(false)
    }
  }

  return (
    <FinanceModal title={account ? `Change ${account.displayName}` : 'Add an account'} onClose={onClose} width="480px" closeOnBackdropClick={false}>
      <div className="fp-form">
        <label className="fp-field">
          <span>Name</span>
          <input className="boe-input" maxLength={80} value={name} placeholder="e.g. Namrata" onChange={e => setName(e.target.value)} />
        </label>
        <label className="fp-field">
          <span>Whose side</span>
          <input className="boe-input" maxLength={40} list="founder-sides" value={side} placeholder="e.g. Nishant" onChange={e => setSide(e.target.value)} />
          <datalist id="founder-sides">{sides.map(s => <option key={s} value={s} />)}</datalist>
          <small className="fin-muted">The partner whose share money into this account is.</small>
        </label>
        <label className="fp-field">
          <span>Role in BOE</span>
          <select className="boe-input" value={role} onChange={e => setRole(e.target.value as TaxRole)}>
            {FOUNDER_TAX_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <small className="fin-muted">{FOUNDER_TAX_ROLES.find(r => r.value === role)?.hint}</small>
        </label>
        <label className="fp-field">
          <span>Bank and last 4 digits (optional)</span>
          <input className="boe-input" maxLength={40} value={bank} placeholder="e.g. HDFC ··1123" onChange={e => setBank(e.target.value)} />
          {bankHasNumber
            ? <small className="fp-bad">Type only the last 4 digits, never the full account number.</small>
            : <small className="fin-muted">Full account numbers are never stored.</small>}
        </label>
        {account && (
          <label className="fp-check">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            <span>Still used (switch off to hide it from new payouts; its payments stay)</span>
          </label>
        )}
        {error && <p className="fp-error" role="alert">{error}</p>}
        <div className="fp-modal-foot">
          <span />
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={!ready || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : account ? 'Save' : 'Add account'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}
