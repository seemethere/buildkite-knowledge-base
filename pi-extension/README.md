# Buildkite Diagnose for Pi

A pi extension and skill for diagnosing Buildkite build failures.

## Features

- Analyze failed Buildkite builds automatically
- Download job logs to local temp files for inspection
- Detect common failure patterns (OOM, timeouts, infrastructure issues)
- Compare multiple failed jobs to identify systemic issues
- Support for Buildkite URLs, org/pipeline syntax, and interactive selection

## Installation

### From this repo

```bash
pi install git:github.com/buildkite/buildkite-knowledge-base/pi-extension
```

### Manual installation

Copy the files to your pi directories:

```bash
# Extension
cp extensions/buildkite-diagnose.ts ~/.pi/agent/extensions/

# Skill
mkdir -p ~/.pi/agent/skills/buildkite-diagnose
cp skills/buildkite-diagnose/SKILL.md ~/.pi/agent/skills/buildkite-diagnose/
```

Then reload pi with `/reload`.

## Setup

Set your Buildkite API token:

```bash
export BUILDKITE_API_TOKEN=your-token-here
```

Or create `~/.buildkite/api-token` with your token.

Get a token from: https://buildkite.com/user/api-access-tokens
Required scopes: `read_builds`, `read_pipelines`

## Usage

### Diagnose a specific build

```
/diagnose https://buildkite.com/my-org/my-pipeline/builds/123
```

Or:

```
/diagnose my-org/my-pipeline 123
```

### Natural language

Just ask pi:

> "Why did the build fail?"
> "Diagnose the latest failed build on my-pipeline"
> "What's wrong with build 456?"

The skill will guide the agent to use the tools appropriately.

## Tools

### `buildkite_analyze_failures`

Analyzes a failed build by downloading logs and detecting patterns.

**Parameters:**
- `org` (string): Organization slug
- `pipeline` (string): Pipeline slug
- `build_number` (number): Build number
- `max_jobs` (number, optional): Max failed jobs to analyze (default: 5)

**Returns:**
- Build metadata
- List of failed jobs with log file paths
- Analysis of common patterns (exit codes, shared agents/queues)

### `buildkite_list_recent_builds`

List recent builds for a pipeline.

**Parameters:**
- `org` (string): Organization slug
- `pipeline` (string): Pipeline slug
- `state` (string, optional): Filter by state (e.g., "failed")
- `branch` (string, optional): Filter by branch
- `limit` (number, optional): Max builds to return (default: 10)

### `buildkite_list_pipelines`

List all pipelines in an organization.

**Parameters:**
- `org` (string): Organization slug

## How It Works

1. **Fetch build data** via Buildkite GraphQL API
2. **Identify failed jobs** from the build
3. **Download logs** in parallel to temp files
4. **Detect patterns** like common exit codes or shared infrastructure
5. **Return structured data** for the LLM to analyze

The LLM (guided by the Skill) then:
- Reads the log files using pi's `read` tool
- Searches for specific error patterns using `bash` (grep)
- Provides a diagnosis with root cause and suggested fixes

## Example Diagnosis

> **Summary**: Build #123 failed with 2 failed jobs: "test" (exit 1) and "lint" (exit 1)
>
> **Root Cause**: Both jobs failed during npm install with "ETIMEDOUT" errors connecting to the npm registry. This appears to be a network connectivity issue rather than code problems.
>
> **Suggested Fix**: Check network connectivity to registry.npmjs.org from your agents. Consider using a private npm mirror or retrying the build.
>
> **Log Excerpts**: [relevant snippets from logs]

## Common Patterns Detected

- **Exit 137**: Out of memory (OOM kill)
- **Exit 143**: Timeout or SIGTERM
- **Shared agent/queue**: Infrastructure issue affecting multiple jobs
- **"Killed" in logs**: Process was terminated, likely OOM
- **"agent lost"**: Agent disconnected unexpectedly

## Development

To test the extension:

```bash
# Run pi with the extension
pi -e ./extensions/buildkite-diagnose.ts

# Or install locally
pi install git:file:///path/to/pi-extension
```

## License

MIT
