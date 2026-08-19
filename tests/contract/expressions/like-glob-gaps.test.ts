import { queryErrorParity, parity } from "../helpers.ts";

parity(
  "LIKE handles NULL empty patterns and blobs",
  [],
  "SELECT NULL LIKE 'x' AS null_lhs,'x' LIKE NULL AS null_rhs,'' LIKE '' AS empty_match,'x' LIKE '' AS empty_miss,X'6162' LIKE 'ab' AS blob_match",
);

parity(
  "LIKE remains ASCII-only case insensitive",
  [],
  "SELECT 'a' LIKE 'A' AS ascii_match,'ß' LIKE 'SS' AS unicode_miss",
);

queryErrorParity("LIKE rejects an empty ESCAPE expression", [], "SELECT 'a' LIKE 'a' ESCAPE ''");

parity(
  "NOT GLOB negates GLOB and preserves NULL",
  [],
  "SELECT 'abc' NOT GLOB 'a*' AS no_match,'xyz' NOT GLOB 'a*' AS match,NULL NOT GLOB '*' AS null_value",
);
