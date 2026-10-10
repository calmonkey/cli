# Token budgets, measured

Written by `test/budgets.test.ts` on every run: tiktoken `o200k_base`, on the fixtures of `test/helpers/fixtures.ts`. The test fails when a row goes over its budget, and when this file is not what it measures.

| Output | Budget (tokens) | Measured |
|---|---|---|
| Root `--help` | 400 | 329 |
| One command's `--help` (largest) | 400 | 400 (`events list`) |
| `agent-guide` | 450 | 432 |
| `schema <command>` (largest) | 600 | 412 (`upsertEvent`) |
| List, default (20 rows) | 900 | 786 |
| The same list with `--json` | 6,000 | 1402 |
| `events get`, default | 500 | 296; 354 with a 500-character description |
| `freebusy`, default (14 days) | 600 | 567; 600 with `--free` |
| `--count` | 150 | 104 |
| `status` | 150 | 100 |
| Error | 120 | 62 to 118 |
| `explain <code>` (largest) | 120 | 96 (`config_not_writable`) |
| Confirmation block | 150 | 148 |
| AGENTS.md section | 200 | 196 |
| SKILL.md body | 1,500 | 1176 |
