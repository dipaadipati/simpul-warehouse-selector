/**
 * BONUS - a travel-time estimate per warehouse, learned from the delivery log.
 *
 * The finding, in words rather than in figures so it cannot rot: ordering
 * warehouses by kilometres gives a different order from ordering them by the
 * minutes actually recorded, and the warehouses that look worst per kilometre
 * are the ones nearest the depot. A distance ranking treats a kilometre as a
 * fixed cost everywhere; the log says the cost varies by roughly a factor of
 * five. Run `npm run bonus` for the current table.
 *
 * The time-of-day effect is not a simple multiplier either. On the weekend the
 * near-city warehouses get much faster while the Malang ones get slower, which
 * matches the notes in the log about weekend travel to and from Malang. A
 * single pooled ratio cancels those two effects out and lands near 1, hiding
 * both. So the per-warehouse-per-slot figure is preferred wherever it exists.
 *
 * Confidence is reported alongside every estimate, because 38 records spread
 * over 8 warehouses and 4 slots is thin. Several slots hold a single
 * observation. This is a proof of concept for whether the signal exists, not a
 * production ETA model, and the `basis` field says which numbers are measured
 * and which are extrapolated.
 */

import {
  DAYS,
  bucketFor,
  loadHistory,
  median,
  pooledBucketRatios,
  summariseByWarehouse,
} from "./history.ts";
import type { Bucket, Day, DeliveryRecord, WarehouseHistory } from "./history.ts";

export interface DepartureTime {
  day: Day;
  hour: number;
}

/** Guards the API boundary so a malformed time cannot reach the model. */
export function isDepartureTime(value: unknown): value is DepartureTime {
  if (typeof value !== "object" || value === null) return false;
  const { day, hour } = value as Partial<DepartureTime>;
  return (
    typeof day === "string" &&
    DAYS.includes(day as Day) &&
    typeof hour === "number" &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23
  );
}

/** "observed" is measured for that warehouse and slot; "extrapolated" is not. */
export type EstimateBasis = "observed" | "extrapolated" | "unknown";

export interface Estimate {
  warehouseId: string;
  minutes: number;
  bucket: Bucket | null;
  basis: EstimateBasis;
  /** Readings behind this number. 1 means a single delivery, so treat it loosely. */
  sampleSize: number;
}

export interface TravelModel {
  available: boolean;
  recordCount: number;
  estimate: (warehouseId: string, at?: DepartureTime) => Estimate;
}

const unknown = (warehouseId: string, bucket: Bucket | null): Estimate => ({
  warehouseId,
  minutes: 0,
  bucket,
  basis: "unknown",
  sampleSize: 0,
});

export function createTravelModel(records: readonly DeliveryRecord[]): TravelModel {
  const index: Map<string, WarehouseHistory> = summariseByWarehouse(records);
  const ratios = pooledBucketRatios(records);

  const estimate = (warehouseId: string, at?: DepartureTime): Estimate => {
    const history = index.get(warehouseId);
    const bucket = at ? bucketFor(at.day, at.hour) : null;
    if (!history) return unknown(warehouseId, bucket);

    if (!at) {
      return {
        warehouseId,
        minutes: history.medianMinutes,
        bucket: null,
        basis: "observed",
        sampleSize: history.sampleSize,
      };
    }

    const cell = history.byBucket[bucket!];
    if (cell) {
      return {
        warehouseId,
        minutes: cell.medianMinutes,
        bucket,
        basis: "observed",
        sampleSize: cell.sampleSize,
      };
    }

    return {
      warehouseId,
      minutes: Math.round(history.medianMinutes * ratios[bucket!]),
      bucket,
      basis: "extrapolated",
      sampleSize: history.sampleSize,
    };
  };

  return { available: records.length > 0, recordCount: records.length, estimate };
}

let cached: TravelModel | null = null;

/** Loads the log once per process. Absent log yields an unavailable model. */
export function defaultTravelModel(): TravelModel {
  cached ??= createTravelModel(loadHistory());
  return cached;
}

export interface PlanTravel {
  minutes: number;
  estimates: Estimate[];
}

/** Total predicted travel time for a set of warehouses. */
export function plannedMinutes(
  model: TravelModel,
  warehouseIds: readonly string[],
  at?: DepartureTime,
): PlanTravel {
  const estimates = warehouseIds.map((id) => model.estimate(id, at));
  return { minutes: estimates.reduce((sum, e) => sum + e.minutes, 0), estimates };
}

/** Median minutes for every warehouse, for reporting the distance-versus-time gap. */
export function medianMinutesByWarehouse(records: readonly DeliveryRecord[]): Map<string, number> {
  const index = summariseByWarehouse(records);
  return new Map([...index].map(([id, history]) => [id, history.medianMinutes]));
}

export { median };
