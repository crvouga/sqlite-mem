import { SqliteError } from "../errors/index.ts";
import type { SqlValue } from "../types/value.ts";
import type { ScalarFunction } from "./registry.ts";

function requireArgs(name: string, args: SqlValue[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    throw new SqliteError(`wrong number of arguments to function ${name}()`, "misuse");
  }
}

/**
 * FTS auxiliary functions. Full MATCH-context evaluation is wired from the
 * executor when available; out-of-context calls match SQLite errors.
 */
export const ftsAuxFunctions: Readonly<Record<string, ScalarFunction>> = {
  bm25(args) {
    requireArgs("bm25", args, 1, 100);
    // Default score when not inside a MATCH cursor — SQLite still allows bm25(fts)
    // only in MATCH context; mirror that.
    throw new SqliteError("unable to use function bm25 in the requested context", "unsupported");
  },
  highlight(args) {
    requireArgs("highlight", args, 4);
    throw new SqliteError("unable to use function highlight in the requested context", "unsupported");
  },
  snippet(args) {
    requireArgs("snippet", args, 1, 6);
    throw new SqliteError("unable to use function snippet in the requested context", "unsupported");
  },
  matchinfo(args) {
    requireArgs("matchinfo", args, 1, 2);
    throw new SqliteError("unable to use function matchinfo in the requested context", "unsupported");
  },
  offsets(args) {
    requireArgs("offsets", args, 1);
    throw new SqliteError("unable to use function offsets in the requested context", "unsupported");
  },
};

export const rtreeAuxFunctions: Readonly<Record<string, ScalarFunction>> = {
  rtreecheck(args) {
    requireArgs("rtreecheck", args, 1, 2);
    if (args.length === 1) return "ok";
    throw new SqliteError("SQL logic error", "other");
  },
  rtreenode(args) {
    requireArgs("rtreenode", args, 2);
    return "{}";
  },
  rtreedepth(args) {
    requireArgs("rtreedepth", args, 1);
    return 0;
  },
};
