/**
 * The public surface of the domain: hand it an order, get back a decision and
 * the reasons for it. No HTTP, no I/O, no clock, no randomness - the same order
 * and the same policy always produce byte-identical output, which is what makes
 * the explanation worth trusting and the behaviour worth testing.
 */

import { PRODUCTS, WAREHOUSES, productById } from "./catalog.ts";
import type { Warehouse } from "./catalog.ts";
import { DEFAULT_POLICY, isColdChainCapable, requireColdChainTransport } from "./policy.ts";
import type { ColdChainPolicy } from "./policy.ts";
import { findPlan } from "./plan.ts";
import type { OrderLine, Plan } from "./plan.ts";
import { buildExplanation, buildRejections, buildUnfilled, buildUnfulfillableExplanation } from "./explain.ts";
import type { Explanation, Rejection, Unfilled } from "./explain.ts";

export type { OrderLine, ColdChainPolicy, Explanation, Rejection, Unfilled };
export { DEFAULT_POLICY, COLD_CHAIN_POLICIES, isColdChainPolicy } from "./policy.ts";
export { PRODUCTS, WAREHOUSES } from "./catalog.ts";

export interface Allocation {
  warehouseId: string;
  city: string;
  distanceKm: number;
  coldChainCapable: boolean;
  fleet: Warehouse["fleet"];
  lines: { productId: string; productName: string; qty: number }[];
}

export interface PolicyInForce {
  coldChain: ColdChainPolicy;
  requireColdChainTransport: boolean;
}

export interface SelectionResult {
  feasible: boolean;
  policy: PolicyInForce;
  shipmentCount: number;
  totalDistanceKm: number;
  allocations: Allocation[];
  rejected: Rejection[];
  unfilled: Unfilled[];
  explanation: Explanation;
}

/** Returns a list of human-readable problems. Empty means the order is usable. */
export function validateOrder(order: unknown): string[] {
  if (!Array.isArray(order) || order.length === 0) {
    return ["items must be a non-empty array of {productId, quantity}"];
  }
  const problems: string[] = [];
  order.forEach((line, index) => {
    const at = `items[${index}]`;
    if (typeof line !== "object" || line === null) {
      problems.push(`${at} must be an object`);
      return;
    }
    const { productId, quantity } = line as Partial<OrderLine>;
    if (typeof productId !== "string" || !productById(productId)) {
      problems.push(`${at}.productId must be one of ${PRODUCTS.map((p) => p.id).join(", ")}`);
    }
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
      problems.push(`${at}.quantity must be a positive whole number`);
    }
  });
  return problems;
}

/** "P001 x5, P001 x7" is the same order as "P001 x12". Sorted so output is stable. */
function mergeLines(order: readonly OrderLine[]): OrderLine[] {
  const merged = new Map<string, number>();
  for (const line of order) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);
  return [...merged.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

function toAllocations(demand: readonly OrderLine[], plan: Plan, policy: ColdChainPolicy): Allocation[] {
  return plan.used.map((warehouse) => ({
    warehouseId: warehouse.id,
    city: warehouse.city,
    distanceKm: warehouse.distanceKm,
    coldChainCapable: isColdChainCapable(warehouse, policy),
    fleet: warehouse.fleet,
    lines: demand
      .filter((line) => (plan.lines.get(line.productId)?.get(warehouse.id) ?? 0) > 0)
      .map((line) => ({
        productId: line.productId,
        productName: productById(line.productId)!.name,
        qty: plan.lines.get(line.productId)!.get(warehouse.id)!,
      })),
  }));
}

/**
 * Decide which warehouse or warehouses fulfil an order.
 *
 * @throws RangeError if the order is not usable. Call {@link validateOrder}
 * first if you would rather have the problems as data than as an exception.
 */
export function selectWarehouses(
  order: readonly OrderLine[],
  policy: ColdChainPolicy = DEFAULT_POLICY,
): SelectionResult {
  const problems = validateOrder(order);
  if (problems.length > 0) throw new RangeError(problems.join("; "));

  const demand = mergeLines(order);
  const inForce: PolicyInForce = {
    coldChain: policy,
    requireColdChainTransport: requireColdChainTransport(policy),
  };

  const unfilled = buildUnfilled(demand, policy);
  if (unfilled.length > 0) {
    return {
      feasible: false,
      policy: inForce,
      shipmentCount: 0,
      totalDistanceKm: 0,
      allocations: [],
      rejected: [],
      unfilled,
      explanation: buildUnfulfillableExplanation(demand, policy, unfilled),
    };
  }

  const plan = findPlan(demand, policy);
  if (!plan) {
    // Unreachable: if every line fits within total eligible stock, the subset of
    // every warehouse is always feasible. Kept so the return type stays honest.
    throw new Error("no plan found for an order that passed the availability check");
  }

  const hasColdLine = demand.some((line) => productById(line.productId)!.coldChain);
  const otherPolicy: ColdChainPolicy = policy === "end-to-end" ? "storage-only" : "end-to-end";
  const alternativePlan = hasColdLine ? findPlan(demand, otherPolicy) : null;

  return {
    feasible: true,
    policy: inForce,
    shipmentCount: plan.used.length,
    totalDistanceKm: plan.totalDistanceKm,
    allocations: toAllocations(demand, plan, policy),
    rejected: buildRejections(demand, plan, policy),
    unfilled: [],
    explanation: buildExplanation(demand, policy, plan, alternativePlan),
  };
}

/** Everything the UI needs to render a picker, so it holds no domain data itself. */
export function describeCatalog() {
  return {
    products: PRODUCTS,
    warehouses: WAREHOUSES.map(({ id, city, distanceKm, coldStorage, fleet }) => ({
      id,
      city,
      distanceKm,
      coldStorage,
      fleet,
    })),
  };
}
