---
name: buildkite-diagnose
description: Diagnose failed Buildkite builds by analyzing job logs and detecting common failure patterns
---

# Buildkite Build Diagnosis

When the user asks about a failed Buildkite build, use the `buildkite_analyze_failures` tool to diagnose the issue.

## Workflow

1. **Identify the target build**
   - If user provides a Buildkite URL, extract org, pipeline, and build number (supports /steps/<step-key> URLs)
   - If user provides "org/pipeline build_number", parse the components
   - If user says "latest failed build" or similar, use `buildkite_list_recent_builds` with `state: "failed"` to find candidates
   - If ambiguous, ask the user to specify or select from recent builds

2. **Analyze failures**
   - Call `buildkite_analyze_failures` with the org, pipeline, and build number
   - This tool downloads logs for failed jobs to a temp directory and detects common patterns
   - Note the `log_directory` in the analysis output for where logs are stored
   - Check `analysis.exit_code_summary` for exit code distribution

3. **Examine the evidence**
   - Review the `analysis` field for detected patterns and exit code summary
   - Read log files from the `log_directory` using the `read` tool
   - Look for specific error messages, stack traces, test failures
   - Check `analysis.likely_infra` to determine if it's infrastructure-related
   - If multiple jobs failed, compare their logs for common patterns

4. **Provide diagnosis**
   Structure your response:
   - **Summary**: Which jobs failed, exit codes, and job count
   - **Root Cause**: Your analysis with evidence from logs (quote relevant lines)
   - **Suggested Fix**: Actionable next steps with commands if applicable
   - **Log Excerpts**: Relevant snippets from the logs (use `read` with limit/offset)

## Common Failure Patterns

- **Exit code 137**: OOM kill (out of memory). Look for "Killed" in logs, check memory usage
- **Exit code 143**: Timeout or SIGTERM. Job exceeded timeout limit
- **Exit code 1**: General error. Check logs for specific error messages
- **Exit code 255**: Script error. Often a bash script failure
- **"agent lost"**: Infrastructure issue, agent disconnected
- **"connection refused"**: Service not running or network connectivity issue
- **Test failures**: Look for assertion errors, "FAIL", or test framework output

## Infrastructure vs Code Issues

If `analysis.likely_infra` is true or multiple jobs share the same failure pattern:
- Focus on infrastructure investigation (agents, queues, resource limits)
- Check if failures correlate with specific agents or queues
- Look for system-level errors (OOM, disk space, network)

If failures are isolated to specific tests or steps:
- Focus on code changes in the commit
- Look for test-specific failures or configuration issues
- Check if only certain test suites are affected

## Examples

See the extension README for example diagnoses and common patterns.
