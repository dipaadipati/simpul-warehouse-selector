/**
 * Tests for the bonus modules. They build their own records rather than reading
 * the delivery log, because the log is the company's data and is not committed -
 * a test suite that only passes on one machine is not a test suite.
 *
 * The one exception is the MacRoman decode check at the bottom, which skips
 * itself when the log is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bucketFor,
  hasHistoryFile,
  loadHistory,
  median,
  parseHistory,
  pooledBucketRatios,
  summariseByWarehouse,
} from "../src/bonus/history.ts";
import type { DeliveryRecord } from "../src/bonus/history.ts";
import { createTravelModel, isDepartureTime, plannedMinutes } from "../src/bonus/travel.ts";
import { selectWarehouses } from "../src/domain/select.ts";

/** A record with only the fields an estimate depends on spelled out. */
const rec = (id: string, warehouseId: string, minutes: number, day = "Tue", hour = 9): DeliveryRecord => ({
  id,
  warehouseId,
  day: day as DeliveryRecord["day"],
  hour,
  time: `${String(hour).padStart(2, "0")}:00`,
  minutes,
  note: "—",
});

test("bucketFor splits weekday hours and sends the whole weekend to one slot", () => {
  assert.equal(bucketFor("Mon", 9), "weekday-am");
  assert.equal(bucketFor("Mon", 10), "weekday-mid");
  assert.equal(bucketFor("Fri", 14), "weekday-mid");
  assert.equal(bucketFor("Fri", 15), "weekday-pm");
  assert.equal(bucketFor("Sat", 9), "weekend");
  assert.equal(bucketFor("Sun", 9), "weekend");
});

test("median interpolates on an even count instead of picking a side", () => {
  assert.equal(median([]), 0);
  assert.equal(median([7]), 7);
  assert.equal(median([3, 1, 2]), 2);
  // The upper value would be 48; the midpoint is the honest answer for a
  // bimodal column, and picking a side is how the first draft of the report
  // came to quote 48 for W01.
  assert.equal(median([10, 12, 15, 18, 48, 50, 55, 65]), 33);
});

test("parseHistory reads bare-CR rows, quoted fields and the em dash placeholder", () => {
  const csv =
    "id,warehouse,day_time,minutes,note\r" +
    'DL001,W01,"Mon, 09:15",30,Heavy traffic\r' +
    'DL002,W02,"Fri, 17:30",75,—\r';
  const records = parseHistory(csv);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => [r.id, r.day, r.hour, r.time, r.minutes, r.note]),
    [
      ["DL001", "Mon", 9, "09:15", 30, "Heavy traffic"],
      // The time is kept as written, so a report cannot print 17:00 for a
      // delivery logged at 17:30.
      ["DL002", "Fri", 17, "17:30", 75, "—"],
    ],
  );
});

test("parseHistory rejects an unknown day rather than silently bucketing it", () => {
  assert.throws(() => parseHistory('id,wh,day_time,minutes,note\rDL1,W01,"Funday, 09:00",30,x\r'), /unknown day/);
});

test("loadHistory returns an empty list for a missing file and never throws", () => {
  assert.deepEqual(loadHistory(join(tmpdir(), "no-such-delivery-log-7f3a.csv")), []);
});

test("loadHistory decodes a MacRoman file, which plain UTF-8 reads as mojibake", () => {
  const dir = mkdtempSync(join(tmpdir(), "simpul-"));
  const path = join(dir, "log.csv");
  // 0xD1 is the em dash in MacRoman and an invalid UTF-8 lead byte.
  writeFileSync(path, Buffer.from("id,wh,day_time,minutes,note\rDL1,W01,\"Mon, 09:00\",30,Ñ\r", "latin1"));

  const records = loadHistory(path);
  assert.equal(records.length, 1);
  assert.equal(records[0].note, "—");
});

test("summariseByWarehouse keeps per-slot figures apart", () => {
  const history = summariseByWarehouse([
    rec("1", "W01", 10, "Mon", 8),
    rec("2", "W01", 12, "Mon", 9),
    rec("3", "W01", 60, "Fri", 17),
  ]).get("W01")!;

  assert.equal(history.sampleSize, 3);
  assert.equal(history.medianMinutes, 12);
  assert.equal(history.minMinutes, 10);
  assert.equal(history.maxMinutes, 60);
  assert.deepEqual(history.byBucket["weekday-am"], { sampleSize: 2, medianMinutes: 11 });
  assert.deepEqual(history.byBucket["weekday-pm"], { sampleSize: 1, medianMinutes: 60 });
  assert.equal(history.byBucket.weekend, undefined);
});

test("a pooled slot ratio describes no particular warehouse", () => {
  const records = [
    rec("1", "W01", 40, "Mon", 8),
    rec("2", "W01", 10, "Sat", 8),
    rec("3", "W05", 10, "Mon", 8),
    rec("4", "W05", 200, "Sat", 8),
  ];
  const ratios = pooledBucketRatios(records);

  // One warehouse speeds up fourfold and the other is far slower, so the pooled
  // weekend figure lands far from both. This is a property of pooling, and it is
  // why the report caps how much it reads into the pooled numbers rather than
  // treating them as a finding - see the sample sizes in the per-warehouse table.
  assert.ok(ratios.weekend > 1, `expected a weekend effect, got ${ratios.weekend}`);
  const near = summariseByWarehouse(records).get("W01")!;
  assert.equal(near.byBucket.weekend!.medianMinutes / near.byBucket["weekday-am"]!.medianMinutes, 0.25);
});

test("the travel model reports whether a figure was measured or extrapolated", () => {
  const model = createTravelModel([rec("1", "W01", 10), rec("2", "W01", 20), rec("3", "W01", 30, "Sat", 9)]);

  const overall = model.estimate("W01");
  assert.equal(overall.basis, "observed");
  assert.equal(overall.minutes, 20);
  assert.equal(overall.sampleSize, 3);

  const measured = model.estimate("W01", { day: "Mon", hour: 8 });
  assert.equal(measured.basis, "observed");
  assert.equal(measured.sampleSize, 2);

  const borrowed = model.estimate("W01", { day: "Wed", hour: 12 });
  assert.equal(borrowed.basis, "extrapolated");
  // Extrapolation and a missing warehouse both have to be visible, not silent.
  assert.equal(borrowed.sampleSize, 3);
  assert.equal(model.estimate("W99").basis, "unknown");
  assert.equal(createTravelModel([]).available, false);
});

test("plannedMinutes sums the warehouses in a plan", () => {
  const model = createTravelModel([rec("1", "W01", 10), rec("2", "W04", 40)]);
  assert.equal(plannedMinutes(model, ["W01", "W04"]).minutes, 50);
  assert.equal(plannedMinutes(model, ["W01", "W04"]).estimates.length, 2);
});

/**
 * The headline claim of the bonus round: on this order the kilometre ranking
 * and the travel-time ranking disagree, so the objective is a real choice and
 * not a relabelling of the same decision.
 */
test("the minutes objective can overturn the nearest eligible warehouse", () => {
  const model = createTravelModel([
    rec("1", "W02", 60),
    rec("2", "W02", 70),
    rec("3", "W04", 45),
    rec("4", "W04", 55),
    rec("5", "W06", 200),
    rec("6", "W07", 70),
    rec("7", "W08", 210),
  ]);

  const order = [{ productId: "P002", quantity: 10 }];
  const byKm = selectWarehouses(order, "storage-only", { objective: "distance", travel: model });
  const byMin = selectWarehouses(order, "storage-only", { objective: "minutes", travel: model });

  // W02 is 12 km away against W04 at 30 km, but it is the slower of the two.
  assert.deepEqual(
    byKm.allocations.map((a) => a.warehouseId),
    ["W02"],
  );
  assert.deepEqual(
    byMin.allocations.map((a) => a.warehouseId),
    ["W04"],
  );
  assert.equal(byKm.totalDistanceKm, 12);
  assert.equal(byMin.totalDistanceKm, 30);
  assert.equal(byMin.estimatedMinutes, 50);
  // The shipment count is settled first, so a faster route is never bought by
  // adding a second van.
  assert.equal(byMin.shipmentCount, 1);
  assert.equal(byKm.estimatedMinutes, undefined);

  // W02 is nearer, so calling it "not needed" on distance grounds would be a
  // plain falsehood in the output a reviewer reads first.
  const passedOver = byMin.rejected.find((r) => r.warehouseId === "W02")!;
  assert.equal(passedOver.code, "not-needed");
  assert.match(passedOver.reason, /quicker overall/);
  assert.doesNotMatch(passedOver.reason, /shorter total distance/);
});

test("the minutes objective refuses to run without the log behind it", () => {
  assert.throws(
    () => selectWarehouses([{ productId: "P001", quantity: 1 }], "end-to-end", { objective: "minutes", travel: createTravelModel([]) }),
    /needs the historical delivery log/,
  );
});

test("isDepartureTime rejects anything the model could not bucket", () => {
  assert.equal(isDepartureTime({ day: "Mon", hour: 9 }), true);
  assert.equal(isDepartureTime({ day: "Mon", hour: 0 }), true);
  assert.equal(isDepartureTime({ day: "Mon", hour: 23 }), true);

  assert.equal(isDepartureTime({ day: "Mon", hour: 24 }), false);
  assert.equal(isDepartureTime({ day: "Mon", hour: 9.5 }), false);
  assert.equal(isDepartureTime({ day: "Funday", hour: 9 }), false);
  assert.equal(isDepartureTime({ day: "Mon" }), false);
  assert.equal(isDepartureTime({ hour: 9 }), false);
  assert.equal(isDepartureTime("Mon 09:00"), false);
  assert.equal(isDepartureTime(null), false);
});

/** Only runs where the real log is present, so a fresh clone still goes green. */
test("the real log parses to the shape the report expects", { skip: !hasHistoryFile() ? "no delivery log here" : false }, () => {
  const records = loadHistory();
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.match(record.id, /^DL\d+$/);
    assert.match(record.warehouseId, /^W0[1-8]$/);
    assert.match(record.time, /^\d{2}:\d{2}$/);
    assert.equal(record.hour, Number(record.time.split(":")[0]));
    assert.ok(record.minutes > 0);
  }
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
});
