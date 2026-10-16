/**
 * The rules that decide which warehouse may serve which product.
 *
 * The whole design question in this challenge sits in one sentence: does a
 * vaccine's cold chain have to hold in transit, or only in storage? W02
 * (Surabaya, 12 km) and W06 (Malang, 95 km) have cold storage and hold vaccine
 * stock, but only standard vehicles. W04, W07 and W08 have refrigerated vans.
 * Both readings are defensible, so both are implemented and the caller picks.
 *
 * "end-to-end" (the default) is the stricter and safer reading: unbroken
 * cold chain from the shelf to the customer. "storage-only" is the cheaper
 * reading and puts a vaccine order on W02 at 12 km instead of W04 at 30 km.
 * The selector always reports what the other policy would have said, so the
 * ambiguity is visible in the output rather than hidden in a constant.
 *
 * Deliberately absent: tunable weights. The objective is lexicographic - fewest
 * shipments, then least distance - not a weighted sum. Adding weights would
 * invent precision the data does not support: there is no basis in this
 * dataset for saying a shipment is worth exactly N kilometres, and a made-up
 * number is harder to defend than a stated priority order.
 */

import type { Product, Warehouse } from "./catalog.ts";

export type ColdChainPolicy = "end-to-end" | "storage-only";

export const COLD_CHAIN_POLICIES: readonly ColdChainPolicy[] = ["end-to-end", "storage-only"];
export const DEFAULT_POLICY: ColdChainPolicy = "end-to-end";

export function isColdChainPolicy(value: unknown): value is ColdChainPolicy {
  return typeof value === "string" && (COLD_CHAIN_POLICIES as readonly string[]).includes(value);
}

/** True when transit has to be refrigerated too, not just the shelf. */
export function requireColdChainTransport(policy: ColdChainPolicy): boolean {
  return policy === "end-to-end";
}

/** Whether a warehouse may hold and ship a cold-chain product under this policy. */
export function isColdChainCapable(warehouse: Warehouse, policy: ColdChainPolicy): boolean {
  if (!warehouse.coldStorage) return false;
  return policy === "storage-only" ? true : warehouse.fleet === "refrigerated";
}

/** A product can go anywhere unless it needs a cold chain, in which case the policy applies. */
export function canCarry(warehouse: Warehouse, product: Product, policy: ColdChainPolicy): boolean {
  if (!product.coldChain) return true;
  return isColdChainCapable(warehouse, policy);
}

export function policyText(policy: ColdChainPolicy): string {
  return policy === "end-to-end"
    ? 'Cold-chain policy "end-to-end": a cold-chain line must be stored cold AND delivered in a refrigerated van.'
    : 'Cold-chain policy "storage-only": a cold-chain line only needs a warehouse with cold storage; the vehicle type is ignored.';
}
