# Deterministic simulation testing (DST)

Dump-after-each differential simulation lives under `tests/fuzz/dst/`:

| Module | Role |
| --- | --- |
| `tests/fuzz/dst/engine.ts` | Dual-engine runner (B-tuple + Dump) |
| `tests/fuzz/dst/ops.ts` | Mixed / DML op vocabulary |
| `tests/fuzz/dst/minimize.ts` | Shrink a failing sequence to SQL |
| `tests/fuzz/dst/repro.ts` | Write corpus / local shrink artifacts |

## Replay

```bash
SQLITE_MEM_FUZZ_SEED=1511514337 bun test tests/fuzz/mixed-stateful.test.ts
SQLITE_MEM_FUZZ_SEED=1511514337 SQLITE_MEM_FUZZ_PATH='0:1' bun test tests/fuzz
```

## Promote a minimized repro

```bash
# After a failure, write an artifact:
#   tests/dst/repros/<slug>.sql  (via writeDstReproArtifact)
bun run scripts/promote-fuzz-repro.ts --slug my-bug --from tests/dst/repros/mixed-….sql
```

Committed forever under `tests/corpus/regressions/` (replayed by `tests/fuzz/corpus.test.ts`).

## Soak overrides

```bash
SQLITE_MEM_MIXED_STEPS=64 SQLITE_MEM_STATEFUL_STEPS=64 SQLITE_MEM_FUZZ_RUNS=100 bun run test:fuzz:soak
```
