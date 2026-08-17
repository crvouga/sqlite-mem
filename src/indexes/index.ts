import { SqliteError } from "../errors/index.ts";
import { isSqlJsonText, isSqlReal, type SqlValue } from "../types/value.ts";
import type { Rowid } from "../storage/row.ts";

export class IndexStore {
  readonly name: string;
  private entries: Map<string, Rowid>;

  constructor(name = "index", entries?: ReadonlyMap<string, Rowid>) {
    this.name = name;
    this.entries = new Map(entries);
  }

  checkUnique(values: readonly SqlValue[], rowid?: Rowid): void {
    const key = serializeIndexKey(values);
    if (key === null) return;
    const existing = this.entries.get(key);
    if (existing !== undefined && (rowid === undefined || !sameRowid(existing, rowid))) {
      throw new SqliteError(`UNIQUE constraint failed: ${this.name}`, "constraint_unique", "SQLITE_CONSTRAINT_UNIQUE");
    }
  }

  insert(values: readonly SqlValue[], rowid: Rowid): void {
    const key = serializeIndexKey(values);
    if (key === null) return;
    this.checkUnique(values, rowid);
    this.entries.set(key, rowid);
  }

  remove(values: readonly SqlValue[], rowid?: Rowid): boolean {
    const key = serializeIndexKey(values);
    if (key === null) return false;
    if (rowid !== undefined) {
      const existing = this.entries.get(key);
      if (existing === undefined || !sameRowid(existing, rowid)) return false;
    }
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  clone(): IndexStore {
    return new IndexStore(this.name, this.entries);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function serializeIndexKey(values: readonly SqlValue[]): string | null {
  if (values.some((value) => value === null)) return null;
  return (values as readonly Exclude<SqlValue, null>[])
    .map(serializeValue)
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

function serializeValue(value: Exclude<SqlValue, null>): string {
  if (isSqlReal(value)) {
    const n = value.value;
    if (Number.isNaN(n)) return "f:nan";
    if (n === Infinity) return "f:+inf";
    if (n === -Infinity) return "f:-inf";
    return `f:${Object.is(n, -0) ? "0" : n.toString()}`;
  }
  if (isSqlJsonText(value)) return `t:${value.value}`;
  if (typeof value === "bigint") return `n:${value.toString()}`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `n:${BigInt(value).toString()}`;
    if (Number.isNaN(value)) return "f:nan";
    if (value === Infinity) return "f:+inf";
    if (value === -Infinity) return "f:-inf";
    return `f:${Object.is(value, -0) ? "0" : value.toString()}`;
  }
  if (typeof value === "string") return `t:${value}`;
  let hex = "";
  for (const byte of value) hex += byte.toString(16).padStart(2, "0");
  return `b:${hex}`;
}

function sameRowid(left: Rowid, right: Rowid): boolean {
  return typeof left === "bigint" || typeof right === "bigint"
    ? BigInt(left) === BigInt(right)
    : left === right;
}
