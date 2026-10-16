import { test } from "node:test";
import assert from "node:assert/strict";

import { selectWarehouses, validateOrder } from "../src/domain/select.ts";
import type { ColdChainPolicy, SelectionResult } from "../src/domain/select.ts";

const ids = (result: SelectionResult) => result.allocations.map((a) => a.warehouseId);
const codesFor = (result: SelectionResult, warehouseId: string) =>
  result.rejected.filter((r) => r.warehouseId === warehouseId).map((r) => r.code);

test("plain supplies go to the nearest stocked warehouse", () => {
  const result = selectWarehouses([{ productId: "P001", quantity: 10 }]);
  assert.equal(result.feasible, true);
  assert.deepEqual(ids(result), ["W01"]);
  assert.equal(result.shipmentCount, 1);
  assert.equal(result.totalDistanceKm, 5);
});

test("Paracetamol is served from the general warehouses W01 and W05", () => {
  // P005 is category "Pharmaceutical" but has no cold chain. A rule keyed off
  // the category would refuse W01 here and send the order to W04 at 30 km.
  const near = selectWarehouses([{ productId: "P005", quantity: 100 }]);
  assert.deepEqual(ids(near), ["W01"]);
  assert.equal(near.totalDistanceKm, 5);

  // W01 holds only 300 of P005, so the same logic has to reach W05 as well.
  // W05 is a general warehouse with no refrigeration, and that must be fine.
  const larger = selectWarehouses([{ productId: "P005", quantity: 400 }]);
  assert.deepEqual(ids(larger), ["W05"]);
  assert.equal(larger.totalDistanceKm, 90);
});

test("a vaccine goes to W04 under end-to-end and to W02 under storage-only", () => {
  // The decision point in the dataset, from both sides.
  const strict = selectWarehouses([{ productId: "P002", quantity: 10 }], "end-to-end");
  assert.deepEqual(ids(strict), ["W04"]); // 30 km, refrigerated van
  assert.equal(strict.totalDistanceKm, 30);

  const loose = selectWarehouses([{ productId: "P002", quantity: 10 }], "storage-only");
  assert.deepEqual(ids(loose), ["W02"]); // 12 km, cold storage, standard fleet
  assert.equal(loose.totalDistanceKm, 12);
});

test("vaccines are refused from W02 and W06 while transit has to stay cold", () => {
  const order = [{ productId: "P004", quantity: 5 }];

  const strict = selectWarehouses(order, "end-to-end");
  assert.deepEqual(codesFor(strict, "W02"), ["cold-chain-van-missing"]);
  assert.deepEqual(codesFor(strict, "W06"), ["cold-chain-van-missing"]);
  assert.ok(!ids(strict).includes("W02"));
  assert.ok(!ids(strict).includes("W06"));

  // With the policy relaxed, W02 is not merely allowed in - it wins outright,
  // and W06 becomes the one that is eligible but unnecessary.
  const loose = selectWarehouses(order, "storage-only");
  assert.deepEqual(ids(loose), ["W02"]);
  assert.deepEqual(codesFor(loose, "W02"), []); // W02 is used, so it is not in the rejected list
  assert.deepEqual(codesFor(loose, "W06"), ["not-needed"]);
});

test("W07 is a trap: near, refrigerated, and nearly out of vaccine", () => {
  // Nearest-first walks into W07 (45 km, 8 units), runs dry, and needs a second
  // van from W04 at 30 km anyway. Fewest shipments wins instead: W08 alone.
  const result = selectWarehouses([{ productId: "P002", quantity: 45 }], "end-to-end");
  assert.equal(result.shipmentCount, 1);
  assert.deepEqual(ids(result), ["W08"]);
  assert.equal(result.allocations[0].lines[0].qty, 45);
  assert.deepEqual(codesFor(result, "W07"), ["not-needed"]);
});

test("an order too large for one warehouse splits, draining the nearer one first", () => {
  const result = selectWarehouses([{ productId: "P002", quantity: 70 }], "end-to-end");
  assert.equal(result.shipmentCount, 2);
  assert.deepEqual(ids(result), ["W04", "W08"]);
  assert.equal(result.totalDistanceKm, 180);
  assert.equal(result.allocations[0].lines[0].qty, 40); // W04 has exactly 40
  assert.equal(result.allocations[1].lines[0].qty, 30);
});

test("a mixed order pairs a general warehouse with a cold one", () => {
  const result = selectWarehouses([
    { productId: "P001", quantity: 10 },
    { productId: "P002", quantity: 10 },
  ]);
  assert.deepEqual(ids(result), ["W01", "W04"]);
  assert.equal(result.totalDistanceKm, 35);
});

test("the same input always produces the same decision", () => {
  const order = [
    { productId: "P002", quantity: 70 },
    { productId: "P001", quantity: 20 },
  ];
  assert.deepEqual(selectWarehouses(order, "end-to-end"), selectWarehouses(order, "end-to-end"));
  assert.deepEqual(selectWarehouses(order, "storage-only"), selectWarehouses(order, "storage-only"));
});

test("an order no combination of warehouses can cover is refused, not half-shipped", () => {
  const result = selectWarehouses([{ productId: "P002", quantity: 500 }]);
  assert.equal(result.feasible, false);
  assert.equal(result.shipmentCount, 0);
  assert.deepEqual(result.allocations, []);
  assert.deepEqual(result.unfilled, [
    {
      productId: "P002",
      productName: "Vaccine - Hepatitis B (10-dose vial)",
      code: "insufficient-stock",
      qtyRequested: 500,
      qtyShort: 392,
      qtyAvailable: 108, // 40 at W04, 8 at W07, 60 at W08
    },
  ]);
  assert.match(result.explanation.summary, /short by 392/);
});

test("what counts as available depends on the policy in force", () => {
  // 30 + 40 + 20 + 8 + 60 = 158, and only under storage-only.
  const strict = selectWarehouses([{ productId: "P002", quantity: 158 }], "end-to-end");
  assert.equal(strict.feasible, false);

  const loose = selectWarehouses([{ productId: "P002", quantity: 158 }], "storage-only");
  assert.equal(loose.feasible, true);
  assert.deepEqual(ids(loose), ["W02", "W04", "W06", "W07", "W08"]);
  assert.equal(loose.totalDistanceKm, 332);
});

test("repeated product lines are merged rather than split into two shipments", () => {
  const split = selectWarehouses([
    { productId: "P001", quantity: 5 },
    { productId: "P001", quantity: 7 },
  ]);
  assert.deepEqual(split, selectWarehouses([{ productId: "P001", quantity: 12 }]));
});

test("bad input is refused loudly rather than guessed at", () => {
  assert.throws(() => selectWarehouses([]), RangeError);
  assert.throws(() => selectWarehouses([{ productId: "P999", quantity: 1 }]), RangeError);
  assert.throws(() => selectWarehouses([{ productId: "P001", quantity: 0 }]), RangeError);
  assert.throws(() => selectWarehouses([{ productId: "P001", quantity: -3 }]), RangeError);
  assert.throws(() => selectWarehouses([{ productId: "P001", quantity: 1.5 }]), RangeError);
});

test("validateOrder reports problems as data for the HTTP layer", () => {
  assert.deepEqual(validateOrder([{ productId: "P001", quantity: 1 }]), []);
  assert.deepEqual(validateOrder(undefined), ["items must be a non-empty array of {productId, quantity}"]);
  assert.equal(validateOrder([{ productId: "P001", quantity: 1 }, { productId: "X", quantity: 2 }]).length, 1);
  assert.equal(validateOrder([{ productId: "P001", quantity: 0 }]).length, 1);
});

test("every allocation carries stock and the explanation is always populated", () => {
  const order = [
    { productId: "P002", quantity: 25 },
    { productId: "P003", quantity: 50 },
  ];
  for (const policy of ["end-to-end", "storage-only"] as ColdChainPolicy[]) {
    const result = selectWarehouses(order, policy);
    assert.equal(result.feasible, true);
    assert.equal(result.allocations.length, result.shipmentCount);
    assert.equal(result.shipmentCount, new Set(ids(result)).size, "one shipment per warehouse");
    for (const allocation of result.allocations) assert.ok(allocation.lines.length > 0);
    assert.ok(result.explanation.steps.length >= 3);
    assert.ok(result.explanation.summary.length > 0);
  }
});

test("a cold order always reports what the other policy would have decided", () => {
  const cold = selectWarehouses([{ productId: "P002", quantity: 10 }], "end-to-end");
  assert.equal(cold.explanation.alternativePolicy?.policy, "storage-only");
  assert.equal(cold.explanation.alternativePolicy?.sameAsChosen, false);
  assert.match(cold.explanation.alternativePolicy!.summary, /W02/);

  const ambient = selectWarehouses([{ productId: "P001", quantity: 10 }]);
  assert.equal(ambient.explanation.alternativePolicy, undefined, "no cold line means no ambiguity to report");
});
