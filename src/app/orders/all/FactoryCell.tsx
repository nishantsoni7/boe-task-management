import type { FactoryView } from '@/lib/orders/orderListValue'

/**
 * Factory Status (owner, 2026-11-03): where the Order is, then how much of it
 * has left. Only what still needs someone is loud (owner, 2026-10-31): Not
 * Aligned, On hold and Ready for dispatch are pills; Aligned and Dispatched are a
 * dot and a word. The line under it is plain text, never a pill, so a row with a
 * part dispatch stays two lines tall like the Client cell beside it.
 */
export function FactoryCell({ view }: { view: FactoryView }) {
  const word =
    view.tone === 'aligned' ? <span className="orders-status-ok">{view.label}</span>
    : view.tone === 'dispatched' ? <span className="orders-status-done">{view.label}</span>
    : view.tone === 'ready' ? <span className="fin-pill fin-pill--full">{view.label}</span>
    : <span className="fin-pill fin-pill--zero">{view.label}</span>
  return (
    <>
      {word}
      {view.note && (
        <span className={`orders-dispatch${view.tone === 'dispatched' ? ' orders-dispatch--done' : ''}`}>
          <span className="fin-sub">{view.note}</span>
        </span>
      )}
    </>
  )
}
