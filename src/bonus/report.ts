/**
 * BONUS - the proof-of-concept report.
 *
 * Run with `npm run bonus`. It shows what the delivery log actually contains,
 * where it disagrees with the kilometre figures, and a concrete order whose
 * warehouse changes when you rank by predicted travel time instead.
 *
 * Prints plain ASCII so it is readable in any terminal.
 */

import { WAREHOUSES } from "../domain/catalog.ts";
import { selectWarehouses } from "../domain/select.ts";
import type { SelectionResult } from "../domain/select.ts";
import {
  BUCKETS,
  bucketFor,
  loadHistory,
  median,
  pooledBucketRatios,
  summariseByWarehouse,
} from "./history.ts";
import type { Bucket, Day } from "./history.ts";
import { createTravelModel } from "./travel.ts";

const pad = (value: string | number, width: number) => String(value).padStart(width);
const end = (value: string | number, width: number) => String(value).padEnd(width);

/** A representative day and hour for each slot, used to query the model. */
const SAMPLE_TIME: Record<Bucket, { day: Day; hour: number }> = {
  "weekday-am": { day: "Tue", hour: 8 },
  "weekday-mid": { day: "Tue", hour: 12 },
  "weekday-pm": { day: "Fri", hour: 17 },
  weekend: { day: "Sat", hour: 9 },
};

function main() {
  const records = loadHistory();
  if (records.length === 0) {
    console.log("No delivery log found next to the project root.");
    console.log("The bonus analysis needs it; the core selection path does not.");
    return;
  }

  const model = createTravelModel(records);
  const byWarehouse = summariseByWarehouse(records);
  const ranked = WAREHOUSES.flatMap((warehouse) => {
    const history = byWarehouse.get(warehouse.id);
    return history ? [{ warehouse, history }] : [];
  });

  console.log(`Historical delivery log: ${records.length} records\n`);

  console.log("Per warehouse, actual delivery time against distance");
  console.log(
    `${end("wh", 5)}${pad("km", 5)}${pad("readings", 10)}${pad("median", 8)}${pad("fastest", 9)}${pad("slowest", 9)}${pad("min/km", 8)}`,
  );
  for (const { warehouse, history } of ranked) {
    console.log(
      `${end(warehouse.id, 5)}${pad(warehouse.distanceKm, 5)}${pad(history.sampleSize, 10)}${pad(
        history.medianMinutes, 8,
      )}${pad(history.minMinutes, 9)}${pad(history.maxMinutes, 9)}${pad(
        (history.medianMinutes / warehouse.distanceKm).toFixed(1), 8,
      )}`,
    );
  }

  const byDistance = [...ranked].sort((a, b) => a.warehouse.distanceKm - b.warehouse.distanceKm);
  const byTime = [...ranked].sort((a, b) => a.history.medianMinutes - b.history.medianMinutes);

  console.log("\nRanked by distance    :", byDistance.map((x) => `${x.warehouse.id}(${x.warehouse.distanceKm}km)`).join(" < "));
  console.log("Ranked by median time :", byTime.map((x) => `${x.warehouse.id}(${x.history.medianMinutes}m)`).join(" < "));

  // Derived, not asserted, so the wording cannot drift away from the numbers.
  const perKm = ranked
    .map((x) => ({
      id: x.warehouse.id,
      km: x.warehouse.distanceKm,
      value: x.history.medianMinutes / x.warehouse.distanceKm,
    }))
    .sort((a, b) => b.value - a.value);
  const slowest = perKm[0];
  const quickest = perKm[perKm.length - 1];
  const topTwo = perKm.slice(0, 2).map((x) => `${x.id} at ${x.km} km`).join(" and ");
  console.log(
    `\nMinutes per kilometre runs from ${slowest.value.toFixed(1)} at ${slowest.id} down to ${quickest.value.toFixed(
      1,
    )} at ${quickest.id}, a factor of ${(slowest.value / quickest.value).toFixed(1)}.\n` +
      `The two worst are the two nearest: ${topTwo}. A distance ranking treats a kilometre as a\n` +
      "fixed cost everywhere, and this log is direct evidence that it is not.",
  );

  const widest = [...ranked].sort(
    (a, b) => b.history.maxMinutes - b.history.minMinutes - (a.history.maxMinutes - a.history.minMinutes),
  )[0];
  console.log(
    `\nSpread matters too. ${widest.warehouse.id} ranges from ${widest.history.minMinutes} to ${widest.history.maxMinutes} minutes, ` +
      "so a single\nmedian for it describes a rush-hour population and an off-peak one at once.",
  );

  const ratios = pooledBucketRatios(records);
  console.log("\nTime-of-day effect, pooled across warehouses");
  console.log(`${end("slot", 14)}${pad("readings", 10)}${pad("pooled ratio", 14)}`);
  for (const bucket of BUCKETS) {
    const inBucket = records.filter((r) => bucketFor(r.day, r.hour) === bucket);
    console.log(`${end(bucket, 14)}${pad(inBucket.length, 10)}${pad(ratios[bucket].toFixed(2), 14)}`);
  }

  console.log(
    "\nThat pooled figure is a trap. The weekend effect runs in opposite directions: the\n" +
      "near-city warehouses get faster and the Malang ones get slower, so pooling cancels\n" +
      "them out and lands near 1.0, hiding both. Per-warehouse figures are preferred\n" +
      "wherever they exist for exactly this reason.",
  );
  for (const { warehouse, history } of ranked) {
    const weekend = history.byBucket.weekend?.medianMinutes;
    if (weekend === undefined) continue;
    const weekday = median(
      records.filter((r) => r.warehouseId === warehouse.id && bucketFor(r.day, r.hour) !== "weekend").map((r) => r.minutes),
    );
    if (weekday === 0) continue;
    console.log(
      `  ${warehouse.id} ${end(warehouse.city, 10)} weekday ${pad(weekday, 3)}m -> weekend ${pad(weekend, 3)}m (${
        weekend < weekday ? "faster" : "slower"
      })`,
    );
  }

  const notes = records.filter((r) => r.note !== "—" && r.note !== "");
  if (notes.length > 0) {
    console.log("\nNotes recorded in the log");
    for (const note of notes) console.log(`  ${note.id} ${note.warehouseId} ${note.day} ${note.time}  ${note.note}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("An order where the two objectives disagree: 10 x P002, storage-only policy");
  console.log("=".repeat(72));

  const order = [{ productId: "P002", quantity: 10 }];
  const byKm = selectWarehouses(order, "storage-only", { objective: "distance", travel: model });
  const byMin = selectWarehouses(order, "storage-only", { objective: "minutes", travel: model });

  const show = (label: string, result: SelectionResult) => {
    const ids = result.allocations.map((a) => a.warehouseId).join(" + ");
    const minutes = result.estimatedMinutes === undefined ? "" : `, ${result.estimatedMinutes} predicted minutes`;
    console.log(`  ${end(label, 12)} ${end(ids, 6)} at ${pad(result.totalDistanceKm, 3)} km${minutes}`);
  };
  show("by distance", byKm);
  show("by minutes", byMin);

  const kmPick = byKm.allocations[0].warehouseId;
  const minPick = byMin.allocations[0].warehouseId;
  if (kmPick === minPick) {
    console.log("\n  Both objectives agree on this order.");
  } else {
    console.log(
      `\n  The nearest eligible warehouse is not the quickest one. ${kmPick} is ${byKm.totalDistanceKm} km\n` +
        `  away but takes a median of ${model.estimate(kmPick).minutes} minutes, while ${minPick} at\n` +
        `  ${byMin.totalDistanceKm} km takes ${byMin.estimatedMinutes}. Ranking on kilometres alone picks the slower site.`,
    );
  }

  console.log("\nPredicted minutes by slot, for the candidates in this example");
  console.log(`${end("slot", 14)}${["W02", "W03", "W04"].map((id) => pad(id, 24)).join("")}`);
  for (const bucket of BUCKETS) {
    const cells = ["W02", "W03", "W04"].map((id) => {
      const estimate = model.estimate(id, SAMPLE_TIME[bucket]);
      const detail = estimate.basis === "observed" ? `n=${estimate.sampleSize}` : "extrapolated";
      return pad(`${estimate.minutes}m (${detail})`, 24);
    });
    console.log(`${end(bucket, 14)}${cells.join("")}`);
  }

  console.log(
    "\nThe slot matters as much as the warehouse: W02 is quickest in the middle of a weekday\n" +
      "and slowest on a Friday evening. That is the pattern the log was there to reveal.",
  );
}

if (import.meta.filename === process.argv[1]) main();
