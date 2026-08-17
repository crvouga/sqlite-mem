import { SqliteError } from "../errors/index.ts";
import type { Rowid } from "../storage/row.ts";
import { isSqlJsonText, isSqlReal, type SqlValue } from "../types/value.ts";

export class IndexStore {
  readonly name: string;
  private entries: Map<string, Rowid[]>;

  constructor(name = "index", entries?: ReadonlyMap<string, readonly Rowid[]>) {
    this.name = name;
    this.entries = new Map();
    if (entries) {
      for (const [key, rowids] of entries) this.entries.set(key, [...rowids]);
    }
  }

  checkUnique(values: readonly SqlValue[], rowid?: Rowid): void {
    const key = serializeIndexKey(values);
    if (key === null) return;
    const existing = this.entries.get(key);
    if (!existing) return;
    for (const id of existing) {
      if (rowid === undefined || !sameRowid(id, rowid)) {
        throw new SqliteError(
          `UNIQUE constraint failed: ${this.name}`,
          "constraint_unique",
          "SQLITE_CONSTRAINT_UNIQUE",
        );
      }
    }
  }

  insert(values: readonly SqlValue[], rowid: Rowid, unique = true): void {
    const key = serializeIndexKey(values);
    if (key === null) return;
    if (unique) this.checkUnique(values, rowid);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, [rowid]);
      return;
    }
    for (const id of existing) if (sameRowid(id, rowid)) return;
    existing.push(rowid);
  }

  lookup(values: readonly SqlValue[]): readonly Rowid[] {
    const key = serializeIndexKey(values);
    if (key === null) return [];
    return this.entries.get(key) ?? [];
  }

  remove(values: readonly SqlValue[], rowid?: Rowid): boolean {
    const key = serializeIndexKey(values);
    if (key === null) return false;
    const existing = this.entries.get(key);
    if (!existing) return false;
    if (rowid === undefined) {
      this.entries.delete(key);
      return true;
    }
    const index = existing.findIndex((id) => sameRowid(id, rowid));
    if (index < 0) return false;
    existing.splice(index, 1);
    if (existing.length === 0) this.entries.delete(key);
    return true;
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
  return typeof left === "bigint" || typeof right === "bigint" ? BigInt(left) === BigInt(right) : left === right;
}
