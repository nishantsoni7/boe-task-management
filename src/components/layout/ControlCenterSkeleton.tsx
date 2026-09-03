// The Control Center's content-pane loading state.
//
// Deliberately NOT <LoadingScreen />. That atom is a 100vh spinner — right for
// the moment before anything at all is on screen, wrong inside a shell that is
// already showing the sidebar and header, where it reads as "leaving the page".
// This fills only the pane, in the shape of what is about to appear (a heading
// and a table), so a section change reads as "loading this section".
//
// Used by src/app/admin/control-center/loading.tsx — the route boundary Next
// shows while a section's chunk loads — and by each section while its own data
// is in flight, so the two states look identical and hand over without a flash.
//
// Static blocks, no animation: nothing in globals.css was touched for this, and
// the shell's own transitions are enough motion for a state that lasts a moment.

const ROWS = 6
const BLOCK = '#E8EBF0'

function Block({ w, h, radius = 4 }: { w: string | number; h: number; radius?: number }) {
  return <div style={{ width: w, height: h, borderRadius: radius, background: BLOCK, flexShrink: 0 }} />
}

export function ControlCenterSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" style={{ maxWidth: 900 }}>
      <Block w={180} h={16} />
      <div style={{ marginTop: 8 }}>
        <Block w={320} h={11} />
      </div>
      <div
        style={{
          marginTop: 20, border: '1px solid #E8EBF0', borderRadius: 10,
          background: '#fff', overflow: 'hidden',
        }}
      >
        {Array.from({ length: ROWS }, (_, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: 16, padding: '13px 12px',
              borderBottom: i < ROWS - 1 ? '1px solid #F0F2F5' : 'none',
            }}
          >
            <Block w="26%" h={11} />
            <Block w="22%" h={11} />
            <Block w="12%" h={11} />
            <Block w="10%" h={18} radius={5} />
          </div>
        ))}
      </div>
    </div>
  )
}
