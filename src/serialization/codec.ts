import type { Expr, IndexedColumn, TableConstraint } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { defaultFunctionRegistry } from "../functions/registry.ts";
import { IndexStore } from "../indexes/index.ts";
import { DatabaseState, type IndexInfo, type ViewInfo } from "../storage/database-state.ts";
import type { Rowid } from "../storage/row.ts";
import { type ColumnInfo, Table } from "../storage/table.ts";
import { normalizeForCollation } from "../types/collation.ts";
import { asSqlReal, isTruthySql, SqlJsonText, SqlReal, type SqlValue, utf8Decode, utf8Encode } from "../types/value.ts";

const MAGIC = utf8Encode("SQLM");
/** Snapshot format: v1 = schema/rows only; v2 appends PRNG state + clock ms. */
const VERSION = 2;
const VERSION_V1 = 1;

/** PRNG + clock captured alongside schema/rows in a v2 snapshot. */
export interface SnapshotRuntime {
  /** Unsigned 64-bit {@link Prng} state. */
  prngState: bigint;
  /** Clock instant as milliseconds since Unix epoch. */
  nowMs: number;
}

/** Result of {@link decodeDatabaseState}. */
export interface DecodedSnapshot {
  /** Restored catalog and table data. */
  state: DatabaseState;
  /** Present for v2 snapshots; `null` for v1 (schema/rows only). */
  runtime: SnapshotRuntime | null;
}

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(needed: number): void {
    if (this.len + needed <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }
  u32(value: number): void {
    this.ensure(4);
    this.buf[this.len++] = value & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = (value >>> 16) & 0xff;
    this.buf[this.len++] = (value >>> 24) & 0xff;
  }
  u64(value: bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
    this.raw(bytes);
  }
  i64(value: bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    this.raw(bytes);
  }
  raw(value: Uint8Array): void {
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
  }
  text(value: string): void {
    const bytes = utf8Encode(value);
    this.u32(bytes.length);
    this.raw(bytes);
  }
  json(value: unknown): void {
    this.text(JSON.stringify(value, jsonReplacer));
  }
  value(value: SqlValue): void {
    if (value === null) {
      this.u8(0);
      return;
    }
    if (value instanceof SqlReal) {
      this.u8(2);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value.value, true);
      this.raw(bytes);
      return;
    }
    if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
      this.u8(1);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
      this.raw(bytes);
      return;
    }
    if (typeof value === "number") {
      this.u8(2);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value, true);
      this.raw(bytes);
      return;
    }
    if (typeof value === "string") {
      this.u8(3);
      this.text(value);
      return;
    }
    if (value instanceof SqlJsonText) {
      this.u8(3);
      this.text(value.value);
      return;
    }
    this.u8(4);
    this.u32(value.length);
    this.raw(value);
  }
  finish(): Uint8Array {
    // Avoid retaining unused capacity when the buffer grew past the payload.
    if (this.len === this.buf.length) return this.buf;
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u8(): number {
    if (this.offset >= this.bytes.length) this.fail();
    return this.bytes[this.offset++]!;
  }
  u32(): number {
    if (this.offset + 4 > this.bytes.length) this.fail();
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return value;
  }
  u64(): bigint {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }
  i64(): bigint {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
  }
  raw(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) this.fail();
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string {
    return utf8Decode(this.raw(this.u32()));
  }
  json<T>(): T {
    return JSON.parse(this.text(), jsonReviver) as T;
  }
  value(): SqlValue {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) {
      const bytes = this.raw(8);
      const integer = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
      return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(integer)
        : integer;
    }
    if (tag === 2) {
      const bytes = this.raw(8);
      const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
      // Preserve REAL storage class for integer-valued floats across snapshot restore.
      return Number.isInteger(value) && Number.isFinite(value) ? asSqlReal(value) : value;
    }
    if (tag === 3) return this.text();
    if (tag === 4) return this.raw(this.u32());
    this.fail();
  }
  remaining(): number {
    return this.bytes.length - this.offset;
  }
  done(): boolean {
    return this.offset === this.bytes.length;
  }
  private fail(): never {
    throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
  }
}

interface TableMeta {
  name: string;
  columns: ColumnInfo[];
  constraints: TableConstraint[];
  indexes: string[];
  originalSql: string | null;
  withoutRowid?: boolean;
  strict?: boolean;
}

interface IndexMeta {
  name: string;
  tableName: string;
  unique: boolean;
  columns: IndexedColumn[];
  where: Expr | null;
  originalSql: string | null;
}

/**
 * Encode catalog, rows, and runtime into a sqlite-mem snapshot blob (not a `.sqlite` file).
 *
 * Prefer {@link Database.snapshot} unless you are serializing engine state directly.
 */
export function encodeDatabaseState(state: DatabaseState, runtime: SnapshotRuntime): Uint8Array {
  const writer = new Writer();
  writer.raw(MAGIC);
  writer.u32(VERSION);
  writer.u8(state.foreignKeysEnabled ? 1 : 0);
  writer.u32(state.schemaVersion);
  writer.u32(state.changes);
  writer.u32(state.totalChanges);
  writer.value(state.lastInsertRowid);
  writer.u32(state.tables.size);
  for (const table of sortedValues(state.tables)) {
    writer.json({
      name: table.name,
      columns: table.columns,
      constraints: table.constraints,
      indexes: [...table.indexes].sort(compareNames),
      originalSql: table.originalSql,
      withoutRowid: table.withoutRowid || undefined,
      strict: table.strict || undefined,
    });
    writer.value(table.nextRowid);
    const rows = [...table.rows.values()].sort((a, b) => compareRowids(a.rowid, b.rowid));
    writer.u32(rows.length);
    for (const row of rows) {
      writer.value(row.rowid);
      writer.u32(table.columns.length);
      for (const column of table.columns) writer.value(row.values.get(column.name.toLowerCase()) ?? null);
    }
  }
  const views = sortedValues(state.views);
  writer.u32(views.length);
  for (const view of views) writer.json(view);
  const indexes = sortedValues(state.indexes);
  writer.u32(indexes.length);
  for (const index of indexes) {
    writer.json({
      name: index.name,
      tableName: index.tableName,
      unique: index.unique,
      columns: index.columns,
      where: index.where,
      originalSql: index.originalSql,
    });
  }
  writer.u64(runtime.prngState);
  writer.i64(BigInt(Math.trunc(runtime.nowMs)));
  return writer.finish();
}

/**
 * Decode a blob from {@link encodeDatabaseState} / {@link Database.snapshot}.
 *
 * @throws {SqliteError} If the magic, version, or payload is invalid.
 */
export function decodeDatabaseState(snapshot: Uint8Array): DecodedSnapshot {
  const reader = new Reader(snapshot);
  const magic = reader.raw(4);
  if (!magic.every((byte, index) => byte === MAGIC[index]))
    throw new SqliteError("invalid sqlite-mem snapshot magic", "other");
  const version = reader.u32();
  if (version !== VERSION && version !== VERSION_V1) {
    throw new SqliteError(`unsupported sqlite-mem snapshot version: ${version}`, "snapshot_version", "SQLITE_FORMAT");
  }
  const state = new DatabaseState();
  state.foreignKeysEnabled = reader.u8() !== 0;
  state.schemaVersion = reader.u32();
  state.changes = reader.u32();
  state.totalChanges = reader.u32();
  state.lastInsertRowid = asRowid(reader.value());
  const tableCount = reader.u32();
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex++) {
    const meta = reader.json<TableMeta>();
    const table = new Table(meta.name, meta.columns, {
      constraints: meta.constraints,
      indexes: meta.indexes,
      originalSql: meta.originalSql,
      withoutRowid: meta.withoutRowid ?? false,
      strict: meta.strict ?? false,
    });
    table.nextRowid = asRowid(reader.value());
    const rowCount = reader.u32();
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const rowid = asRowid(reader.value());
      const valueCount = reader.u32();
      if (valueCount !== table.columns.length) throw new SqliteError("snapshot row column count mismatch", "other");
      const values = new Map<string, SqlValue>();
      for (const column of table.columns) values.set(column.name.toLowerCase(), reader.value());
      table.rows.set(rowid, { rowid, values });
    }
    table.rebuildClusteredRows();
    state.tables.set(table.name.toLowerCase(), table);
  }
  const viewCount = reader.u32();
  for (let index = 0; index < viewCount; index++) {
    const view = reader.json<ViewInfo>();
    state.views.set(view.name.toLowerCase(), view);
  }
  const indexCount = reader.u32();
  for (let indexPosition = 0; indexPosition < indexCount; indexPosition++) {
    const meta = reader.json<IndexMeta>();
    const info: IndexInfo = { ...meta, store: new IndexStore(meta.name) };
    state.indexes.set(info.name.toLowerCase(), info);
    const table = state.getTable(info.tableName);
    for (const row of table.scan()) {
      if (
        info.where &&
        isTruthySql(
          evalExpr(info.where, {
            functions: defaultFunctionRegistry,
            resolveColumn: (qualifier, name) => {
              if (qualifier && qualifier.toLowerCase() !== table.name.toLowerCase()) {
                throw new SqliteError(`no such column: ${qualifier}.${name}`, "no_such_column");
              }
              if (name.toLowerCase() === "rowid") return row.rowid;
              if (!row.values.has(name.toLowerCase()))
                throw new SqliteError(`no such column: ${name}`, "no_such_column");
              return row.values.get(name.toLowerCase()) ?? null;
            },
            getParameter: () => {
              throw new SqliteError("parameters are not allowed in index predicates", "misuse");
            },
          }),
        ) !== true
      )
        continue;
      info.store.insert(
        info.columns.map((column) =>
          normalizeForCollation(row.values.get(column.name.toLowerCase()) ?? null, column.collate ?? "BINARY"),
        ),
        row.rowid,
        info.unique,
      );
    }
  }

  let runtime: SnapshotRuntime | null = null;
  if (version >= VERSION) {
    if (reader.remaining() < 16) throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
    runtime = {
      prngState: reader.u64(),
      nowMs: Number(reader.i64()),
    };
  }
  if (!reader.done()) throw new SqliteError("snapshot has trailing data", "other");
  return { state, runtime };
}

function asRowid(value: SqlValue): Rowid {
  if ((typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "bigint") return value;
  throw new SqliteError("invalid rowid in snapshot", "other");
}

/** Locale-independent UTF-16 code-unit order for stable snapshot encoding. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRowids(a: Rowid, b: Rowid): number {
  const left = typeof a === "bigint" ? a : BigInt(a);
  const right = typeof b === "bigint" ? b : BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedValues<T extends { name: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => compareNames(a.name, b.name));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $sqlm: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) return { $sqlm: "blob", value: Array.from(value) };
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || !("$sqlm" in value)) return value;
  const tagged = value as { $sqlm: string; value: string | number[] };
  if (tagged.$sqlm === "bigint") return BigInt(tagged.value as string);
  if (tagged.$sqlm === "blob") return Uint8Array.from(tagged.value as number[]);
  return value;
}
