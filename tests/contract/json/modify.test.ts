import { parity } from "../helpers.ts";

parity("json_insert skips existing", [], `SELECT json_insert('{"a":2,"c":4}', '$.a', 99)`);
parity("json_insert creates", [], `SELECT json_insert('{"a":2,"c":4}', '$.e', 99)`);
parity("json_replace overwrites", [], `SELECT json_replace('{"a":2,"c":4}', '$.a', 99)`);
parity("json_replace skips missing", [], `SELECT json_replace('{"a":2,"c":4}', '$.e', 99)`);
parity("json_set overwrite", [], `SELECT json_set('{"a":2,"c":4}', '$.a', 99)`);
parity("json_set create", [], `SELECT json_set('{"a":2,"c":4}', '$.e', 99)`);
parity("json_set quotes plain text", [], `SELECT json_set('{"a":2,"c":4}', '$.c', '[97,96]')`);
parity("json_set nests json()", [], `SELECT json_set('{"a":2,"c":4}', '$.c', json('[97,96]'))`);
parity("json_set append [#]", [], `SELECT json_set('[0,1,2]', '$[#]', 'new')`);
parity("json_set replace [#-1]", [], `SELECT json_set('[0,1,2]', '$[#-1]', 9)`);
parity("json_insert append", [], `SELECT json_insert('[1,2,3,4]', '$[#]', 99)`);
parity("json_remove key", [], `SELECT json_remove('{"a":1,"b":2}', '$.b')`);
parity("json_patch merge", [], `SELECT json_patch('{"a":1,"b":2}', '{"b":null,"c":3}')`);
