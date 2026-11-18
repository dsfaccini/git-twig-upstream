import { invariant } from "./results.ts";

/** Preserve exact bytes separately; never display a tiny fraction of a larger unit. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  invariant(Number.isSafeInteger(bytes), "Bytes must be an exact safe integer");
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = Math.abs(bytes),
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  let rounded =
    Math.round(value * (unit > 0 && value < 100 ? 10 : 1)) /
    (unit > 0 && value < 100 ? 10 : 1);
  if (rounded >= 1024 && unit < units.length - 1) {
    rounded = 1;
    unit++;
  }
  return (bytes < 0 ? "-" : "") + rounded + " " + units[unit];
}
