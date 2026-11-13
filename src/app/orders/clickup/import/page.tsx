'use client'

// IMPORT THE CLICKUP BACKUP FOLDER INTO DRAFT ORDERS. The one-off ClickUp export
// left a folder (orders.json + files/…). This page reads it in the browser, sends
// each file straight to private storage, and then the order's row, one order at a
// time (routes: /api/orders/clickup-drafts/import). Running it again is safe: a
// file already stored with the same size is skipped, and an order is replaced by
// its ClickUp task id. Administrators only (the routes ask again).
// Needs a browser that can open a folder: Chrome or Edge on a computer.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { AppLink } from '@/components/ui/AppLink'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { CLICKUP_DRAFT_BUCKET, findBackupFolder, formatBytes, type BackupDir, type BackupOrder } from '@/lib/orders/clickupDrafts'
import { callDrafts } from '../callDrafts'
import styles from '../clickupDrafts.module.css'

type Upload = { id: string; path: string; token: string }
type Progress = { done: number; total: number; uploaded: number; already: number }

/** Walks "files/<order>/<name>" down from the chosen folder. */
async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/').filter(Boolean)
  let dir = root
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile()
}

export default function ClickupImportPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { profile } = usePermissionContext()
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [orders, setOrders] = useState<BackupOrder[]>([])
  const [scope, setScope] = useState<'all' | 'open'>('all')
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0, uploaded: 0, already: 0 })
  const [problems, setProblems] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const stop = useRef(false)

  // A run that is closed half way is safe to repeat, but say so before it happens.
  useEffect(() => {
    if (!running) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [running])

  const handleSignOut = async () => { await supabase.auth.signOut(); router.replace('/login') }

  const choose = async () => {
    setMessage(null); setFinished(false); setProblems([])
    // Asked here, not while drawing: the server draws this page too, and it has no window.
    if (!('showDirectoryPicker' in window)) { setMessage('This browser cannot open a folder. Use Chrome or Edge on a computer.'); return }
    try {
      const chosen = await (window as unknown as { showDirectoryPicker: (o: { mode: 'read' }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'read' })
      // The Windows folder window easily lands one level up: accept the folder around the backup too.
      const folder = await findBackupFolder(chosen as unknown as BackupDir) as unknown as FileSystemDirectoryHandle | null
      if (!folder) { setMessage('There is no orders.json in that folder, or in a folder inside it. Choose the backup folder.'); return }
      const text = await (await (await folder.getFileHandle('orders.json')).getFile()).text()
      const parsed = JSON.parse(text) as { orders?: BackupOrder[] }
      if (!Array.isArray(parsed.orders) || parsed.orders.length === 0) { setMessage('This folder has no orders in its orders.json.'); return }
      setDir(folder); setOrders(parsed.orders)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setMessage('That folder could not be read. Choose the folder that holds orders.json and the files folder.')
    }
  }

  const picked = scope === 'open' ? orders.filter(o => o.status !== 'dispatched') : orders
  const fileCount = picked.reduce((n, o) => n + (o.files?.length ?? 0), 0)
  const bytes = picked.reduce((n, o) => n + (o.files ?? []).reduce((m, f) => m + (f.bytes ?? 0), 0), 0)

  const putFile = async (u: Upload, file: File) => {
    for (let attempt = 1; ; attempt++) {
      const sent = await supabase.storage.from(CLICKUP_DRAFT_BUCKET).uploadToSignedUrl(u.path, u.token, file)
      if (!sent.error) return
      if (attempt >= 3) throw new Error(sent.error.message)
      await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }

  const start = async () => {
    if (!dir) return
    stop.current = false
    setRunning(true); setFinished(false); setProblems([]); setMessage(null)
    const found: string[] = []
    let done = 0, uploaded = 0, already = 0
    setProgress({ done, total: picked.length, uploaded, already })
    for (const order of picked) {
      if (stop.current) break
      try {
        const files = order.files ?? []
        const signed = await callDrafts<{ uploads: Upload[]; already: number }>('/api/orders/clickup-drafts/import', {
          step: 'sign', clickup_id: order.clickup_id, files: files.map(f => ({ id: f.id, size: f.bytes })),
        })
        if (!signed.ok) throw new Error(signed.message)
        await Promise.all(signed.body.uploads.map(async u => {
          const f = files.find(x => x.id === u.id)
          if (!f) throw new Error('A file is not in the order.')
          const file = await fileAt(dir, f.file)
          if (file.size !== f.bytes) throw new Error(`${f.name} is not the file that was backed up (size differs).`)
          await putFile(u, file)
        }))
        const saved = await callDrafts('/api/orders/clickup-drafts/import', { step: 'save', order })
        if (!saved.ok) throw new Error(saved.message)
        uploaded += signed.body.uploads.length; already += signed.body.already
        done += 1
      } catch (e) {
        found.push(`${order.name}: ${e instanceof Error ? e.message : 'failed'}`)
        // Not set up on this database: every other order would fail the same way.
        if (e instanceof Error && /not set up/i.test(e.message)) break
      }
      setProgress({ done, total: picked.length, uploaded, already })
      setProblems([...found])
    }
    setRunning(false); setFinished(true)
  }

  const pct = progress.total ? Math.round(((progress.done + problems.length) / progress.total) * 100) : 0

  return (
    <OrdersLayout profile={profile} title="Import from ClickUp backup" onSignOut={handleSignOut} showRefresh={false}>
      <div className="opp-page">
        <AppLink href="/orders/clickup" className="opp-back">← Draft Orders (ClickUp)</AppLink>

        <section className={styles.card} aria-label="How it works">
          <h3 className={styles.cardTitle}>Copy the ClickUp backup into Draft Orders</h3>
          <ol className={styles.steps}>
            <li>Choose the backup folder (the one that holds <strong>orders.json</strong> and a <strong>files</strong> folder, or the folder around it).</li>
            <li>Press Start. Each order&apos;s files go to private storage, then the order itself is saved.</li>
            <li>Keep this tab open until it says it is finished. If it stops, run it again: what is already stored is skipped.</li>
          </ol>
          <div>
            <button type="button" className="boe-btn boe-btn-secondary" disabled={running} onClick={() => void choose()}>
              {dir ? 'Choose another folder' : 'Choose backup folder'}
            </button>
          </div>
          {message && <p className="opp-warn" role="alert">{message}</p>}
        </section>

        {dir && (
          <section className={styles.card} aria-label="Ready to import">
            <h3 className={styles.cardTitle}>{orders.length} orders in this folder</h3>
            <label className="opp-field" style={{ maxWidth: 360 }}>
              <span>Which orders</span>
              <select className="boe-input" value={scope} disabled={running} onChange={e => setScope(e.target.value as 'all' | 'open')}>
                <option value="all">All {orders.length} (including dispatched)</option>
                <option value="open">Not dispatched only ({orders.filter(o => o.status !== 'dispatched').length})</option>
              </select>
            </label>
            <p className={styles.meta}>{picked.length} orders · {fileCount} files · {formatBytes(bytes)} to check and upload.</p>
            <div className={styles.bar}>
              <button type="button" className="boe-btn boe-btn-primary" disabled={running || picked.length === 0} onClick={() => void start()}>
                {running ? 'Importing…' : finished ? 'Run again' : 'Start import'}
              </button>
              {running && <button type="button" className="boe-btn boe-btn-secondary" onClick={() => { stop.current = true }}>Stop after this order</button>}
            </div>

            {(running || finished) && (
              <>
                <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                </div>
                <p className={styles.meta} role="status">
                  {progress.done} of {progress.total} orders saved · {progress.uploaded} files uploaded now · {progress.already} already stored
                  {problems.length > 0 ? ` · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : ''}
                </p>
              </>
            )}
            {finished && problems.length === 0 && progress.done === progress.total && (
              <p className="opp-note" role="status">
                Finished: all {progress.done} orders are in Draft Orders. <AppLink href="/orders/clickup" className="opp-link">Open Draft Orders</AppLink>
              </p>
            )}
            {finished && (problems.length > 0 || progress.done < progress.total) && (
              <p className="opp-warn" role="alert">
                {progress.done < progress.total ? 'The import stopped before every order was saved. Run it again to finish.' : 'Some orders were not saved.'}
              </p>
            )}
            {problems.length > 0 && <ul className={styles.problems}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          </section>
        )}
      </div>
    </OrdersLayout>
  )
}
