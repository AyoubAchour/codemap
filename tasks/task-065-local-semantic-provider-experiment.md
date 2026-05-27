# Task 065: Local Semantic Provider Experiment

**Status:** done
**Phase:** Phase 4 / retrieval
**Estimate:** 4-7 days
**Depends on:** task-058, task-059

## Goal

Test whether a bundled local embedding provider materially improves compact
recall quality enough to justify opt-in runtime support.

## Context

Agentmemory reports a large R@5 improvement from BM25-only to BM25+vector on
LongMemEval-S. Codemap already has semantic retrieval adapters, but providers
are disabled by default and benchmark-only. The next step is evidence, not a
default dependency.

## Deliverables

- A local embedding provider behind the existing semantic retrieval adapter
  interface.
- Benchmark wiring that compares lexical-only, graph-only, mixed, and
  local-vector variants.
- Install/runtime cost notes.
- Recommendation on whether to keep it benchmark-only, ship as opt-in, or drop
  it.

## Steps

1. Pick a local provider that works on Linux without API keys.
2. Wire it into benchmark-only provider selection.
3. Run the recall benchmark from task 058.
4. Compare recall quality, latency, storage, install size, and failure modes.
5. Record the recommendation in the task file and docs.

## Exit Criteria

- [x] Default Codemap install remains local-only and no-hosted-service.
- [x] Provider use is explicit and visibly reported.
- [x] Benchmark results show whether quality gains justify the cost.
- [x] Runtime enablement is deferred unless evidence is strong.

## Notes

This task exists to avoid cargo-culting Agentmemory's vector path. If lexical
and graph recall are already good enough, do not ship extra dependency weight.

## Implementation Notes

Implemented `--semantic-provider local-hash` as a dependency-free,
benchmark-only hashing-vector provider over the existing source index. It uses
repo path, symbols, imports, exports, and indexed text to produce local vectors
without adding model downloads, native runtime dependencies, network calls, or
runtime `query_context` behavior.

The benchmark response now includes variant metrics for:

- `lexical_files`
- `graph_files`
- `mixed_files`
- `local_vector_files`

Provider cost check on 2026-05-27:

- `fastembed@2.1.0` pulls `onnxruntime-node`, tokenizer, Hugging Face Hub, and
  archive dependencies.
- `@huggingface/transformers@4.2.0` pulls ONNX Runtime, tokenizer, and `sharp`
  dependencies.
- `@xenova/transformers@2.17.2` is older and substantially larger at the
  package level.

The experiment therefore starts with `local-hash` and leaves heavier model
providers for a follow-up only if there is a clear benchmark gap.

Current Codemap recall suite, `--profile recall --refresh-index if_stale`:

| Run | Queries | Lexical hit | Lexical recall | Graph-file hit | Mixed hit | Local-vector hit | Local-vector recall | Semantic latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| disabled | 14 | 1.0000 | 0.5774 | 0.0000 | 1.0000 | 0.0000 | 0.0000 | 0 ms |
| local-hash | 14 | 1.0000 | 0.5774 | 0.0000 | 1.0000 | 0.7857 | 0.5476 | 112.7857 ms |

Fixture suite, `benchmarks/fixtures/taskflow-app`:

| Run | Queries | Lexical hit | Lexical recall | Mixed hit | Local-vector hit | Local-vector recall | Semantic latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| disabled | 6 | 1.0000 | 1.0000 | 1.0000 | 0.0000 | 0.0000 | 0 ms |
| local-hash | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.8333 ms |

Recommendation: keep semantic retrieval benchmark-only. `local-hash` is cheap
and useful as a built-in comparison point, but it did not beat lexical recall on
the Codemap suite and adds extra per-query work. Do not promote semantic
retrieval into runtime recall unless a real local model provider produces a
measurable recall/payload win that justifies install and maintenance cost.
