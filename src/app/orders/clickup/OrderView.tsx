// One draft order, drawn (redesigned 2026-11-17, owner, second of two pull requests; the list came first):
// a row saying where the order stands (the page title above names the order and the client); one strip of the figures people ask for (value,
// dates, who, how many files and comments); the PI sheet / quotation as the main block when there is one; then
// two columns: the order's and the client's ClickUp fields, the description, checklists and comments beside the
// files and the status history. Read-only. Its own file so a test can draw it without the layout, the router or a fetch.

import type { ReactNode } from 'react'
import {
  approvalChip, dayIst, fieldLabel, formatBytes, groupedFields, inr, statusLabel, statusTone, whenIst, type DraftOrder,
} from '@/lib/orders/clickupDrafts'
import styles from './clickupDrafts.module.css'

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.stat}><dt>{label}</dt><dd>{value}</dd></div>
)

/** One field's value: the money in rupees, fabric and finish as the same soft pills the list uses. */
function FieldValue({ name, value }: { name: string; value: string }) {
  if (name === 'Total Product Value') return <>{inr(value)}</>
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return <>{dayIst(value)}</>
  const chip = name === 'FABRIC STATUS' ? approvalChip(value, 'fabric') : name === 'FINISH STATUS' ? approvalChip(value, 'finish') : null
  return chip ? <span className={`fin-pill fin-pill--${chip.tone}`}>{chip.label}</span> : <>{value}</>
}

/** `piSheet` is the PI sheet list, drawn right under the figures (the page passes it; a test leaves it out). */
export function OrderView({ order, piSheet }: { order: DraftOrder; piSheet?: ReactNode }) {
  const groups = groupedFields(order.fields)
  return (
    <>
      {/* The page title above already says the order number and the client; this row says where the order stands. */}
      <header className={styles.orderHead}>
        <div className={styles.orderPills}>
          <span className={`fin-pill fin-pill--${statusTone(order.status)}`}>{statusLabel(order.status)}</span>
          <span className="fin-pill fin-pill--neutral">Draft, copied from ClickUp</span>
        </div>
      </header>
      <p className={styles.meta}>
        Started in ClickUp {whenIst(order.created_in_clickup)}{order.created_by_name ? ` by ${order.created_by_name}` : ''}
        {order.tags.length > 0 ? ` · tags: ${order.tags.join(', ')}` : ''}
      </p>

      <dl className={styles.strip} aria-label="Order at a glance">
        <Stat label="Value" value={inr(order.fields['Total Product Value'])} />
        <Stat label="Confirm date" value={dayIst(order.fields['Confirm Date'] ?? null)} />
        <Stat label="Due" value={dayIst(order.due_date)} />
        <Stat label="Assigned" value={order.assignees.join(', ') || 'Nobody'} />
        <Stat label="Files" value={String(order.files.length)} />
        <Stat label="Comments" value={String(order.comments.length)} />
      </dl>

      {piSheet}

      <div className={styles.cols}>
        <div className={styles.col}>
          {groups.length === 0 && (
            <section className={styles.card} aria-label="Order details">
              <h3 className={styles.cardTitle}>Order details</h3>
              <p className="opp-note">ClickUp held no details for this order.</p>
            </section>
          )}
          {groups.map(g => (
            <section key={g.key} className={styles.card} aria-label={g.title}>
              <h3 className={styles.cardTitle}>{g.title}</h3>
              <dl className={styles.rows}>
                {g.entries.map(([k, v]) => (
                  <div key={k} className={styles.row}><dt>{fieldLabel(k)}</dt><dd><FieldValue name={k} value={v} /></dd></div>
                ))}
              </dl>
            </section>
          ))}

          {order.description && (
            <section className={styles.card} aria-label="Description">
              <h3 className={styles.cardTitle}>Description</h3>
              <p className={styles.text}>{order.description}</p>
            </section>
          )}

          {order.checklists.length > 0 && (
            <section className={styles.card} aria-label="Checklists">
              <h3 className={styles.cardTitle}>Checklists</h3>
              {order.checklists.map((c, i) => (
                <div key={i}>
                  <strong>{c.name}</strong>
                  <ul className={styles.checklist}>
                    {c.items.map((item, j) => <li key={j} className={item.resolved ? styles.done : undefined}>{item.name}</li>)}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <section className={styles.card} aria-label="Comments">
            <h3 className={styles.cardTitle}>Comments ({order.comments.length})</h3>
            {order.comments.length === 0 ? <p className="opp-note">No comments.</p> : (
              <ul className={styles.thread}>
                {order.comments.map(c => (
                  <li key={c.id} className={`${styles.comment}${c.reply_to ? ` ${styles.reply}` : ''}`}>
                    <div className={styles.commentHead}><strong>{c.by || 'Unknown'}</strong> · {whenIst(c.at)}</div>
                    <p className={styles.text}>{c.text || '(a file only)'}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className={styles.col}>
          <section className={styles.card} aria-label="Files">
            <h3 className={styles.cardTitle}>Files ({order.files.length})</h3>
            {order.files.length === 0 ? <p className="opp-note">No file was attached to this order in ClickUp.</p> : (
              <ul className={styles.fileList}>
                {order.files.map(f => (
                  <li key={f.id} className={styles.fileRow}>
                    <div className={styles.fileMain}>
                      <span className={styles.fileName}>{f.name}</span>
                      <span className={styles.fileMeta}>{whenIst(f.uploaded_at)} · {f.uploaded_by || '—'} · {formatBytes(f.size)}</span>
                    </div>
                    <a className={`boe-btn boe-btn-secondary ${styles.dl}`} href={`/api/orders/clickup-drafts/${order.id}/files/${f.id}`} aria-label={`Download ${f.name}`}>Download</a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {order.status_history && order.status_history.length > 0 && (
            <section className={styles.card} aria-label="Status history">
              <h3 className={styles.cardTitle}>Status history</h3>
              <ul className={styles.checklist}>
                {order.status_history.map((h, i) => <li key={i}>{statusLabel(h.status)} since {whenIst(h.since)}</li>)}
              </ul>
            </section>
          )}
        </div>
      </div>

      <p className={styles.meta}>
        ClickUp task {order.clickup_id}{order.clickup_custom_id ? ` (${order.clickup_custom_id})` : ''} · copied into BOE One {whenIst(order.imported_at)}.
      </p>
    </>
  )
}
