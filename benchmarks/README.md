# Retrieval Benchmarks

Codemap retrieval benchmarks are local, deterministic query suites. They exist
to show where the current graph/source retrieval path works, where it misses,
and whether optional semantic retrieval or reranking is justified.

Run the default suite from the repository root:

```sh
codemap benchmark-retrieval --refresh-index if_stale
```

The default suite lives at `benchmarks/retrieval.codemap.json`. It should cover
more than happy-path symbol lookup:

- semantic wording that does not exactly match exported names
- typo-heavy queries that still include enough intent to diagnose misses
- cross-file impact questions
- renamed symbol and re-export cases
- stale graph / source-anchor repair cases
- docs and tests discovery

Each query must include at least one of `expected_files` or `expected_nodes`.
Use `tags` to label the scenario family so aggregate misses can be grouped
manually after a run.

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
