import type { PiChangeMarker } from '@/lib/orders/piChangeMarker'

/**
 * A PI change is waiting for somebody (Operations' request, 2026-11-14): one pill under Factory Status.
 * The words say what it waits for; amber is "waiting", red is "Operations asked Sales for changes".
 * The rule lives in lib/orders/piChangeMarker.ts — this only draws it.
 */
export function PiChangePill({ marker }: { marker: PiChangeMarker }) {
  return (
    <span className={`orders-pichange orders-pichange--${marker.tone}`} title={marker.title} data-stage={marker.stage}>
      {marker.label}
    </span>
  )
}
