import { QuotationsRouteFallback } from '@/components/quotations/QuotationsRouteFallback'

// The quotation route, while its code or its server payload is on the way: the Quotations shell and a skeleton body,
// not a blank page and not the full-page spinner (which fades in only after 0.8 s). It sits INSIDE the Quotations
// layout (src/app/quotations/layout.tsx), so nothing here renders before module access is decided, and it reads no data.
export default function QuotationLoading() {
  return <QuotationsRouteFallback />
}
