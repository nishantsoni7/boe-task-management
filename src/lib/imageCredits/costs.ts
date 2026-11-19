// What one paid picture press costs. Client-safe (no server imports): the tracking page uses the labels.
//
// `credits` is what the person is charged; 1 credit is about Rs 4. `usd` is what fal bills us for the press, as
// priced when this was written. Update `usd` when the model in src/lib/orders/customizationImage.ts
// (PI_IMAGE_EDIT_MODEL) or the Studio Image pipeline changes, or the tracking page drifts from fal's own bill.

export const CREDIT_TOOLS = ['studio', 'pi_customize', 'quotation_clean', 'quotation_change'] as const
export type CreditTool = (typeof CREDIT_TOOLS)[number]

export const TOOL_LABEL: Record<CreditTool, string> = {
  studio: 'Studio Image',
  pi_customize: 'Customize image (Edit PI)',
  quotation_clean: 'Quotation: Clean up',
  quotation_change: 'Quotation: Change it',
}

export const COST: Record<CreditTool, { credits: number; usd: number }> = {
  studio: { credits: 1, usd: 0.042 }, // Bria Product Shot $0.04 + SeedVR upscale about $0.002
  pi_customize: { credits: 2, usd: 0.08 }, // Nano Banana 2 at 1K
  quotation_clean: { credits: 2, usd: 0.08 },
  quotation_change: { credits: 2, usd: 0.08 },
}
