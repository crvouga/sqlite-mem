import { SqliteError } from "../errors/index.ts";
import {
  affinityFromTypeName,
  applyAffinity,
  coerceToNumber,
  compareSql,
  storageClassOf,
  typeofSql,
  utf8Decode,
  utf8Encode,
  type SqlValue,
} from "../types/value.ts";
import type { FunctionContext, ScalarFunction } from "./registry.ts";

function text(value: SqlValue): string {
  if (value instanceof Uint8Array) return utf8Decode(value);
  return String(value);
}

function numeric(value: SqlValue): number {
  return coerceToNumber(value) ?? 0;
}

export function castSqlValue(value: SqlValue, typeName: string): SqlValue {
  const affinity = affinityFromTypeName(typeName);
  if (value === null) return null;
  if (affinity === "BLOB") {
    return value instanceof Uint8Array ? value : utf8Encode(text(value));
  }
  if (affinity === "TEXT") return text(value);
  if (affinity === "INTEGER") return Math.trunc(coerceToNumber(value) ?? 0);
  if (affinity === "REAL") return coerceToNumber(value) ?? 0;
  return applyAffinity(value, "NUMERIC");
}

function trimChars(value: string, chars: string, left: boolean, right: boolean): string {
  const set = new Set([...chars]);
  const input = [...value];
  let start = 0;
  let end = input.length;
  if (left) while (start < end && set.has(input[start]!)) start++;
  if (right) while (end > start && set.has(input[end - 1]!)) end--;
  return input.slice(start, end).join("");
}

function substr(value: string, startValue: number, lengthValue?: number): string {
  const chars = [...value];
  let start = Math.trunc(startValue);
  let index = start > 0 ? start - 1 : start < 0 ? chars.length + start : 0;
  index = Math.max(0, index);
  if (lengthValue === undefined) return chars.slice(index).join("");
  const length = Math.trunc(lengthValue);
  if (length >= 0) return chars.slice(index, index + length).join("");
  return chars.slice(Math.max(0, index + length), index).join("");
}

function formatPrintf(format: string, args: SqlValue[]): string {
  let index = 0;
  return format.replace(/%([0 +\-#]*)(\d+)?(?:\.(\d+))?([%sdifgGxXcqQ])/g,
    (_match, flags: string, widthText: string | undefined, precisionText: string | undefined, kind: string) => {
      if (kind === "%") return "%";
      const value = args[index++] ?? null;
      const precision = precisionText === undefined ? undefined : Number(precisionText);
      let result: string;
      switch (kind) {
        case "d":
        case "i": result = String(Math.trunc(numeric(value))); break;
        case "f": result = numeric(value).toFixed(precision ?? 6); break;
        case "g":
        case "G": result = numeric(value).toPrecision(precision ?? 6).replace(/\.?0+(e|$)/i, "$1"); break;
        case "x":
        case "X": result = Math.trunc(numeric(value)).toString(16); break;
        case "c": result = String.fromCodePoint(Math.trunc(numeric(value))); break;
        case "q": result = value === null ? "(NULL)" : text(value).replace(/'/g, "''"); break;
        case "Q": result = value === null ? "NULL" : `'${text(value).replace(/'/g, "''")}'`; break;
        default: result = value === null ? "" : text(value);
      }
      if (kind === "G" || kind === "X") result = result.toUpperCase();
      const width = Number(widthText ?? 0);
      if (width > result.length) {
        const pad = flags.includes("0") ? "0" : " ";
        result = flags.includes("-") ? result.padEnd(width, pad) : result.padStart(width, pad);
      }
      return result;
    });
}

function requireArgs(name: string, args: SqlValue[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    throw new SqliteError(`wrong number of arguments to function ${name}()`, "misuse");
  }
}

const scalarFunctions: Record<string, ScalarFunction> = {
  abs(args) {
    requireArgs("abs", args, 1);
    const value = args[0]!;
    if (value === null) return null;
    if (typeof value === "bigint") return value < 0n ? -value : value;
    return Math.abs(numeric(value));
  },
  coalesce(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function coalesce()", "misuse");
    return args.find((value) => value !== null) ?? null;
  },
  ifnull(args) {
    requireArgs("ifnull", args, 2);
    return args[0] ?? args[1]!;
  },
  nullif(args) {
    requireArgs("nullif", args, 2);
    const comparison = compareSql(args[0]!, args[1]!);
    return comparison === 0 ? null : args[0]!;
  },
  typeof(args) {
    requireArgs("typeof", args, 1);
    return typeofSql(args[0]!);
  },
  length(args) {
    requireArgs("length", args, 1);
    const value = args[0]!;
    if (value === null) return null;
    if (value instanceof Uint8Array) return value.length;
    return [...text(value)].length;
  },
  lower(args) {
    requireArgs("lower", args, 1);
    return args[0] === null ? null : text(args[0]!).replace(/[A-Z]/g, (c) => c.toLowerCase());
  },
  upper(args) {
    requireArgs("upper", args, 1);
    return args[0] === null ? null : text(args[0]!).replace(/[a-z]/g, (c) => c.toUpperCase());
  },
  trim(args) {
    requireArgs("trim", args, 1, 2);
    if (args[0] === null || args[1] === null) return null;
    return trimChars(text(args[0]!), args[1] === undefined ? " " : text(args[1]), true, true);
  },
  ltrim(args) {
    requireArgs("ltrim", args, 1, 2);
    if (args[0] === null || args[1] === null) return null;
    return trimChars(text(args[0]!), args[1] === undefined ? " " : text(args[1]), true, false);
  },
  rtrim(args) {
    requireArgs("rtrim", args, 1, 2);
    if (args[0] === null || args[1] === null) return null;
    return trimChars(text(args[0]!), args[1] === undefined ? " " : text(args[1]), false, true);
  },
  substr(args) {
    requireArgs("substr", args, 2, 3);
    if (args[0] === null || args[1] === null || args[2] === null) return null;
    return substr(text(args[0]!), numeric(args[1]!), args[2] === undefined ? undefined : numeric(args[2]));
  },
  substring(args, context) {
    return scalarFunctions.substr!(args, context);
  },
  replace(args) {
    requireArgs("replace", args, 3);
    if (args.some((value) => value === null)) return null;
    const search = text(args[1]!);
    return search === "" ? text(args[0]!) : text(args[0]!).split(search).join(text(args[2]!));
  },
  round(args) {
    requireArgs("round", args, 1, 2);
    if (args[0] === null) return null;
    const places = Math.max(0, Math.min(30, Math.trunc(numeric(args[1] ?? 0))));
    const factor = 10 ** places;
    const scaled = numeric(args[0]!) * factor;
    return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / factor;
  },
  min(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function min()", "misuse");
    if (args.some((value) => value === null)) return null;
    return args.reduce((best, value) => (compareSql(value, best)! < 0 ? value : best));
  },
  max(args) {
    if (args.length < 2) throw new SqliteError("wrong number of arguments to function max()", "misuse");
    if (args.some((value) => value === null)) return null;
    return args.reduce((best, value) => (compareSql(value, best)! > 0 ? value : best));
  },
  random(args, context) {
    requireArgs("random", args, 0);
    if (context.random) return context.random();
    // Fallback deterministic stream when evaluated outside a Database (e.g. unit helpers).
    return 0n;
  },
  randomblob(args, context) {
    requireArgs("randomblob", args, 1);
    if (args[0] === null) return null;
    const length = Math.max(0, Math.trunc(numeric(args[0]!)));
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const bits = context.randomU64?.() ?? 0n;
      for (let shift = 0; shift < 64 && offset < length; shift += 8) {
        out[offset++] = Number((bits >> BigInt(shift)) & 0xffn);
      }
    }
    return out;
  },
  zeroblob(args) {
    requireArgs("zeroblob", args, 1);
    if (args[0] === null) return null;
    const length = Math.max(0, Math.trunc(numeric(args[0]!)));
    return new Uint8Array(length);
  },
  hex(args) {
    requireArgs("hex", args, 1);
    if (args[0] === null) return "";
    const bytes = args[0] instanceof Uint8Array ? args[0] : utf8Encode(text(args[0]!));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  },
  quote(args) {
    requireArgs("quote", args, 1);
    const value = args[0]!;
    if (value === null) return "NULL";
    if (value instanceof Uint8Array) return `X'${scalarFunctions.hex!([value], {})}'`;
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === "number" && !Number.isFinite(value)) return value < 0 ? "-9.0e+999" : "9.0e+999";
    return String(value);
  },
  printf(args) {
    if (args.length === 0 || args[0] === null) return null;
    return formatPrintf(text(args[0]!), args.slice(1));
  },
  changes(args, context) {
    requireArgs("changes", args, 0);
    return context.changes?.() ?? 0;
  },
  last_insert_rowid(args, context) {
    requireArgs("last_insert_rowid", args, 0);
    return context.lastInsertRowid?.() ?? 0;
  },
};

export function getScalarFunctions(): Readonly<Record<string, ScalarFunction>> {
  return scalarFunctions;
}

export function invokeScalar(name: string, args: SqlValue[], context: FunctionContext = {}): SqlValue {
  const fn = scalarFunctions[name.toLowerCase()];
  if (!fn) throw new SqliteError(`no such function: ${name}`, "other");
  return fn(args, context);
}

export { storageClassOf };
