/**
 * Turning a decision into an explanation.
 *
 * Kept apart from the search on purpose. The brief asks for the decision "along
 * with a brief explanation of why", and an explanation that is assembled from
 * typed reason codes is a thing you can assert on in a test - "W02 must be
 * rejected with cold-chain-van-missing" - where a hand-built sentence is only a
 * thing you can read and hope about. The codes are for the UI and the tests;
 * the message next to each one is for the person reading the screen.
 */

import { WAREHOUSES, productById } from "./catalog.ts";
import type { Warehouse } from "./catalog.ts";
import { canCarry, isColdChainCapable, policyText } from "./policy.ts";
import type { ColdChainPolicy } from "./policy.ts";
import { combinationCount, describePlan, warehouseLabel } from "./plan.ts";
import type { OrderLine, Plan } from "./plan.ts";

export type RejectionCode =
  /** Stocks a cold-chain line from this order, but has no cold storage at all. */
  | "cold-storage-missing"
  /** Has cold storage but only a standard fleet, and the policy wants transit cold too. */
  | "cold-chain-van-missing"
  /** Holds none of the products in this order. */
  | "no-stock-of-order"
  /** Eligible and stocked, but the chosen set already does better. */
  | "not-needed";

export interface Rejection {
  warehouseId: string;
  code: RejectionCode;
  reason: string;
}

export interface Unfilled {
  productId: string;
  productName: string;
  code: "insufficient-stock";
  qtyRequested: number;
  qtyShort: number;
  qtyAvailable: number;
}

export interface Explanation {
  summary: string;
  policy: string;
  steps: string[];
  alternativePolicy?: {
    policy: ColdChainPolicy;
    summary: string;
    sameAsChosen: boolean;
  };
}

const fleetText = (warehouse: Warehouse) =>
  warehouse.fleet === "refrigerated" ? "refrigerated van" : "standard fleet";

/** Why each warehouse that was not used was not used. */
export function buildRejections(
  demand: readonly OrderLine[],
  plan: Plan,
  policy: ColdChainPolicy,
): Rejection[] {
  const used = new Set(plan.used.map((w) => w.id));
  const out: Rejection[] = [];

  for (const warehouse of WAREHOUSES) {
    if (used.has(warehouse.id)) continue;

    const blocked = demand
      .map((line) => productById(line.productId)!)
      .filter((p) => p.coldChain && (warehouse.stock[p.id] ?? 0) > 0 && !canCarry(warehouse, p, policy));

    if (blocked.length > 0) {
      const ids = blocked.map((p) => p.id).join(", ");
      out.push(
        warehouse.coldStorage
          ? {
              warehouseId: warehouse.id,
              code: "cold-chain-van-missing",
              reason: `Has cold storage but only a ${fleetText(warehouse)}, so under the "${policy}" policy it may not carry ${ids}.`,
            }
          : {
              warehouseId: warehouse.id,
              code: "cold-storage-missing",
              reason: `Has no cold storage, so it may not carry ${ids}.`,
            },
      );
      continue;
    }

    out.push(
      demand.some((line) => (warehouse.stock[line.productId] ?? 0) > 0)
        ? {
            warehouseId: warehouse.id,
            code: "not-needed",
            reason:
              "Eligible and stocked, but not needed: the chosen set covers the order in fewer shipments at a shorter total distance.",
          }
        : {
            warehouseId: warehouse.id,
            code: "no-stock-of-order",
            reason: "Holds none of the products in this order.",
          },
    );
  }
  return out;
}

/** Everything the customer asked for that no combination of warehouses can cover. */
export function buildUnfilled(
  demand: readonly OrderLine[],
  policy: ColdChainPolicy,
): Unfilled[] {
  return demand
    .map((line) => {
      const product = productById(line.productId)!;
      const available = WAREHOUSES.filter((w) => canCarry(w, product, policy)).reduce(
        (sum, w) => sum + (w.stock[product.id] ?? 0),
        0,
      );
      return {
        productId: product.id,
        productName: product.name,
        code: "insufficient-stock" as const,
        qtyRequested: line.quantity,
        qtyShort: Math.max(0, line.quantity - available),
        qtyAvailable: available,
      };
    })
    .filter((line) => line.qtyShort > 0);
}

const describeDemand = (demand: readonly OrderLine[]) =>
  demand.map((l) => `${l.quantity} x ${l.productId} ${productById(l.productId)!.name}`).join("; ");

export function buildUnfulfillableExplanation(
  demand: readonly OrderLine[],
  policy: ColdChainPolicy,
  unfilled: readonly Unfilled[],
): Explanation {
  return {
    summary: `Cannot be fulfilled: ${unfilled.map((u) => `${u.productId} short by ${u.qtyShort}`).join(", ")}.`,
    policy: policyText(policy),
    steps: [
      `Order: ${describeDemand(demand)}.`,
      policyText(policy),
      ...unfilled.map(
        (u) =>
          `${u.productId} needs ${u.qtyRequested}, but only ${u.qtyAvailable} exist across every warehouse this policy allows. No combination of warehouses can cover the order, so nothing is shipped: a partial delivery that was never asked for would be worse than a clear refusal.`,
      ),
    ],
  };
}

export function buildExplanation(
  demand: readonly OrderLine[],
  policy: ColdChainPolicy,
  plan: Plan,
  alternativePlan: Plan | null,
): Explanation {
  const coldProducts = demand.map((l) => productById(l.productId)!).filter((p) => p.coldChain);

  const steps: string[] = [`Order: ${describeDemand(demand)}.`, policyText(policy)];

  if (coldProducts.length > 0) {
    const capable = WAREHOUSES.filter((w) => isColdChainCapable(w, policy)).map((w) => w.id);
    steps.push(
      `The order contains ${coldProducts.map((p) => p.id).join(" and ")}, so under this policy only ${capable.join(
        ", ",
      )} may handle ${coldProducts.length === 1 ? "it" : "them"}.`,
    );
    steps.push(
      'The decision point in this dataset: W02 (Surabaya, 12 km) and W06 (Malang, 95 km) both have cold storage and hold vaccine stock, but neither has a refrigerated van. They win on distance if the cold chain only has to hold in storage, and they drop out entirely if it also has to hold in transit. The policy in force is what settles it, and it is a policy, not a fact.',
    );
  }

  steps.push(
    `Searched all ${combinationCount()} non-empty warehouse combinations. Fewest shipments wins first, then least total distance. Best: ${describePlan(plan)}.`,
  );

  for (const warehouse of plan.used) {
    const capability = isColdChainCapable(warehouse, policy)
      ? `cold storage and a ${fleetText(warehouse)}`
      : `a ${fleetText(warehouse)} and no cold storage`;
    const shipped = demand
      .filter((line) => (plan.lines.get(line.productId)?.get(warehouse.id) ?? 0) > 0)
      .map((line) => `${plan.lines.get(line.productId)!.get(warehouse.id)!} x ${line.productId}`)
      .join("; ");
    steps.push(`${warehouseLabel(warehouse)} has ${capability}. Ships ${shipped}.`);
  }

  let alternativePolicy: Explanation["alternativePolicy"];
  if (coldProducts.length > 0) {
    const other: ColdChainPolicy = policy === "end-to-end" ? "storage-only" : "end-to-end";

    if (alternativePlan === null) {
      // The stricter reading can leave an order unfulfillable that the looser
      // one can serve, so this branch is reachable rather than theoretical.
      alternativePolicy = { policy: other, summary: "no feasible plan under this policy", sameAsChosen: false };
      steps.push(
        `Under the "${other}" policy this order could not be fulfilled at all, which is the strongest form of the storage-versus-transport trade-off. "${policy}" is in force.`,
      );
    } else {
      const same = alternativePlan.used.map((w) => w.id).join() === plan.used.map((w) => w.id).join();
      alternativePolicy = { policy: other, summary: describePlan(alternativePlan), sameAsChosen: same };
      steps.push(
        same
          ? `The "${other}" policy would reach the same warehouses here: ${describePlan(
              alternativePlan,
            )}. This order does not sit on the storage-versus-transport decision point.`
          : `The "${other}" policy would decide differently: ${describePlan(
              alternativePlan,
            )}. That is the storage-versus-transport trade-off, surfaced rather than hidden. "${policy}" is in force.`,
      );
    }
  }

  return { summary: `Fulfilled by ${describePlan(plan)}.`, policy: policyText(policy), steps, alternativePolicy };
}
