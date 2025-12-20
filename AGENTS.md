# Buildkite Knowledge Base - Agent Guide

This repository is a curated collection of Buildkite's open-source projects, organized as git submodules. It serves as a knowledge base for AI agents and developers working with Buildkite infrastructure.

## Quick Start

```bash
# Sync all repositories (adds missing, updates existing)
uv run sync.py

# Preview changes without making them
uv run sync.py --dry-run
```

## Repository Structure

```
buildkite-knowledge-base/
├── sync.py              # Repository sync tool
├── pyproject.toml       # Python project config
└── repos/               # Submodules directory
    ├── agent/
    ├── agent-stack-k8s/
    ├── buildkite-agent-scaler/
    ├── buildkite-sdk/
    ├── cli/
    ├── docs/
    ├── elastic-ci-stack-for-aws/
    ├── elastic-ci-stack-s3-secrets-hooks/
    ├── lifecycled/
    ├── terraform-buildkite-elastic-ci-stack-for-aws/
    └── test-collector-python/
```

## Repository Summaries

### Core Buildkite Tools

#### `repos/agent/` - Buildkite Agent
**Language:** Go | **Version:** v3.115.2

The build runner that executes jobs on your infrastructure. It polls buildkite.com for work, runs build jobs, reports status, and uploads artifacts.

**Key paths:**
- `clicommand/` - CLI command implementations
- `agent/` - Core agent logic
- `api/` - Buildkite API client

---

#### `repos/cli/` - Buildkite CLI (`bk`)
**Language:** Go | **Version:** v3.16.0

Command-line interface for interacting with Buildkite. Use `bk` to manage pipelines, builds, and artifacts from your terminal.

**Key commands:** `bk build`, `bk pipeline`, `bk artifact`, `bk configure`

---

### Documentation

#### `repos/docs/` - Buildkite Documentation
**Language:** Markdown/MDX | **Pinned:** commit `86bbdc91`

The source files for the official Buildkite documentation at buildkite.com/docs. Contains guides, API references, and examples for all Buildkite products.

**Key paths:**
- `pages/` - Documentation pages organized by topic
- `pages/apis/` - API documentation
- `pages/agent/` - Agent documentation
- `pages/pipelines/` - Pipeline configuration guides

---

### Kubernetes

#### `repos/agent-stack-k8s/` - Agent Stack for Kubernetes
**Language:** Go | **Version:** v0.36.1

A Kubernetes controller that watches for Buildkite jobs and spins up pods to execute them. Enables autoscaling CI/CD on Kubernetes clusters.

**Key paths:**
- `cmd/controller/` - Main controller binary
- `internal/controller/` - Controller logic
- `charts/agent-stack-k8s/` - Helm chart

**Installation:**
```bash
helm install agent-stack-k8s oci://ghcr.io/buildkite/helm/agent-stack-k8s \
    --set agentToken=<your-token>
```

---

### AWS Infrastructure

#### `repos/elastic-ci-stack-for-aws/` - Elastic CI Stack (CloudFormation)
**Language:** CloudFormation/Bash | **Version:** v6.52.0

CloudFormation template for deploying an autoscaling Buildkite agent cluster in AWS. Creates VPC, ASG, and all required infrastructure.

**Key paths:**
- `templates/` - CloudFormation templates
- `packer/` - AMI build configurations
- `plugins/` - Bundled Buildkite plugins

---

#### `repos/buildkite-agent-scaler/` - Agent Scaler Lambda
**Language:** Go | **Version:** v1.10.0

AWS Lambda function that scales an Auto Scaling Group based on Buildkite queue metrics. Provides 300% faster scale-up from zero compared to native ASG rules by polling the Buildkite Metrics API every 10 seconds.

**Key features:**
- Availability-based scaling with configurable thresholds
- Graceful scale-in support with Elastic CI Stack integration
- Optional CloudWatch metrics publishing

**Required env vars:** `BUILDKITE_AGENT_TOKEN`, `BUILDKITE_QUEUE`, `AGENTS_PER_INSTANCE`, `ASG_NAME`

---

#### `repos/terraform-buildkite-elastic-ci-stack-for-aws/` - Elastic CI Stack (Terraform)
**Language:** Terraform | **Version:** v0.6.2

Terraform module equivalent of the CloudFormation stack. Use this if you prefer Terraform for infrastructure management.

**Usage:**
```hcl
module "buildkite_stack" {
  source      = "buildkite/elastic-ci-stack-for-aws/buildkite"
  agent_token = var.buildkite_agent_token
}
```

---

#### `repos/elastic-ci-stack-s3-secrets-hooks/` - S3 Secrets Hooks
**Language:** Go/Bash | **Version:** v2.8.0

Agent hooks that expose secrets from S3 to build steps. Supports SSH keys, environment variables, and git credentials.

**Supported secret types:**
- SSH private keys (via `ssh-agent`)
- Environment variables
- Git credentials (via `git-credential`)

---

#### `repos/lifecycled/` - EC2 Lifecycle Handler
**Language:** Go | **Version:** v3.5.0

Daemon that handles AWS EC2 lifecycle events gracefully. Intercepts ASG termination hooks and Spot instance interruption notices, allowing clean shutdown.

**Key paths:**
- `handler/` - Lifecycle event handlers
- `daemon/` - Main daemon logic

---

### Python SDK & Tools

#### `repos/buildkite-sdk/` - Buildkite SDK
**Languages:** TypeScript, Python, Go, Ruby | **Version:** v0.6.0

Multi-language SDK for programmatically creating Buildkite pipelines. Generates typed pipeline definitions from the Buildkite schema.

**Python usage:**
```python
from buildkite_sdk import Pipeline, CommandStep

pipeline = Pipeline()
pipeline.add_step(CommandStep(command="pytest"))
print(pipeline.to_yaml())
```

---

#### `repos/test-collector-python/` - Test Collector for Python
**Language:** Python | **Version:** v1.2.0

Pytest plugin that sends test results to Buildkite Test Engine for analytics, flaky test detection, and test splitting.

**Installation:**
```bash
uv add --dev buildkite-test-collector
```

**Usage:** Add to `conftest.py` or run with `pytest --buildkite-test-collector`

---

## Managing Repositories

### Adding a New Repository

Edit `sync.py` and add to the `ALLOWED_REPOS` list:

```python
ALLOWED_REPOS: list[str | tuple[str, str]] = [
    # Existing repos...

    # Add new repo (tracks latest):
    "new-repo-name",

    # Or pin to a specific version:
    ("new-repo-name", "v1.0.0"),
]
```

Then run `uv run sync.py` to sync.

### Updating to Latest Versions

To update pinned versions, check the latest tags:

```bash
gh api repos/buildkite/REPO_NAME/tags --jq '.[0].name'
```

Update the version in `sync.py` and run `uv run sync.py`.

### Removing a Repository

Remove it from `ALLOWED_REPOS` in `sync.py` and run `uv run sync.py`. The submodule will be automatically cleaned up.

---

## Tips for Navigating the Codebase

1. **Start with READMEs** - Each `repos/*/README.md` has setup instructions and examples
2. **Check examples/** - Most repos have example configurations
3. **Look for docs/** - Detailed documentation if available
4. **Use grep across repos** - `grep -r "pattern" repos/` to find implementations
5. **Check CHANGELOG.md** - Understand recent changes and breaking updates

## Common Tasks

| Task | Repository | Key File/Path |
|------|------------|---------------|
| Configure agent | `agent` | `clicommand/agent_start.go` |
| Add pipeline step | `buildkite-sdk` | `python/src/buildkite_sdk/` |
| Customize AWS stack | `elastic-ci-stack-for-aws` | `templates/aws-stack.yml` |
| Configure ASG scaling | `buildkite-agent-scaler` | `scaler/` |
| K8s pod templates | `agent-stack-k8s` | `charts/agent-stack-k8s/values.yaml` |
| Add S3 secret | `elastic-ci-stack-s3-secrets-hooks` | `hooks/environment` |
| Handle spot interruption | `lifecycled` | `handler/` |
| Learn about pipelines | `docs` | `pages/pipelines/` |
| API reference | `docs` | `pages/apis/` |
