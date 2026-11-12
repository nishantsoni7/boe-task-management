'use client'

import Link from 'next/link'
import { useWarmOnRest } from '@/hooks/useWarmOnRest'

/**
 * next/link that prefetches its page only once the person shows intent (the
 * pointer RESTING on it, focus, touch), not as soon as it is on screen. A drop-in:
 * `import { IntentLink as Link } from '@/components/ui/IntentLink'`. A prop the
 * caller passes (an explicit `prefetch`, its own handlers) wins over these.
 */
export function IntentLink(props: React.ComponentProps<typeof Link>) {
  const warm = useWarmOnRest()
  return <Link {...warm} {...props} />
}
