import { expectParity } from "./assert.ts";
import type { ContractDb, QueryResult, SqlValue } from "./types.ts";

/**
 * Canonical logical database dump for differential state comparison.
 * Ordered and deterministic so both adapters can be compared via deepCompareResults.
 */
export function dumpLogicalState(db: ContractDb): QueryResult {
  const schema = db.query(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  if (!schema.ok) return schema;

  const tables = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  if (!tables.ok) return tables;

  const tableBlocks: Array<{ name: string; rows: QueryResult; info: QueryResult }> = [];
  for (const row of tables.rows) {
    const name = String(row.name);
    const quoted = quoteIdent(name);
    const info = db.query(`PRAGMA table_info(${quoted})`);
    if (!info.ok) return info;
    const hasRowid = !isWithoutRowid(db, name);
    const rowSql = hasRowid
      ? `SELECT rowid AS __rowid__, * FROM ${quoted} ORDER BY rowid`
      : `SELECT * FROM ${quoted} ORDER BY ${pkOrderColumns(info)}`;
    const rows = db.query(rowSql);
    if (!rows.ok) return rows;
    tableBlocks.push({ name, rows, info });
  }

  const indexRows: Record<string, SqlValue>[] = [];
  for (const row of tables.rows) {
    const name = String(row.name);
    const list = db.query(`PRAGMA index_list(${quoteIdent(name)})`);
    if (!list.ok) return list;
    for (const idx of list.rows) {
      indexRows.push({ table: name, ...idx });
    }
  }

  const fkRows: Record<string, SqlValue>[] = [];
  for (const row of tables.rows) {
    const name = String(row.name);
    const list = db.query(`PRAGMA foreign_key_list(${quoteIdent(name)})`);
    if (!list.ok) return list;
    for (const fk of list.rows) {
      fkRows.push({ child: name, ...fk });
    }
  }

  const columns = ["section", "key", "payload"];
  const outRows: Record<string, SqlValue>[] = [];

  for (const row of schema.rows) {
    outRows.push({
      section: "schema",
      key: `${row.type}:${row.name}`,
      // Omit sql text — formatting differs across engines; structure is checked below.
      payload: String(row.tbl_name ?? ""),
    });
  }

  for (const block of tableBlocks) {
    for (const col of block.info.rows) {
      outRows.push({
        section: "column",
        key: `${block.name}.${col.name}`,
        payload: `${col.cid}|${col.type}|${col.notnull}|${col.dflt_value}|${col.pk}`,
      });
    }
    for (let i = 0; i < block.rows.rows.length; i++) {
      const r = block.rows.rows[i]!;
      outRows.push({
        section: "row",
        key: `${block.name}#${i}`,
        payload: serializeRow(block.rows.columns, r),
      });
    }
  }

  for (const idx of indexRows) {
    const indexName = String(idx.name ?? "");
    if (indexName.startsWith("sqlite_autoindex_")) continue;
    outRows.push({
      section: "index",
      key: `${idx.table}.${idx.name}`,
      payload: `${idx.unique}|${idx.origin}|${idx.partial}`,
    });
  }

  for (const fk of fkRows) {
    outRows.push({
      section: "fk",
      key: `${fk.child}.${fk.id}.${fk.seq}`,
      payload: `${fk.table}|${fk.from}|${fk.to}|${fk.on_update}|${fk.on_delete}|${fk.match}`,
    });
  }

  return {
    ok: true,
    columns,
    rows: outRows,
    changes: 0,
    lastInsertRowid: 0,
  };
}

/** Compare logical dumps from two databases. */
export function expectStateParity(memory: ContractDb, sqlite: ContractDb): void {
  expectParity(dumpLogicalState(memory), dumpLogicalState(sqlite));
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function isWithoutRowid(db: ContractDb, table: string): boolean {
  // Prefer schema SQL when present; sqlite-mem may omit CREATE text.
  const schema = db.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=${sqlString(table)}`,
  );
  if (schema.ok && schema.rows.length > 0) {
    const sql = String(schema.rows[0]!.sql ?? "");
    if (sql.toUpperCase().includes("WITHOUT ROWID")) return true;
  }
  const probe = db.query(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 0`);
  return !probe.ok;
}

function pkOrderColumns(info: QueryResult): string {
  const pks = info.rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk));
  if (pks.length === 0) {
    return info.rows.map((r) => quoteIdent(String(r.name))).join(", ") || "1";
  }
  return pks.map((r) => quoteIdent(String(r.name))).join(", ");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function serializeRow(columns: string[], row: Record<string, SqlValue>): string {
  return columns
    .map((col) => {
      const value = row[col] ?? null;
      if (value === null) return `${col}=NULL`;
      if (value instanceof Uint8Array) {
        const hex = Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
        return `${col}=X'${hex}'`;
      }
      if (typeof value === "bigint") return `${col}=i:${value.toString()}`;
      if (typeof value === "number") {
        return Number.isInteger(value)
          ? `${col}=i:${value}`
          : `${col}=r:${Object.is(value, -0) ? "-0" : String(value)}`;
      }
      return `${col}=t:${JSON.stringify(value)}`;
    })
    .join("|");
}
