import {
  runRetrievalBenchmark,
  type RetrievalBenchmarkOptions,
  type RetrievalBenchmarkProfile,
} from "../retrieval_benchmark.js";
import type { QueryContextMode, SourceRefreshMode } from "../query_context.js";
import type {
  SemanticRerankerProviderOption,
  SemanticRetrievalProviderOption,
} from "../semantic_retrieval.js";
import type { CommandResult, GlobalOptions } from "./_types.js";

export interface BenchmarkRetrievalFlags {
  suite?: string;
  profile?: RetrievalBenchmarkProfile;
  limit?: number;
  mode?: QueryContextMode;
  maxContentChars?: number;
  dependencyLimit?: number;
  includeImpact?: boolean;
  impactLimit?: number;
  refreshIndex?: SourceRefreshMode;
  minFileHitRate?: number;
  minNodeHitRate?: number;
  responseBudgetBytes?: number;
  minPayloadBudgetCompliance?: number;
  maxAverageResponseBytes?: number;
  maxAverageLatencyMs?: number;
  semanticProvider?: SemanticRetrievalProviderOption;
  rerankerProvider?: SemanticRerankerProviderOption;
}

export async function benchmarkRetrieval(
  flags: BenchmarkRetrievalFlags,
  options: GlobalOptions,
): Promise<CommandResult> {
  try {
    const benchmarkOptions: RetrievalBenchmarkOptions = {
      suitePath: flags.suite,
      profile: flags.profile,
      limit: flags.limit,
      mode: flags.mode,
      maxContentChars: flags.maxContentChars,
      dependencyLimit: flags.dependencyLimit,
      includeImpact: flags.includeImpact,
      impactLimit: flags.impactLimit,
      refreshIndex: flags.refreshIndex,
      minFileHitRate: flags.minFileHitRate,
      minNodeHitRate: flags.minNodeHitRate,
      responseBudgetBytes: flags.responseBudgetBytes,
      minPayloadBudgetCompliance: flags.minPayloadBudgetCompliance,
      maxAverageResponseBytes: flags.maxAverageResponseBytes,
      maxAverageLatencyMs: flags.maxAverageLatencyMs,
      semantic: flags.semanticProvider
        ? { provider: flags.semanticProvider }
        : undefined,
      reranker: flags.rerankerProvider
        ? { provider: flags.rerankerProvider }
        : undefined,
    };
    const response = await runRetrievalBenchmark(
      options.repoRoot,
      benchmarkOptions,
    );
    if (!response.ok) {
      return {
        exitCode: 1,
        stderr: `${JSON.stringify(response, null, 2)}\n`,
      };
    }
    return {
      exitCode: response.summary.thresholds.passed ? 0 : 1,
      stdout: `${JSON.stringify(response, null, 2)}\n`,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `${JSON.stringify({
        ok: false,
        error: { code: "BENCHMARK_RETRIEVAL_FAILED", message: String(err) },
      })}\n`,
    };
  }
}
