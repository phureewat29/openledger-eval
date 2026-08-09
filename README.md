# OpenLedger Evaluation

Measures how fit the OpenLedger product, the `oled` CLI and its shipped
`SKILL.md`, is for LLM agents. Every run drives a ladder of models through
OpenRouter against the real CLI in a throwaway sandbox, grades the results
deterministically, and writes a cross-model leaderboard. Rerun it after
changing openledger to see what got better and what broke.

## The Three Suites

**Ingest** — the model gets a password-locked card statement (126 rows). It
must find the file, run `oled ingest prepare`, read the extracted text, and
post every row with `oled ingest commit`, then resolve what the ledger
flagged. Scoring reads the ledger back and compares it with the statement's
fact file: row counts, group totals, uncategorized ratio, open questions,
file lifecycle, net worth. Twelve scored assertions plus one reported line for
rows the statement's own groups can't see (the opening balance), no prose
parsing.

Eval versions before 2.0.0 called this suite **record**, so their reports label
these results `record`; nothing rewrites them.

**Record** — the model gets transactions as text: a markdown table, a scribbled
note, a CSV export. No file, no extraction. It must turn that text into correct
`oled` calls, working from the chart of accounts it was handed and nothing else.
Five cases, 20 to 50 rows each, and the prompt never says how many. Each case
runs in two phases: record the rows, then resolve whatever the ledger flagged.
Creating an account costs a turn, so the cap is tight; in two cases it sits below
the row count, which forces the rows into batches. One case is in a currency the
sandbox has no ledger for, so its first commit is refused and the model has to
open the ledger and retry.

Scoring reads the ledger back: the row count, which doubles as the double-post
check since a re-committed batch posts everything twice; every date and amount,
counted, so a row moved to another day, two rows merged into their sum or one row
split in two fails even where the balances still tie; one balance per account in
minor units; nothing under `<ccy>:expense:uncategorized`; nothing under
`<ccy>:equity:adjustments`, the account `accounts adjust` posts the other side of
a forced balance to, which is what stops a run setting all 18 balances by hand
and recording nothing; and no question left open or deferred, since deferring one
is not answering it. Descriptions are not scored: a model may reword them, and
the date and the amount already pin a row. The expected ledger is derived from
the case's own rows, so a wrong fixture fails at startup rather than failing a
model. The journey — turns used against both caps, nonzero exits by name,
refusals, repeated commands — is reported beside the checks and never graded.

**Query** — the sandbox is seeded with 40 known transactions. The model gets
`SKILL.md` and one question, answers it with the CLI, and must finish by
calling `submit_answer`. Twelve cases, from "how many transactions" to a
paging case a single page cannot answer and a currency trap that fails any
model that sums THB and USD. Golden answers live in the fixture and are
re-derived from the seed rows at startup; a mismatch refuses to run.

## Setup

1. Build the CLI under test: `cd ../openledger && npm run build`. Another
   checkout works too; point `OLED_REPO_ROOT` at it.
2. `cp .env.example .env` and set `OPENROUTER_API_KEY`.
3. `npm install`.

Node 18+, macOS or Linux.

## Run

`npm run dashboard` is the way in: pick a suite, tick the models, press
launch, and watch the grid fill. See [Dashboard](#dashboard).

The dashboard starts runs by spawning `npm start`, which also stands on its
own for a headless run:

```sh
npm start -- --suite all                 # every model in models.json, every suite
npm start -- --suite ingest --suite query
npm start -- --model deepseek/deepseek-v4-flash
```

| Flag | Meaning |
| --- | --- |
| `--suite ingest\|record\|query\|all` | repeatable; which suites to run (default all) |
| `--model <id>` | repeatable; overrides `models.json` |
| `--concurrency <n>` | parallel runs (default: one lane per model, capped at 8) |

Every case runs once. There is no way to ask for repeats: a second trial
doubles a matrix that costs real money, and rerunning the whole invocation
tells you the same thing when a result looks unstable.

Candidates come from `models.json`, a plain array of OpenRouter ids. Ids
are checked against the OpenRouter model list at startup; an unknown id,
or a model without tool calling, is skipped and listed with its reason.
Each model's context budget derives from its own OpenRouter window (80%
of it, a 28k-token floor when the window isn't published) — there is no
global knob. Exit 0 means every run was graded (failing grades are data);
1 means some run hit an endpoint or sandbox error; 2 means bad usage.

Each run is hermetic: a fresh temp directory with its own home, and its own
`oled` install from a tarball packed once per invocation. The CLI reads no
environment configuration, so every default it has — the config file, the
database, the data and cache directories — resolves under that home, and the
run then pins the three paths again on the `oled config --init` command line so
the harness and the CLI agree on where a statement is read from. Runs execute
several at a time and share nothing: no `OLED_*` variable is passed through,
and each sandbox has its own config file. Nothing touches your real `~/.oled`,
and no OCR endpoint is configured, which the harness checks after init rather
than assumes.

## Reports

One invocation writes one iteration under `reports/<timestamp>/`:

- `leaderboard.md` — ranked per-suite tables: cases passed, pass rate,
  time, tokens in/out, cost, tool calls. Committed to git as the
  regression trail.
- `benchmark.json` — the same data machine-readable, plus the identity
  block: oled version, tarball sha, skill version and sha, eval version.
  Also committed.
- `runs/<model>/<suite>/<case>[-t<n>].{json,md}` — per-run
  detail: every assertion with want/got evidence, metrics, counters, and
  the full event stream, including what each `oled` call was piped and what
  it replied. Written as each run is graded. Ignored by git.

Cost comes from OpenRouter's published pricing times reported usage and
shows `—` when the endpoint omitted usage. Query tool-call counts include
the one `submit_answer` call. `reports/archive/` holds two runs from the
pre-rebuild harness; their schema is older and nothing loads them.

## Dashboard

```sh
npm run dev                  # Vite (page) + the API, with hot reload
npm start                    # build the page, then serve everything from :4000
npm run dev -- --port 8080   # the API on another port
```

In development the page is Vite's and the API is a second process; open the URL
Vite prints — it binds `localhost`, not `127.0.0.1`. `npm start` builds the page
and serves it from the API itself, so there is one process and one port.

A web app over the same `reports/` directory, and nothing else: it reads what
the harness leaves behind and owns only the launch slot. It listens on loopback,
and the two things that cost something — starting a run and deleting a sandbox —
are refused unless the request came from its own page.
# openledger-eval
