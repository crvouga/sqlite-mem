import { parity } from "../helpers.ts";

parity(
  "json_group_array accepts aggregate ORDER BY",
  ["CREATE TABLE t(id INTEGER,v TEXT)", "INSERT INTO t VALUES (2,'b'),(1,'a'),(3,'c')"],
  "SELECT json_group_array(v ORDER BY id DESC) AS value FROM t",
);

parity(
  "json_valid flags distinguish canonical JSON and JSON5",
  [],
  "SELECT json_valid('{\"a\":1}',1) AS canonical,json_valid('{a:1}',1) AS strict_json5,json_valid('{a:1}',2) AS json5",
);

parity(
  "json_remove accepts multiple paths",
  [],
  "SELECT json_remove('{\"a\":1,\"b\":2,\"c\":3}','$.a','$.c') AS value",
);

parity(
  "json_set accepts multiple path value pairs",
  [],
  "SELECT json_set('{\"a\":1}','$.b',2,'$.c',json('[3]')) AS value",
);

parity(
  "JSON constructors distinguish SQL NULL and parsed JSON null",
  [],
  "SELECT json_set('{}','$.sql_null',NULL,'$.json_null',json('null')) AS set_value,json_object('sql_null',NULL,'json_null',json('null')) AS object_value",
);
