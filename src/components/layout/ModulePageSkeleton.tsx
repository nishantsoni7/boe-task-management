// The Orders and Finance content-pane loading state.
//
// NOT <LoadingScreen />. That atom is a 100vh spinner: right before anything is
// on screen, wrong inside a module whose sidebar and header are already drawn.
// Every Orders and Finance screen used to return it while its first read was in
// flight, so moving between two pages of the same module took the whole shell
// away — sidebar, header, the lot — for as long as the next page's reads took
// (measured: 180 ms to 1.2 s per navigation), and put it back afterwards.
//
// This fills only the page body, in the rough shape of what is about to land,
// so a navigation reads as "this section is loading" rather than "you left".
// It is rendered INSIDE OrdersLayout / FinanceLayout by each page while it
// loads, and by the route-level loading.tsx boundaries while a route's code or
// server payload is still on its way, so the two states look the same and hand
// over without a flash.
//
// Static blocks and no animation, like ControlCenterSkeleton. role="status" +
// aria-busy tell assistive technology something is loading; the blocks
// themselves are hidden from it.

export type ModulePageSkeletonVariant = 'dashboard' | 'list' | 'record'

function Block({ w, h, radius }: { w: string | number; h: number; radius?: number }) {
  return <span aria-hidden="true" className="boe-skel" style={{ width: w, height: h, borderRadius: radius }} />
}

function TableRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="boe-card" style={{ overflow: 'hidden' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: 16, padding: '13px 14px',
            borderBottom: i < rows - 1 ? '1px solid #F0F2F5' : 'none',
          }}
        >
          <Block w="14%" h={11} />
          <Block w="16%" h={11} />
          <Block w="30%" h={11} />
          <Block w="12%" h={18} radius={5} />
        </div>
      ))}
    </div>
  )
}

export function ModulePageSkeleton({
  variant = 'list',
  label = 'Loading',
}: {
  variant?: ModulePageSkeletonVariant
  /** Read by assistive technology, e.g. "Loading PI Drafts". */
  label?: string
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {variant === 'dashboard' && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 12, marginBottom: 20,
          }}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="boe-card" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Block w="60%" h={10} />
                <Block w="40%" h={20} />
              </div>
            ))}
          </div>
          <TableRows rows={4} />
        </>
      )}

      {variant === 'list' && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Block w={220} h={30} radius={8} />
            <Block w={120} h={30} radius={8} />
            <Block w={120} h={30} radius={8} />
          </div>
          <TableRows />
        </>
      )}

      {variant === 'record' && (
        <>
          <Block w={90} h={12} />
          <div className="boe-card" style={{ marginTop: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Block w="45%" h={18} />
            <Block w="70%" h={11} />
            <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
              <Block w={120} h={32} radius={6} />
              <Block w={120} h={32} radius={6} />
              <Block w={120} h={32} radius={6} />
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <TableRows rows={4} />
          </div>
        </>
      )}
    </div>
  )
}
