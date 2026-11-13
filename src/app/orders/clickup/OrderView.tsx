// One draft order, drawn: every ClickUp field, the description, the files with
// the date each was uploaded, checklists, comments and status history. Read-only.
// Its own file so a test can draw it without the layout, the router or a fetch.

import { dayIst, formatBytes, inr, orderedFields, statusLabel, whenIst, type DraftOrder } from '@/lib/orders/clickupDrafts'
import styles from './clickupDrafts.module.css'

export function OrderView({ order }: { order: DraftOrder }) {
  const facts = orderedFields(order.fields)
  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.headTitle}>{order.name}</h2>
        <span className={styles.pill}>{statusLabel(order.status)}</span>
        <span className={styles.pill}>Draft, copied from ClickUp</span>
      </div>
      <p className={styles.meta}>
        Assigned to {order.assignees.join(', ') || 'nobody'} · started in ClickUp {whenIst(order.created_in_clickup)}
        {order.created_by_name ? ` by ${order.created_by_name}` : ''} · due {dayIst(order.due_date)}
        {order.tags.length > 0 ? ` · tags: ${order.tags.join(', ')}` : ''}
      </p>

      <section className={styles.card} aria-label="Order details">
        <h3 className={styles.cardTitle}>Client and order details</h3>
        {facts.length === 0 ? <p className="opp-note">ClickUp held no details for this order.</p> : (
          <dl className={styles.facts}>
            {facts.map(([k, v]) => (
              <div key={k} className={styles.fact}><dt>{k}</dt><dd>{k === 'Total Product Value' ? inr(v) : v}</dd></div>
            ))}
          </dl>
        )}
      </section>

      {order.description && (
        <section className={styles.card} aria-label="Description">
          <h3 className={styles.cardTitle}>Description</h3>
          <p className={styles.text}>{order.description}</p>
        </section>
      )}

      <section className={styles.card} aria-label="Files">
        <h3 className={styles.cardTitle}>Files ({order.files.length})</h3>
        {order.files.length === 0 ? <p className="opp-note">No file was attached to this order in ClickUp.</p> : (
          <div className="opp-scroll">
            <table className="opp-table">
              <thead><tr><th>File</th><th>Uploaded</th><th>Uploaded by</th><th className="opp-num">Size</th><th /></tr></thead>
              <tbody>
                {order.files.map(f => (
                  <tr key={f.id}>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{f.name}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{whenIst(f.uploaded_at)}</td>
                    <td>{f.uploaded_by || '—'}</td>
                    <td className="opp-num">{formatBytes(f.size)}</td>
                    <td><a className={styles.fileLink} href={`/api/orders/clickup-drafts/${order.id}/files/${f.id}`}>Download</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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

      {order.status_history && order.status_history.length > 0 && (
        <section className={styles.card} aria-label="Status history">
          <h3 className={styles.cardTitle}>Status history</h3>
          <ul className={styles.checklist}>
            {order.status_history.map((h, i) => <li key={i}>{statusLabel(h.status)} since {whenIst(h.since)}</li>)}
          </ul>
        </section>
      )}

      <p className={styles.meta}>
        ClickUp task {order.clickup_id}{order.clickup_custom_id ? ` (${order.clickup_custom_id})` : ''} · copied into BOE One {whenIst(order.imported_at)}.
      </p>
    </>
  )
}
