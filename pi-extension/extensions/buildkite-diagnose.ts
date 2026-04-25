/**
 * Buildkite Build Diagnosis Extension
 *
 * Provides tools to diagnose failed Buildkite builds by analyzing job logs
 * and detecting common failure patterns.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

interface BuildkiteJob {
  id: string;
  uuid: string;
  label: string;
  state: string;
  exitCode: number | null;
  agent: {
    name: string;
    queue: string;
  } | null;
  step: {
    key: string;
  } | null;
}

interface BuildkiteBuild {
  number: number;
  state: string;
  branch: string;
  commit: string;
  message: string;
  jobs: BuildkiteJob[];
}

interface FailedJobInfo {
  id: string;
  name: string;
  step_key: string | null;
  exit_code: number | null;
  agent: { name: string; queue: string } | null;
  log_path: string;
  log_size: number;
  state: string;
}

interface PatternMatch {
  pattern: string;
  count: number;
  jobs: string[];
}

interface ExitCodeSummary {
  code: number | null;
  count: number;
}

interface AnalysisResult {
  common_exit_codes: (number | null)[];
  common_patterns: string[];
  shared_agent: boolean;
  shared_queue: boolean;
  likely_infra: boolean;
  log_directory: string;
  pattern_matches: PatternMatch[];
  exit_code_summary: ExitCodeSummary[];
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch build data from Buildkite REST API
 * Using REST instead of GraphQL for simplicity and reliability
 */

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get Buildkite API token from env or config file
 */
async function getApiToken(): Promise<string> {
  // Check env var first
  const envToken = process.env.BUILDKITE_API_TOKEN;
  if (envToken) {
    return envToken;
  }

  // Try config file
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const configPath = join(homedir(), ".buildkite", "api-token");
    const token = await readFile(configPath, "utf8");
    return token.trim();
  } catch {
    // Fall through to error
  }

  throw new Error(
    "Buildkite API token not found. Set BUILDKITE_API_TOKEN env var or create ~/.buildkite/api-token"
  );
}

/**
 * Parse various Buildkite URL formats
 */
function parseBuildkiteUrl(url: string): {
  org: string;
  pipeline: string;
  buildNumber: number;
  jobId?: string;
  stepKey?: string;
} | null {
  // Web URL: https://buildkite.com/org/pipeline/builds/123
  // With job fragment: https://buildkite.com/org/pipeline/builds/123#job-uuid
  // With step: https://buildkite.com/org/pipeline/builds/123/steps/step-key
  const webMatch = url.match(
    /buildkite\.com\/([^/]+)\/([^/]+)\/builds\/(\d+)(?:\/steps\/([^/#]+))?(?:#(.+))?/
  );
  if (webMatch) {
    return {
      org: webMatch[1],
      pipeline: webMatch[2],
      buildNumber: parseInt(webMatch[3], 10),
      stepKey: webMatch[4],
      jobId: webMatch[5],
    };
  }

  // API URL: https://api.buildkite.com/v2/organizations/org/pipelines/pipeline/builds/123
  const apiMatch = url.match(
    /api\.buildkite\.com\/v2\/organizations\/([^/]+)\/pipelines\/([^/]+)\/builds\/(\d+)/
  );
  if (apiMatch) {
    return {
      org: apiMatch[1],
      pipeline: apiMatch[2],
      buildNumber: parseInt(apiMatch[3], 10),
    };
  }

  // Job log URL: .../builds/123/jobs/job-uuid/log
  const jobMatch = url.match(
    /builds\/(\d+)\/jobs\/([^/]+)/
  );
  if (jobMatch && url.includes("buildkite.com")) {
    // Try to extract org/pipeline from URL
    const orgPipeMatch = url.match(
      /(?:organizations|buildkite\.com)\/([^/]+)\/pipelines\/([^/]+)/
    );
    if (orgPipeMatch) {
      return {
        org: orgPipeMatch[1],
        pipeline: orgPipeMatch[2],
        buildNumber: parseInt(jobMatch[1], 10),
        jobId: jobMatch[2],
      };
    }
  }

  return null;
}

/**
 * Fetch build data from Buildkite GraphQL API
 */
async function fetchBuild(
  org: string,
  pipeline: string,
  buildNumber: number,
  token: string
): Promise<BuildkiteBuild> {
  const url = `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Buildkite API error: ${response.status} ${response.statusText}`
    );
  }

  const build = await response.json();

  if (!build || !build.number) {
    throw new Error(
      `Build not found: ${org}/${pipeline}#${buildNumber}`
    );
  }

  // Transform jobs to our internal format
  const jobs: BuildkiteJob[] = (build.jobs || [])
    .filter((job: any) => job && job.type === "script")
    .map((job: any) => ({
      id: job.id,
      uuid: job.id, // REST API uses id as uuid
      label: job.name || job.label || "",
      state: job.state,
      exitCode: job.exit_status,
      agent: job.agent
        ? {
            name: job.agent.name,
            queue: job.agent.queue || "default",
          }
        : null,
      step: job.step_key ? { key: job.step_key } : null,
    }));

  return {
    number: build.number,
    state: build.state,
    branch: build.branch,
    commit: build.commit,
    message: build.message,
    jobs,
  };
}

/**
 * Download job log to temp file
 */
async function downloadJobLog(
  org: string,
  pipeline: string,
  buildNumber: number,
  jobId: string,
  token: string,
  logDir: string
): Promise<{ path: string; size: number }> {
  const url = `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}/jobs/${jobId}/log`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download log: ${response.statusText}`);
  }

  const logData = await response.json();
  const logContent = logData.content || "";

  // Write to temp file (logDir already created by caller)
  const logPath = join(logDir, `${jobId}.log`);
  await writeFile(logPath, logContent, "utf8");

  return {
    path: logPath,
    size: Buffer.byteLength(logContent, "utf8"),
  };
}

/**
 * Detect common patterns in failed jobs
 */
function detectPatterns(
  jobs: FailedJobInfo[],
  logDir: string
): AnalysisResult {
  const exitCodes = jobs.map((j) => j.exit_code);
  const uniqueExitCodes = [...new Set(exitCodes)];

  // Count exit codes
  const exitCodeCounts = new Map<number | null, number>();
  for (const code of exitCodes) {
    exitCodeCounts.set(code, (exitCodeCounts.get(code) || 0) + 1);
  }
  const exitCodeSummary: ExitCodeSummary[] = Array.from(
    exitCodeCounts.entries()
  ).map(([code, count]) => ({ code, count }));

  const patterns: string[] = [];
  const patternMatches: PatternMatch[] = [];

  // Check for OOM (exit code 137)
  if (exitCodes.includes(137)) {
    const count = exitCodes.filter((c) => c === 137).length;
    patterns.push(`OOM kill detected (exit code 137) in ${count} job(s)`);
  }

  // Check for timeout (exit code 143)
  if (exitCodes.includes(143)) {
    const count = exitCodes.filter((c) => c === 143).length;
    patterns.push(`Timeout or SIGTERM (exit code 143) in ${count} job(s)`);
  }

  // Check for script errors (exit code 255)
  if (exitCodes.includes(255)) {
    const count = exitCodes.filter((c) => c === 255).length;
    patterns.push(`Script error (exit code 255) in ${count} job(s)`);
  }

  // Check for general errors (exit code 1 or 2)
  const error1Count = exitCodes.filter((c) => c === 1).length;
  const error2Count = exitCodes.filter((c) => c === 2).length;
  if (error1Count > 0) {
    patterns.push(`General error (exit code 1) in ${error1Count} job(s)`);
  }
  if (error2Count > 0) {
    patterns.push(`General error (exit code 2) in ${error2Count} job(s)`);
  }

  // Check if all jobs share the same agent
  const agents = jobs.map((j) => j.agent?.name).filter(Boolean);
  const sharedAgent = agents.length > 1 && new Set(agents).size === 1;
  if (sharedAgent && agents[0]) {
    patterns.push(`All failures on same agent: ${agents[0]}`);
  }

  // Check if all jobs share the same queue
  const queues = jobs.map((j) => j.agent?.queue).filter(Boolean);
  const sharedQueue = queues.length > 1 && new Set(queues).size === 1;
  if (sharedQueue && queues[0]) {
    patterns.push(`All failures on same queue: ${queues[0]}`);
  }

  // Heuristic: likely infra if >50% share exit code or agent/queue
  const likelyInfra =
    uniqueExitCodes.length === 1 || sharedAgent || sharedQueue;

  return {
    common_exit_codes: uniqueExitCodes,
    common_patterns: patterns,
    shared_agent: sharedAgent,
    shared_queue: sharedQueue,
    likely_infra: likelyInfra,
    log_directory: logDir,
    pattern_matches: patternMatches,
    exit_code_summary: exitCodeSummary,
  };
}

// ============================================================================
// Extension Definition
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Main tool: analyze build failures
  pi.registerTool({
    name: "buildkite_analyze_failures",
    label: "Analyze Buildkite Failures",
    description:
      "Analyze a failed Buildkite build by downloading job logs and detecting common failure patterns. Provide org, pipeline, and build number.",
    parameters: Type.Object({
      org: Type.String({ description: "Buildkite organization slug" }),
      pipeline: Type.String({ description: "Pipeline slug" }),
      build_number: Type.Number({ description: "Build number" }),
      max_jobs: Type.Optional(
        Type.Number({
          description:
            "Maximum number of failed jobs to analyze (default: 5)",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { org, pipeline, build_number, max_jobs = 5 } = params;

      try {
        const token = await getApiToken();

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Fetching build ${org}/${pipeline}#${build_number}...`,
            },
          ],
        });

        const build = await fetchBuild(org, pipeline, build_number, token);

        // Find failed jobs
        const failedJobs = build.jobs.filter(
          (job) => job.state === "failed" || job.state === "timed_out"
        );

        if (failedJobs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Build ${build_number} has no failed jobs (state: ${build.state})`,
              },
            ],
            details: { build, failed_jobs: [], analysis: null },
          };
        }

        // Limit number of jobs to analyze
        const jobsToAnalyze = failedJobs.slice(0, max_jobs);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Downloading logs for ${jobsToAnalyze.length} failed job(s)...`,
            },
          ],
        });

        // Create log directory
        const tmpDir = tmpdir();
        const logDir = join(tmpDir, "buildkite-diagnose", `${org}-${pipeline}-${build_number}`);
        await mkdir(logDir, { recursive: true });

        // Download logs in parallel
        const jobInfos: FailedJobInfo[] = await Promise.all(
          jobsToAnalyze.map(async (job) => {
            try {
              const { path, size } = await downloadJobLog(
                org,
                pipeline,
                build_number,
                job.uuid,
                token,
                logDir
              );

              return {
                id: job.uuid,
                name: job.label || job.step?.key || job.id,
                step_key: job.step?.key || null,
                exit_code: job.exitCode,
                agent: job.agent,
                log_path: path,
                log_size: size,
                state: job.state,
              };
            } catch (error) {
              // If log download fails, still return job info
              return {
                id: job.uuid,
                name: job.label || job.step?.key || job.id,
                step_key: job.step?.key || null,
                exit_code: job.exitCode,
                agent: job.agent,
                log_path: "",
                log_size: 0,
                state: job.state,
              };
            }
          })
        );

        const analysis = detectPatterns(jobInfos, logDir);

        const exitSummary = analysis.exit_code_summary
          .map((s) => `exit ${s.code}: ${s.count} job(s)`)
          .join(", ");

        return {
          content: [
            {
              type: "text",
              text: `Analyzed ${jobInfos.length} failed job(s) from build ${build_number}. ${exitSummary}. Logs saved to: ${analysis.log_directory}. ${
                analysis.likely_infra
                  ? "Common patterns detected - likely infrastructure issue."
                  : "No common infrastructure patterns detected."
              }`,
            },
          ],
          details: {
            build: {
              number: build.number,
              state: build.state,
              branch: build.branch,
              commit: build.commit,
              message: build.message,
            },
            failed_jobs: jobInfos,
            analysis,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to analyze build: ${message}`);
      }
    },
  });

  // Helper tool: list recent builds
  pi.registerTool({
    name: "buildkite_list_recent_builds",
    label: "List Recent Buildkite Builds",
    description:
      "List recent builds for a pipeline, optionally filtered by state or branch",
    parameters: Type.Object({
      org: Type.String({ description: "Buildkite organization slug" }),
      pipeline: Type.String({ description: "Pipeline slug" }),
      state: Type.Optional(
        Type.String({
          description:
            "Filter by build state: passed, failed, running, etc.",
        })
      ),
      branch: Type.Optional(
        Type.String({ description: "Filter by branch name" })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of builds to return (default: 10)",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { org, pipeline, state, branch, limit = 10 } = params;

      try {
        const token = await getApiToken();

        const queryParams = new URLSearchParams({
          per_page: limit.toString(),
        });
        if (state) queryParams.append("state", state);
        if (branch) queryParams.append("branch", branch);

        const url = `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds?${queryParams}`;

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error(
            `API error: ${response.status} ${response.statusText}`
          );
        }

        const builds = await response.json();

        return {
          content: [
            {
              type: "text",
              text: `Found ${builds.length} build(s) for ${pipeline}`,
            },
          ],
          details: { builds },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list builds: ${message}`);
      }
    },
  });

  // Helper tool: list pipelines
  pi.registerTool({
    name: "buildkite_list_pipelines",
    label: "List Buildkite Pipelines",
    description: "List all pipelines in an organization",
    parameters: Type.Object({
      org: Type.String({ description: "Buildkite organization slug" }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { org } = params;

      try {
        const token = await getApiToken();

        const url = `https://api.buildkite.com/v2/organizations/${org}/pipelines?per_page=100`;

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error(
            `API error: ${response.status} ${response.statusText}`
          );
        }

        const pipelines = await response.json();

        return {
          content: [
            {
              type: "text",
              text: `Found ${pipelines.length} pipeline(s) in ${org}`,
            },
          ],
          details: { pipelines },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list pipelines: ${message}`);
      }
    },
  });

  // Command: /diagnose
  pi.registerCommand("diagnose", {
    description: "Diagnose a Buildkite build failure",
    handler: async (args, ctx) => {
      // Parse args: could be URL, or "org/pipeline build_number", or empty
      const trimmed = args.trim();

      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /diagnose <buildkite-url> or /diagnose <org>/<pipeline> <build-number>",
          "info"
        );
        return;
      }

      // Try to parse as URL first
      const urlMatch = parseBuildkiteUrl(trimmed);
      if (urlMatch) {
        const { org, pipeline, buildNumber } = urlMatch;
        pi.sendUserMessage(
          `Diagnose the failed build at ${org}/${pipeline}#${buildNumber}`,
          { deliverAs: "steer" }
        );
        return;
      }

      // Try to parse as "org/pipeline build_number"
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const orgPipeline = parts[0];
        const buildNumber = parseInt(parts[1], 10);

        if (orgPipeline.includes("/")) {
          const [org, pipeline] = orgPipeline.split("/", 2);
          if (!isNaN(buildNumber)) {
            pi.sendUserMessage(
              `Diagnose the failed build at ${org}/${pipeline}#${buildNumber}`,
              { deliverAs: "steer" }
            );
            return;
          }
        }
      }

      ctx.ui.notify(
        "Could not parse arguments. Use: /diagnose <url> or /diagnose <org>/<pipeline> <build-number>",
        "error"
      );
    },
  });
}
