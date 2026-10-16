/**
 * BONUS - reading the historical delivery log.
 *
 * The file is MacRoman with bare CR line endings and uses an em dash for a
 * missing note, so it is not plain UTF-8 and not plain LF. Both are handled
 * here; anything reading it with default assumptions gets one very long line.
 *
 * The file is deliberately not committed, so this module returns an empty
 * history rather than throwing when it is absent. The core selection path does
 * not import this module at all, which is what keeps a fresh clone working.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** The log sits beside the project root unless SIMPUL_HISTORY_PATH points elsewhere. */
export const defaultHistoryPath =
  process.env.SIMPUL_HISTORY_PATH ?? join(here, "..", "..", "customer1-historical.csv");

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Day = (typeof DAYS)[number];

/** Coarse time slots. Chosen from the data, not from a theory of traffic. */
export type Bucket = "weekday-am" | "weekday-mid" | "weekday-pm" | "weekend";

export const BUCKETS: readonly Bucket[] = ["weekday-am", "weekday-mid", "weekday-pm", "weekend"];

export interface DeliveryRecord {
  id: string;
  warehouseId: string;
  day: Day;
  hour: number;
  /** Kept verbatim so reports quote the log rather than reconstruct it. */
  time: string;
  minutes: number;
  note: string;
}

export interface BucketStats {
  sampleSize: number;
  medianMinutes: number;
}

export interface WarehouseHistory {
  warehouseId: string;
  sampleSize: number;
  medianMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  byBucket: Partial<Record<Bucket, BucketStats>>;
}

export function bucketFor(day: Day, hour: number): Bucket {
  if (day === "Sat" || day === "Sun") return "weekend";
  if (hour < 10) return "weekday-am";
  if (hour < 15) return "weekday-mid";
  return "weekday-pm";
}

/** Minimal quoted-field CSV splitter: handles "Mon, 08:00" and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') current += char;
      else if (line[i + 1] === '"') (current += '"'), i++;
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") (out.push(current), (current = ""));
    else current += char;
  }
  out.push(current);
  return out;
}

function decode(buffer: Buffer): string {
  try {
    return new TextDecoder("macintosh").decode(buffer);
  } catch {
    // Node without full ICU cannot do MacRoman. Every field this module reads
    // is ASCII apart from the em dash placeholders in the notes column.
    return new TextDecoder("latin1").decode(buffer);
  }
}

export function parseHistory(csv: string): DeliveryRecord[] {
  const lines = csv.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
  lines.shift(); // header

  return lines.map((line) => {
    const [id, warehouseId, dayTime, minutes, note = ""] = splitCsvLine(line);
    const [day, time] = dayTime.split(",").map((part) => part.trim());
    if (!id || !warehouseId || !day || !time || minutes === undefined) {
      throw new Error(`unreadable history row: ${line}`);
    }
    if (!(DAYS as readonly string[]).includes(day)) throw new Error(`unknown day "${day}" in row ${id}`);
    return {
      id,
      warehouseId,
      day: day as Day,
      hour: Number(time.split(":")[0]),
      time,
      minutes: Number(minutes),
      note: note.trim(),
    };
  });
}

/** Empty history when the log is not on disk. Never throws for a missing file. */
export function loadHistory(path: string = defaultHistoryPath): DeliveryRecord[] {
  try {
    return parseHistory(decode(readFileSync(path)));
  } catch {
    return [];
  }
}

export const hasHistoryFile = (path: string = defaultHistoryPath): boolean => loadHistory(path).length > 0;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summariseByWarehouse(records: readonly DeliveryRecord[]): Map<string, WarehouseHistory> {
  const grouped = new Map<string, DeliveryRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.warehouseId);
    if (list) list.push(record);
    else grouped.set(record.warehouseId, [record]);
  }

  const out = new Map<string, WarehouseHistory>();
  for (const [warehouseId, list] of grouped) {
    const byBucket: Partial<Record<Bucket, BucketStats>> = {};
    for (const bucket of BUCKETS) {
      const inBucket = list.filter((r) => bucketFor(r.day, r.hour) === bucket).map((r) => r.minutes);
      if (inBucket.length > 0) byBucket[bucket] = { sampleSize: inBucket.length, medianMinutes: median(inBucket) };
    }
    const all = list.map((r) => r.minutes);
    out.set(warehouseId, {
      warehouseId,
      sampleSize: all.length,
      medianMinutes: median(all),
      minMinutes: Math.min(...all),
      maxMinutes: Math.max(...all),
      byBucket,
    });
  }
  return out;
}

/**
 * How much slower each slot is than average, pooled across every warehouse.
 *
 * Reported as a fallback only, and read with care. The buckets mix day-of-week
 * with hour-of-day: most weekend readings in this log fall in the quiet midday
 * window, so the weekend ratio is largely an hour-of-day ratio wearing a
 * different label. With 38 readings the two cannot be separated, and a pooled
 * figure that averages them describes no particular warehouse.
 */
export function pooledBucketRatios(records: readonly DeliveryRecord[]): Record<Bucket, number> {
  const overall = median(records.map((r) => r.minutes));
  const out = {} as Record<Bucket, number>;
  for (const bucket of BUCKETS) {
    const inBucket = records.filter((r) => bucketFor(r.day, r.hour) === bucket).map((r) => r.minutes);
    out[bucket] = overall > 0 && inBucket.length > 0 ? median(inBucket) / overall : 1;
  }
  return out;
}
