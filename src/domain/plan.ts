/**
 * The search itself: given a demand and a policy, find the best set of
 * warehouses.
 *
 * Solved by enumerating all 255 non-empty subsets of the 8 warehouses and
 * scoring each one, rather than by walking nearest-first. With 8 warehouses
 * brute force is free, and it is the difference between correct and plausible.
 * A greedy nearest-first walk picks W07 (Pasuruan, 45 km) for a vaccine order
 * because it is near and has a refrigerated van, then finds only 8 units on the
 * shelf and has to send a second van from further away regardless. Enumerating
 * never makes that mistake, and the rule stays explainable in one sentence:
 * fewest shipments first, then least distance.
 */

import { WAREHOUSES, productById } from "./catalog.ts";
import type { Warehouse } from "./catalog.ts";
import { canCarry } from "./policy.ts";
import type { ColdChainPolicy } from "./policy.ts";

/** One requested product and how many of it. The unit both search and API speak. */
export interface OrderLine {
  productId: string;
  quantity: number;
}

export interface Plan {
  /** Warehouses actually drawn from, in catalog order. */
  used: Warehouse[];
  /** productId, then warehouseId, then quantity taken. */
  lines: Map<string, Map<string, number>>;
  totalDistanceKm: number;
}

export const warehouseLabel = (warehouse: Warehouse) =>
  `${warehouse.id} (${warehouse.city}, ${warehouse.distanceKm} km)`;

export function describePlan(plan: Plan): string {
  const plural = plan.used.length === 1 ? "" : "s";
  return `${plan.used.length} shipment${plural} from ${plan.used.map((w) => w.id).join(" + ")} at ${
    plan.totalDistanceKm
  } km total`;
}

/** Try one candidate subset of warehouses. Null when it cannot cover the demand. */
function planForSubset(
  demand: readonly OrderLine[],
  subset: readonly Warehouse[],
  policy: ColdChainPolicy,
): Plan | null {
  const lines = new Map<string, Map<string, number>>();

  for (const line of demand) {
    const product = productById(line.productId);
    if (!product) return null;

    let remaining = line.quantity;
    // Nearest first within the chosen set, then by id so the split is stable.
    const sources = subset
      .filter((w) => canCarry(w, product, policy) && (w.stock[product.id] ?? 0) > 0)
      .sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));

    const picked = new Map<string, number>();
    for (const warehouse of sources) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, warehouse.stock[product.id] ?? 0);
      if (take > 0) {
        picked.set(warehouse.id, take);
        remaining -= take;
      }
    }
    if (remaining > 0) return null;
    lines.set(product.id, picked);
  }

  // An idle member can never survive: dropping it leaves a smaller feasible
  // subset, and fewer shipments always wins. Filtering anyway keeps the
  // reported shipment list honest if that reasoning ever stops holding.
  const usedIds = new Set<string>();
  for (const picked of lines.values()) for (const id of picked.keys()) usedIds.add(id);
  const used = subset.filter((w) => usedIds.has(w.id));

  return { used, lines, totalDistanceKm: used.reduce((sum, w) => sum + w.distanceKm, 0) };
}

/** Fewest shipments, then least distance, then lowest ids so ties are settled. */
function betterThan(a: Plan, b: Plan): boolean {
  if (a.used.length !== b.used.length) return a.used.length < b.used.length;
  if (a.totalDistanceKm !== b.totalDistanceKm) return a.totalDistanceKm < b.totalDistanceKm;
  return a.used.map((w) => w.id).join() < b.used.map((w) => w.id).join();
}

export function findPlan(
  demand: readonly OrderLine[],
  policy: ColdChainPolicy,
): Plan | null {
  let best: Plan | null = null;
  const limit = 1 << WAREHOUSES.length;
  for (let mask = 1; mask < limit; mask++) {
    const subset = WAREHOUSES.filter((_, i) => (mask & (1 << i)) !== 0);
    const plan = planForSubset(demand, subset, policy);
    if (plan && (best === null || betterThan(plan, best))) best = plan;
  }
  return best;
}

export const combinationCount = () => (1 << WAREHOUSES.length) - 1;
