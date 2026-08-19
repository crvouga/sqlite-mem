import { parity, sequenceParity } from "../helpers.ts";

const accountSchema = [
  "CREATE TABLE accounts(id INTEGER PRIMARY KEY, email TEXT UNIQUE, username TEXT UNIQUE, score INTEGER)",
  "INSERT INTO accounts VALUES (1,'a@example.test','alice',10)",
];

parity(
  "UPSERT DO UPDATE returns the updated row",
  accountSchema,
  "INSERT INTO accounts VALUES (1,'new@example.test','new-name',7) ON CONFLICT(id) DO UPDATE SET score=accounts.score+excluded.score RETURNING id,email,username,score",
);

sequenceParity("UPSERT DO UPDATE WHERE skips a false update", accountSchema, [
  {
    sql: "INSERT INTO accounts VALUES (1,'new@example.test','new-name',7) ON CONFLICT(id) DO UPDATE SET score=excluded.score WHERE excluded.score>accounts.score",
  },
  { sql: "SELECT * FROM accounts", query: true },
]);

sequenceParity(
  "INSERT SELECT feeds UPSERT",
  [
    ...accountSchema,
    "CREATE TABLE incoming(id INTEGER,email TEXT,username TEXT,score INTEGER)",
    "INSERT INTO incoming VALUES (1,'ignored@example.test','ignored',12),(2,'b@example.test','bob',4)",
  ],
  [
    {
      sql: "INSERT INTO accounts SELECT * FROM incoming WHERE 1 ON CONFLICT(id) DO UPDATE SET score=excluded.score",
    },
    { sql: "SELECT * FROM accounts ORDER BY id", query: true },
  ],
);

sequenceParity("targetless ON CONFLICT updates whichever unique constraint conflicts", accountSchema, [
  {
    sql: "INSERT INTO accounts VALUES (2,'a@example.test','other',20) ON CONFLICT DO UPDATE SET score=excluded.score",
  },
  {
    sql: "INSERT INTO accounts VALUES (3,'other@example.test','alice',30) ON CONFLICT DO UPDATE SET score=excluded.score",
  },
  { sql: "SELECT * FROM accounts", query: true },
]);
