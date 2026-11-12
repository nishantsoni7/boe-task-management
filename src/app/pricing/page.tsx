import { ComingSoonModule } from '@/components/layout/ComingSoonModule'
import { PriceBook } from '@/components/pricing/PriceBook'

export default function PricingPage() {
  return (
    <ComingSoonModule moduleKey="pricing" title="Pricing" navLabel="Price book">
      <PriceBook />
    </ComingSoonModule>
  )
}
