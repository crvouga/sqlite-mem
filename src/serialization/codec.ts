import type { Expr, IndexedColumn, TableConstraint } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { IndexStore } from "../indexes/index.ts";
import { indexKeyValues, rebuildIndexFromTable, tableRowEvalContext } from "../indexes/keys.ts";
import { DatabaseState, type IndexInfo, type ViewInfo } from "../storage/database-state.ts";
import type { Rowid } from "../storage/row.ts";
import { type ColumnInfo, Table } from "../storage/table.ts";
import { asSqlReal, SqlJsonText, SqlReal, type SqlValue, utf8Decode, utf8Encode } from "../types/value.ts";

const MAGIC = utf8Encode("SQLM");
/** Snapshot format: v1 = schema/rows; v2 += PRNG/clock; v3 += IndexStore payloads; v4 = columnar + intern. */
const VERSION = 4;
const VERSION_V1 = 1;
const VERSION_V2 = 2;
const VERSION_V3 = 3;

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
  /** Present for v2+ snapshots; `null` for v1 (schema/rows only). */
  runtime: SnapshotRuntime | null;
}

class Writer {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(needed: number): void {
    if (this.len + needed <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }
  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, value >>> 0, true);
    this.len += 4;
  }
  u64(value: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.len, BigInt.asUintN(64, value), true);
    this.len += 8;
  }
  i64(value: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.len, value, true);
    this.len += 8;
  }
  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, value, true);
    this.len += 8;
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
      this.f64(value.value);
      return;
    }
    if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
      this.u8(1);
      this.i64(BigInt(value));
      return;
    }
    if (typeof value === "number") {
      this.u8(2);
      this.f64(value);
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
    if (this.len === this.buf.length) return this.buf;
    return this.buf.subarray(0, this.len).slice();
  }
}

class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    if (this.offset >= this.bytes.length) this.fail();
    return this.bytes[this.offset++]!;
  }
  u32(): number {
    if (this.offset + 4 > this.bytes.length) this.fail();
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  u64(): bigint {
    if (this.offset + 8 > this.bytes.length) this.fail();
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }
  i64(): bigint {
    if (this.offset + 8 > this.bytes.length) this.fail();
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }
  f64(): number {
    if (this.offset + 8 > this.bytes.length) this.fail();
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
  raw(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) this.fail();
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  owned(length: number): Uint8Array {
    return this.raw(length).slice();
  }
  text(): string {
    return utf8Decode(this.raw(this.u32()));
  }
  json<T>(): T {
    try {
      return JSON.parse(this.text(), jsonReviver) as T;
    } catch {
      throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
    }
  }
  value(): SqlValue {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) {
      const integer = this.i64();
      return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(integer)
        : integer;
    }
    if (tag === 2) {
      const value = this.f64();
      return Number.isInteger(value) && Number.isFinite(value) ? asSqlReal(value) : value;
    }
    if (tag === 3) return this.text();
    if (tag === 4) return this.owned(this.u32());
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
export function encodeDatabaseState(
  state: DatabaseState,
  runtime: SnapshotRuntime,
  formatVersion: number = VERSION,
): Uint8Array {
  if (formatVersion >= 4) return encodeV4(state, runtime);
  return encodeLegacy(state, runtime, formatVersion);
}

function encodeLegacy(state: DatabaseState, runtime: SnapshotRuntime, formatVersion: number): Uint8Array {
  const writer = new Writer();
  writer.raw(MAGIC);
  writer.u32(formatVersion);
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
      for (const column of table.columns) writer.value(table.cell(row, column.nameLower ?? column.name.toLowerCase()));
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
  if (formatVersion >= 3) {
    for (const index of indexes) writeIndexStore(writer, index.store);
  }
  if (formatVersion >= VERSION_V2) {
    writer.u64(runtime.prngState);
    writer.i64(BigInt(Math.trunc(runtime.nowMs)));
  }
  return writer.finish();
}

/**
 * Decode a blob from {@link encodeDatabaseState} / {@link Database.snapshot}.
 *
 * @throws {SqliteError} If the magic, version, or payload is invalid.
 */
export function decodeDatabaseState(snapshot: Uint8Array): DecodedSnapshot {
  try {
    return decodeDatabaseStateInner(snapshot);
  } catch (error) {
    if (error instanceof SqliteError) throw error;
    throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
  }
}

function decodeDatabaseStateInner(snapshot: Uint8Array): DecodedSnapshot {
  const reader = new Reader(snapshot);
  const magic = reader.raw(4);
  if (!magic.every((byte, index) => byte === MAGIC[index]))
    throw new SqliteError("invalid sqlite-mem snapshot magic", "other");
  const version = reader.u32();
  if (version < VERSION_V1 || version > VERSION) {
    throw new SqliteError(`unsupported sqlite-mem snapshot version: ${version}`, "snapshot_version", "SQLITE_FORMAT");
  }
  if (version > VERSION_V3) return decodeV4(reader);
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
      const values: SqlValue[] = [];
      for (let i = 0; i < valueCount; i++) values.push(reader.value());
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
  const loadedIndexes: IndexInfo[] = [];
  for (let indexPosition = 0; indexPosition < indexCount; indexPosition++) {
    const meta = reader.json<IndexMeta>();
    const info: IndexInfo = { ...meta, store: new IndexStore(meta.name) };
    state.indexes.set(info.name.toLowerCase(), info);
    loadedIndexes.push(info);
  }
  if (version >= 3) {
    for (const info of loadedIndexes) {
      info.store = readIndexStore(reader, info.name);
    }
  } else {
    for (const info of loadedIndexes) rebuildIndexStore(state, info);
  }

  let runtime: SnapshotRuntime | null = null;
  if (version >= VERSION_V2) {
    if (reader.remaining() < 16) throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
    runtime = {
      prngState: reader.u64(),
      nowMs: finiteNowMs(Number(reader.i64())),
    };
  }
  if (!reader.done()) throw new SqliteError("snapshot has trailing data", "other");
  return { state, runtime };
}

function writeIndexStore(writer: Writer, store: IndexStore): void {
  const entries = store.snapshotEntries();
  writer.u32(entries.length);
  for (const entry of entries) {
    writer.text(entry.key);
    writer.u32(entry.rowids.length);
    for (const id of entry.rowids) writer.value(id);
    writer.u32(entry.values.length);
    for (const value of entry.values) writer.value(value);
  }
}

function readIndexStore(reader: Reader, name: string): IndexStore {
  const count = reader.u32();
  const entries = new Map<string, Rowid[]>();
  const keyValues = new Map<string, SqlValue[]>();
  for (let i = 0; i < count; i++) {
    const key = reader.text();
    const rowidCount = reader.u32();
    const rowids: Rowid[] = [];
    for (let r = 0; r < rowidCount; r++) rowids.push(asRowid(reader.value()));
    const valueCount = reader.u32();
    const values: SqlValue[] = [];
    for (let v = 0; v < valueCount; v++) values.push(reader.value());
    entries.set(key, rowids);
    keyValues.set(key, values);
  }
  return new IndexStore(name, entries, keyValues);
}

function rebuildIndexStore(state: DatabaseState, info: IndexInfo): void {
  const table = state.getTable(info.tableName);
  rebuildIndexFromTable(info, table, (row) => tableRowEvalContext(table, row));
}

function asRowid(value: SqlValue): Rowid {
  if ((typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "bigint") return value;
  throw new SqliteError("invalid rowid in snapshot", "other");
}

/** Locale-independent UTF-16 code-unit order for stable snapshot encoding. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteNowMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Date only accepts ±1e8 days from epoch; out-of-range values become NaN.
  const max = 8.64e15;
  if (value > max) return max;
  if (value < -max) return -max;
  return value;
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

const PACK_NULL = 0;
const PACK_INT = 1;
const PACK_FLOAT = 2;
const PACK_TEXT = 3;
const PACK_BLOB = 4;
const PACK_TAGGED = 5;

const AFFINITIES: Array<import("../types/value.ts").Affinity> = ["TEXT", "NUMERIC", "INTEGER", "REAL", "BLOB"];

function encodeV4(state: DatabaseState, runtime: SnapshotRuntime): Uint8Array {
  const intern = new Map<string, number>();
  const internList: string[] = [];
  const internId = (s: string): number => {
    const hit = intern.get(s);
    if (hit !== undefined) return hit;
    const id = internList.length;
    intern.set(s, id);
    internList.push(s);
    return id;
  };
  internId("");

  const tables = sortedValues(state.tables);
  const views = sortedValues(state.views);
  const indexes = sortedValues(state.indexes);
  for (const table of tables) {
    internId(table.name);
    internId(table.originalSql ?? "");
    for (const column of table.columns) {
      internId(column.name);
      internId(column.typeName ?? "");
      internId(column.collate ?? "");
    }
    for (const name of table.indexes) internId(name);
    for (const row of table.rows.values()) {
      for (const value of row.values) {
        if (typeof value === "string") internId(value);
        else if (value instanceof SqlJsonText) internId(value.value);
      }
    }
  }

  const w = new Writer();
  w.raw(MAGIC);
  w.u32(VERSION);
  w.u8(state.foreignKeysEnabled ? 1 : 0);
  w.u32(state.schemaVersion);
  w.u32(state.changes);
  w.u32(state.totalChanges);
  w.value(state.lastInsertRowid);
  w.u32(internList.length);
  for (const s of internList) w.text(s);

  w.u32(tables.length);
  for (const table of tables) {
    w.u32(internId(table.name));
    w.u32(table.columns.length);
    for (const column of table.columns) {
      w.u32(internId(column.name));
      w.u32(internId(column.typeName ?? ""));
      const aff = AFFINITIES.indexOf(column.affinity);
      w.u8(aff < 0 ? 2 : aff);
      w.u8(
        (column.notNull ? 1 : 0) |
          (column.primaryKey ? 2 : 0) |
          (column.autoincrement ? 4 : 0) |
          (column.unique ? 8 : 0),
      );
      w.u32(internId(column.collate ?? ""));
      if (column.defaultExpr) {
        w.u8(1);
        w.json(column.defaultExpr);
      } else w.u8(0);
      if (column.generated) {
        w.u8(1);
        w.json(column.generated);
      } else w.u8(0);
    }
    w.json(table.constraints);
    w.u32(internId(table.originalSql ?? ""));
    w.u8((table.withoutRowid ? 1 : 0) | (table.strict ? 2 : 0));
    const indexNames = [...table.indexes].sort(compareNames);
    w.u32(indexNames.length);
    for (const name of indexNames) w.u32(internId(name));
    w.value(table.nextRowid);
    const rows = [...table.rows.values()].sort((a, b) => compareRowids(a.rowid, b.rowid));
    w.u32(rows.length);
    for (const row of rows) w.value(row.rowid);
    for (let c = 0; c < table.columns.length; c++) {
      writePackedColumn(w, rows, c, internId);
    }
  }

  w.u32(views.length);
  for (const view of views) w.json(view);
  w.u32(indexes.length);
  for (const index of indexes) {
    w.json({
      name: index.name,
      tableName: index.tableName,
      unique: index.unique,
      columns: index.columns,
      where: index.where,
      originalSql: index.originalSql,
    });
  }
  for (const index of indexes) {
    const entries = index.store.snapshotKeys();
    w.u32(entries.length);
    for (const entry of entries) {
      w.text(entry.key);
      w.u32(entry.rowids.length);
      for (const id of entry.rowids) w.value(id);
    }
  }
  w.u64(runtime.prngState);
  w.i64(BigInt(Math.trunc(runtime.nowMs)));
  return w.finish();
}

function writePackedColumn(
  w: Writer,
  rows: Array<{ values: SqlValue[] }>,
  col: number,
  internId: (s: string) => number,
): void {
  const n = rows.length;
  if (n === 0) {
    w.u8(PACK_NULL);
    return;
  }
  const bits = new Uint8Array((n + 7) >> 3);
  let nulls = 0;
  let kind: number | null = null;
  for (let i = 0; i < n; i++) {
    const value = rows[i]!.values[col] ?? null;
    if (value === null) {
      bits[i >> 3] = (bits[i >> 3]! | (1 << (i & 7))) as number;
      nulls++;
      continue;
    }
    const cellKind = packKindOf(value);
    if (kind === null) kind = cellKind;
    else if (kind !== cellKind) kind = PACK_TAGGED;
  }
  if (nulls === n) {
    w.u8(PACK_NULL);
    return;
  }
  const pack = kind ?? PACK_TAGGED;
  w.u8(pack);
  w.raw(bits);
  for (let i = 0; i < n; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) continue;
    const value = rows[i]!.values[col]!;
    writePackedCell(w, pack, value, internId);
  }
}

function packKindOf(value: SqlValue): number {
  if (value instanceof SqlReal) return PACK_FLOAT;
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) return PACK_INT;
  if (typeof value === "number") return PACK_FLOAT;
  if (value instanceof SqlJsonText) return PACK_TAGGED;
  if (typeof value === "string") return PACK_TEXT;
  if (value instanceof Uint8Array) return PACK_BLOB;
  return PACK_TAGGED;
}

function writePackedCell(w: Writer, pack: number, value: SqlValue, internId: (s: string) => number): void {
  if (pack === PACK_INT) {
    w.i64(typeof value === "bigint" ? value : BigInt(value as number));
    return;
  }
  if (pack === PACK_FLOAT) {
    w.f64(value instanceof SqlReal ? value.value : (value as number));
    return;
  }
  if (pack === PACK_TEXT) {
    const text = value instanceof SqlJsonText ? value.value : (value as string);
    w.u32(internId(text));
    return;
  }
  if (pack === PACK_BLOB) {
    const blob = value as Uint8Array;
    w.u32(blob.length);
    w.raw(blob);
    return;
  }
  w.value(value);
}

function decodeV4(reader: Reader): DecodedSnapshot {
  const state = new DatabaseState();
  state.foreignKeysEnabled = reader.u8() !== 0;
  state.schemaVersion = reader.u32();
  state.changes = reader.u32();
  state.totalChanges = reader.u32();
  state.lastInsertRowid = asRowid(reader.value());
  const internCount = reader.u32();
  const intern: string[] = [];
  for (let i = 0; i < internCount; i++) intern.push(reader.text());
  const str = (id: number): string => intern[id] ?? "";

  const tableCount = reader.u32();
  for (let t = 0; t < tableCount; t++) {
    const name = str(reader.u32());
    const colCount = reader.u32();
    const columns: ColumnInfo[] = [];
    for (let c = 0; c < colCount; c++) {
      const colName = str(reader.u32());
      const typeName = str(reader.u32()) || null;
      const affIndex = reader.u8();
      const flags = reader.u8();
      const collate = str(reader.u32()) || null;
      const hasDefault = reader.u8() === 1;
      const defaultExpr = hasDefault ? reader.json<Expr>() : null;
      const hasGenerated = reader.u8() === 1;
      const generated = hasGenerated ? reader.json<ColumnInfo["generated"]>() : null;
      columns.push({
        name: colName,
        nameLower: colName.toLowerCase(),
        typeName,
        affinity: AFFINITIES[affIndex] ?? "NUMERIC",
        notNull: (flags & 1) !== 0,
        primaryKey: (flags & 2) !== 0,
        autoincrement: (flags & 4) !== 0,
        unique: (flags & 8) !== 0,
        defaultExpr,
        collate,
        generated,
      });
    }
    const constraints = reader.json<TableConstraint[]>();
    const originalSql = str(reader.u32()) || null;
    const tableFlags = reader.u8();
    const indexCount = reader.u32();
    const indexNames: string[] = [];
    for (let i = 0; i < indexCount; i++) indexNames.push(str(reader.u32()));
    const table = new Table(name, columns, {
      constraints,
      indexes: indexNames,
      originalSql,
      withoutRowid: (tableFlags & 1) !== 0,
      strict: (tableFlags & 2) !== 0,
    });
    table.nextRowid = asRowid(reader.value());
    const rowCount = reader.u32();
    const rowids: Rowid[] = [];
    for (let r = 0; r < rowCount; r++) rowids.push(asRowid(reader.value()));
    const cols: SqlValue[][] = [];
    for (let c = 0; c < colCount; c++) cols.push(readPackedColumn(reader, rowCount, intern));
    for (let r = 0; r < rowCount; r++) {
      const values: SqlValue[] = [];
      for (let c = 0; c < colCount; c++) values.push(cols[c]![r] ?? null);
      const rowid = rowids[r]!;
      table.rows.set(rowid, { rowid, values });
    }
    table.rebuildClusteredRows();
    state.tables.set(table.name.toLowerCase(), table);
  }

  const viewCount = reader.u32();
  for (let i = 0; i < viewCount; i++) {
    const view = reader.json<ViewInfo>();
    state.views.set(view.name.toLowerCase(), view);
  }
  const indexCount = reader.u32();
  const loadedIndexes: IndexInfo[] = [];
  for (let i = 0; i < indexCount; i++) {
    const meta = reader.json<IndexMeta>();
    const info: IndexInfo = { ...meta, store: new IndexStore(meta.name) };
    state.indexes.set(info.name.toLowerCase(), info);
    loadedIndexes.push(info);
  }
  for (const info of loadedIndexes) {
    info.store = readIndexStoreKeys(reader, info.name);
    const table = state.tables.get(info.tableName.toLowerCase());
    if (!table) continue;
    for (const entry of info.store.snapshotKeys()) {
      const rowid = entry.rowids[0];
      if (rowid === undefined) continue;
      const row = table.rows.get(rowid);
      if (!row) continue;
      info.store.rememberKeyValues(
        entry.key,
        indexKeyValues(info.columns, row, tableRowEvalContext(table, row), table),
      );
    }
  }
  if (reader.remaining() < 16) throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
  const runtime: SnapshotRuntime = { prngState: reader.u64(), nowMs: finiteNowMs(Number(reader.i64())) };
  if (!reader.done()) throw new SqliteError("snapshot has trailing data", "other");
  return { state, runtime };
}

function readPackedColumn(reader: Reader, n: number, intern: string[]): SqlValue[] {
  const pack = reader.u8();
  const out: SqlValue[] = new Array(n);
  if (pack === PACK_NULL) {
    for (let i = 0; i < n; i++) out[i] = null;
    return out;
  }
  const bits = reader.raw((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) {
      out[i] = null;
      continue;
    }
    out[i] = readPackedCell(reader, pack, intern);
  }
  return out;
}

function readPackedCell(reader: Reader, pack: number, intern: string[]): SqlValue {
  if (pack === PACK_INT) {
    const integer = reader.i64();
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(integer)
      : integer;
  }
  if (pack === PACK_FLOAT) {
    const value = reader.f64();
    return Number.isInteger(value) && Number.isFinite(value) ? asSqlReal(value) : value;
  }
  if (pack === PACK_TEXT) return intern[reader.u32()] ?? "";
  if (pack === PACK_BLOB) return reader.owned(reader.u32());
  return reader.value();
}

function readIndexStoreKeys(reader: Reader, name: string): IndexStore {
  const count = reader.u32();
  const entries = new Map<string, Rowid[]>();
  for (let i = 0; i < count; i++) {
    const key = reader.text();
    const rowidCount = reader.u32();
    const rowids: Rowid[] = [];
    for (let r = 0; r < rowidCount; r++) rowids.push(asRowid(reader.value()));
    entries.set(key, rowids);
  }
  return new IndexStore(name, entries);
}
