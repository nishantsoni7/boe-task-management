'use client'

// ── Founders' payouts › Accounts ─────────────────────────────────────────────
//
// The people money is paid to, grouped by whose side they are on: name, role in
// BOE (which decides the tax-free room), and the bank with the LAST digits only —
// the database refuses five digits in a row, so a full account number can never
// be stored. An account that is no longer used is switched off, never deleted:
// its payments stay in the years they belong to.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Pencil } from 'lucide-react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import { FOUNDER_TAX_ROLES, accountsBySide, formatRupees, roleLabel, taxYearLabel, type FounderAccount, type FounderYear } from '@/lib/finance/founderPayouts'
import type { TaxRole } from '@/lib/finance/founderPayoutTax'
import { SideLabel } from './FounderParts'
import { saveFounderAccount } from './founderPayoutsData'
import styles from './founders.module.css'

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
  const groups = accountsBySide(year)

  return (
    <section className={`fin-board ${styles.panel}`} data-testid="founder-accounts">
      <div className={styles.panelHead}>
        <h3>Accounts</h3>
        <p>Everyone money is paid to. The role decides how much they can be paid tax-free.</p>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => setEditing('new')}>Add account</button>
      </div>
      {groups.length === 0 ? (
        <FinanceEmpty icon="box" title="No accounts yet"
          body="Add the accounts money goes into, for example Namrata and Jaishree on your side, and Nitish and his family on his." />
      ) : (
        <div className="fin-table-wrap">
          <table className={`fin-table ${styles.table} ${styles.tableCards}`} style={{ minWidth: 640 }}>
            <colgroup>
              <col />
              <col style={{ width: 260 }} />
              <col style={{ width: 180 }} />
              <col style={{ width: 170 }} />
              <col style={{ width: 60 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role in BOE</th>
                <th scope="col">Bank</th>
                <th scope="col" className="fin-num">Paid in {taxYearLabel(year.taxYear)}</th>
                <th scope="col"><span className="boe-sr-only">Change</span></th>
              </tr>
            </thead>
            {groups.map(({ side, accounts }) => (
              <tbody key={side.side}>
                <tr className={styles.sideRow}>
                  <td colSpan={3}><SideLabel sides={year.sides} side={side.side} count={accounts.length} /></td>
                  <td className={`fin-num ${styles.sideTotal}`}>{formatRupees(side.totalPaise)}</td>
                  <td />
                </tr>
                {/* An account no longer used goes to the bottom of its side. */}
                {[...accounts].sort((a, b) => Number(b.account.isActive) - Number(a.account.isActive)).map(a => (
                  <tr key={a.account.id} className={`${styles.rowOpen}${a.account.isActive ? '' : ` ${styles.accountOff}`}`} tabIndex={0}
                    aria-label={`Change ${a.account.displayName}`} onClick={() => setEditing(a.account)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(a.account) } }}>
                    <td>
                      <span className={styles.name}>{a.account.displayName}</span>
                      {!a.account.isActive && <span className="fin-sub">Not used any more</span>}
                    </td>
                    <td data-l="Role in BOE">
                      {a.account.taxRole === 'unset' ? <span className="fin-pill fin-pill--zero">{roleLabel('unset')}</span> : roleLabel(a.account.taxRole)}
                    </td>
                    <td className={styles.muted} data-l="Bank">{a.account.bankLabel ?? <span className={styles.dash}>–</span>}</td>
                    <td className="fin-num" data-l={`Paid in ${taxYearLabel(year.taxYear)}`}><span className={styles.amount}>{formatRupees(a.totalPaise)}</span></td>
                    <td className={styles.blank}><div className={styles.rowActions}><span className={styles.iconBtn} aria-hidden="true"><Pencil size={15} strokeWidth={1.8} /></span></div></td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {editing && (
        <FounderAccountModal
          supabase={supabase}
          account={editing === 'new' ? null : editing}
          sides={sides}
          onClose={() => setEditing(null)}
          onSaved={async message => { setEditing(null); show(message); await onChanged() }}
        />
      )}
    </section>
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
      <div className={styles.form}>
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span>Name</span>
            <input className="boe-input" maxLength={80} value={name} placeholder="e.g. Namrata" onChange={e => setName(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Whose side</span>
            <input className="boe-input" maxLength={40} list="founder-sides" value={side} placeholder="e.g. Nishant" onChange={e => setSide(e.target.value)} />
            <datalist id="founder-sides">{sides.map(s => <option key={s} value={s} />)}</datalist>
            <small className={styles.muted}>The partner whose share this is.</small>
          </label>
        </div>
        <label className={styles.field}>
          <span>Role in BOE</span>
          <select className="boe-input" value={role} onChange={e => setRole(e.target.value as TaxRole)}>
            {FOUNDER_TAX_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <small className={styles.muted}>{FOUNDER_TAX_ROLES.find(r => r.value === role)?.hint}</small>
        </label>
        <label className={styles.field}>
          <span>Bank and last 4 digits (optional)</span>
          <input className="boe-input" maxLength={40} value={bank} placeholder="e.g. HDFC ··1123" onChange={e => setBank(e.target.value)} />
          {bankHasNumber
            ? <small className={styles.bad}>Type only the last 4 digits, never the full account number.</small>
            : <small className={styles.muted}>Full account numbers are never stored.</small>}
        </label>
        {account && (
          <label className={styles.check}>
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            <span>Still used (switch off to hide it from new payouts; its payments stay)</span>
          </label>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.modalFoot}>
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
