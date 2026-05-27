# Retrieval Benchmarks

Codemap retrieval benchmarks are local, deterministic query suites. They exist
to show where the current graph/source retrieval path works, where it misses,
and whether optional semantic retrieval or reranking is justified.

They are retrieval and recall benchmarks, not full autonomous-agent evals. A
passing run means the right context and guardrails are available within budget;
it does not prove an agent will make the right edit.

Run the default suite from the repository root:

```sh
codemap benchmark-retrieval --refresh-index if_stale
```

The default profile is `planning`, which uses the normal `query_context`
benchmark defaults. Use the `recall` profile when you want a smaller,
Agentmemory-style context packet baseline before implementing `recall_context`:

```sh
codemap benchmark-retrieval --profile recall --refresh-index if_stale
```

Payload and latency budgets can be turned into gates:

```sh
codemap benchmark-retrieval \
  --profile recall \
  --response-budget-bytes 65000 \
  --min-payload-budget-compliance 1 \
  --max-average-response-bytes 65000 \
  --max-average-latency-ms 500
```

The JSON summary reports:

- file and node hit rate, precision, recall, and MRR
- forbidden file/node violations and false-positive rate
- expected warning and result-source recall
- per-query and aggregate response bytes
- payload-budget compliance
- average, p50, p95, and max latency
- source-file diversity
- optional semantic/reranker adapter results

Semantic retrieval and reranking are disabled by default. The CLI currently
accepts `--semantic-provider disabled`, `--semantic-provider local-hash`, and
`--reranker-provider disabled`. `local-hash` is a dependency-free
benchmark-only comparison point over the source index; heavier provider
experiments should be wired through the benchmark adapter interfaces first,
then compared against the same suite before runtime retrieval changes.

The default suite lives at `benchmarks/retrieval.codemap.json`. It should cover
more than happy-path symbol lookup:

- semantic wording that does not exactly match exported names
- typo-heavy queries that still include enough intent to diagnose misses
- cross-file impact questions
- renamed symbol and re-export cases
- stale graph / source-anchor repair cases
- docs and tests discovery

Each query must include at least one positive expectation, forbidden
expectation, warning expectation, or result-source expectation. Use `tags` to
label the scenario family so aggregate misses can be grouped manually after a
run.

Queries may also include guardrail expectations:

- `forbidden_files` and `forbidden_nodes` detect irrelevant or noisy context
  that should not consume the agent's limited budget.
- `expected_warnings` matches stable warning substrings, such as source-index
  or stale-memory provenance warnings.
- `expected_result_sources` checks which evidence lanes returned results:
  `graph`, `source`, `semantic`, or `reranker`.

These guardrails are metrics, not default threshold failures. Use them to decide
which ranking or packaging optimization deserves a follow-up task.

The first follow-up optimization is deliberately local and lexical. Source
search filters common query stop words before path/symbol/import/export boosts,
matches those structured fields by tokens instead of arbitrary substrings,
demotes archive-like content unless requested, and de-prioritizes disconnected
files for explicit impact/review queries. This keeps compact context from being
filled by weak distractors before any semantic provider is considered.

Queries may include `response_budget_bytes` when a specific case needs its own
payload gate. The `--response-budget-bytes` CLI flag applies one budget to every
query in the run.

## Fixture Repositories

Fixture repositories live under `benchmarks/fixtures/`. They are small repos
that exercise retrieval behavior outside Codemap's own vocabulary.

The `taskflow-app` fixture includes:

- TypeScript source files with imports and a renamed export
- a Markdown operations document
- a test file
- `benchmarks/retrieval.fixture.json`, which can be run with:

```sh
cd benchmarks/fixtures/taskflow-app
codemap benchmark-retrieval benchmarks/retrieval.fixture.json --refresh-index if_stale
```

When adding a fixture, keep it tiny and purposeful. Prefer six to ten queries
that each target one retrieval weakness over a broad synthetic application.
