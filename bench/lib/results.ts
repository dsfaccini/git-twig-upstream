import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value.length)
    throw new Error("Expected nonempty string");
  return value;
}
export function invariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
export async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
  await rename(temporary, path);
}
export async function allocate(
  root: string,
  binaryHash: string,
  target: string,
  date = new Date(),
): Promise<string> {
  invariant(/^[a-f0-9]{64}$/.test(binaryHash), "Invalid binary hash");
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target), "Invalid target");
  const parent = join(
    root,
    `sha256-${binaryHash.slice(0, 12)}`,
    target,
    date.toISOString().slice(0, 10),
  );
  await mkdir(parent, { recursive: true });
  const path = join(
    parent,
    `run-${date.toISOString().slice(11, 23).replaceAll(":", "")}-${randomUUID()}`,
  );
  await mkdir(path); // New-only: never resume or overwrite a previous run.
  return path;
}
