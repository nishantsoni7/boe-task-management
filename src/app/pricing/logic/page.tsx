import { ComingSoonModule } from '@/components/layout/ComingSoonModule'
import { PriceLogic } from '@/components/pricing/training/PriceLogic'

export default function PricingLogicPage() {
  return (<ComingSoonModule moduleKey="pricing" title="Pricing" navLabel="Price book"><PriceLogic /></ComingSoonModule>)
}
