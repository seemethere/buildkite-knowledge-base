# Rootless BuildKit Runners on AWS with Multi-Cloud Support

> **Use Case**: Spinning up rootless BuildKit runners on AWS as Buildkite agents, with infrastructure that can extend to other clouds and support varied workloads (tests, GPU/TPU, etc.)

## Recommendation: Agent Stack for Kubernetes

For rootless BuildKit runners on AWS with future multi-cloud and varied workload support, **Agent Stack for Kubernetes (agent-stack-k8s)** is the best fit.

### Why Kubernetes over Elastic CI Stack

| Consideration | Agent Stack for K8s | Elastic CI Stack (EC2) |
|--------------|---------------------|------------------------|
| **Multi-cloud** | Runs anywhere (EKS, GKE, AKS, on-prem) | AWS-only |
| **Rootless BuildKit** | First-class support with 3 security tiers | Possible but requires custom AMI work |
| **GPU/TPU** | Resource Classes with node selectors | Requires separate ASG per GPU type |
| **Workload variety** | Per-job pod specs via plugin | Instance types bound to stack |
| **Scaling** | Native K8s pod scaling | Lambda-based ASG scaling |

---

## Queue Strategy: Separate Queues per Workload Type

**Important**: Use separate queues for different workload types rather than a single shared queue. This provides:

- **Accurate queue time metrics** - Each queue reflects wait time for its specific resource type
- **Independent scaling signals** - Queue depth accurately reflects demand per node pool
- **Better scheduling** - Jobs don't block behind unrelated workloads
- **Cost visibility** - Track resource usage and costs per workload type

### Recommended Queue Structure

| Queue | Purpose | Node Pool | Controller Instance |
|-------|---------|-----------|---------------------|
| `aws-test` | Unit/integration tests | Standard compute | Controller 1 |
| `aws-buildkit` | Container image builds | Builder nodes | Controller 2 |
| `aws-gpu` | ML training/inference | GPU nodes (A100, etc.) | Controller 3 |
| `gcp-tpu` | TPU workloads | TPU node pools | Controller 4 (GKE) |

### Deployment: One Controller per Queue

Deploy separate controller instances for each queue to enable independent scaling:

```bash
# Tests queue
helm install bk-test oci://ghcr.io/buildkite/helm/agent-stack-k8s \
  --set agentToken=$TOKEN \
  --set config.queue=aws-test \
  --namespace buildkite-test \
  -f values-test.yaml

# BuildKit queue
helm install bk-buildkit oci://ghcr.io/buildkite/helm/agent-stack-k8s \
  --set agentToken=$TOKEN \
  --set config.queue=aws-buildkit \
  --namespace buildkite-buildkit \
  -f values-buildkit.yaml

# GPU queue
helm install bk-gpu oci://ghcr.io/buildkite/helm/agent-stack-k8s \
  --set agentToken=$TOKEN \
  --set config.queue=aws-gpu \
  --namespace buildkite-gpu \
  -f values-gpu.yaml
```

This approach means:
- Each controller only watches its designated queue
- Node autoscaling (Karpenter/Cluster Autoscaler) responds to each queue's demand independently
- Queue metrics in Buildkite accurately reflect wait times per resource type

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                        │
│  (EKS on AWS / GKE on GCP / AKS on Azure / self-managed)        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Controller   │  │ Controller   │  │ Controller   │          │
│  │ (aws-test)   │  │(aws-buildkit)│  │ (aws-gpu)    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│         ▼                 ▼                 ▼                   │
│   ┌───────────┐    ┌───────────┐    ┌───────────┐              │
│   │  Standard │    │  BuildKit │    │    GPU    │              │
│   │   Nodes   │    │   Nodes   │    │   Nodes   │              │
│   │  (tests)  │    │ (rootless)│    │  (ML/AI)  │              │
│   └───────────┘    └───────────┘    └───────────┘              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation: Resource Classes (Optional)

Resource classes can still be used **within a queue** for finer-grained resource allocation. For example, within your `aws-test` queue you might have `small`, `medium`, and `large` resource classes:

```yaml
# values-test.yaml
config:
  queue: aws-test
  resource-classes:
    small:
      resource:
        requests:
          cpu: "250m"
          memory: "512Mi"
        limits:
          cpu: "500m"
          memory: "1Gi"
    medium:
      resource:
        requests:
          cpu: "500m"
          memory: "1Gi"
        limits:
          cpu: "2000m"
          memory: "4Gi"
    large:
      resource:
        requests:
          cpu: "2000m"
          memory: "4Gi"
        limits:
          cpu: "4000m"
          memory: "8Gi"
```

Usage in pipelines:

```yaml
steps:
  - label: "Quick lint"
    command: "make lint"
    agents:
      queue: aws-test
      resource_class: small

  - label: "Full test suite"
    command: "pytest"
    agents:
      queue: aws-test
      resource_class: large
```

For BuildKit and GPU queues, the queue-level defaults in the controller's `pod-spec-patch` are usually sufficient.

---

## Pipeline Examples

### Standard Tests

```yaml
steps:
  - label: "Unit tests"
    command: "pytest"
    agents:
      queue: aws-test
```

### Rootless BuildKit Container Build

```yaml
steps:
  - label: "Build image"
    agents:
      queue: aws-buildkit
    command: |
      buildctl-daemonless.sh build \
        --frontend dockerfile.v0 \
        --local context=. \
        --local dockerfile=. \
        --output type=image,name=$REGISTRY/myapp:$BUILDKITE_BUILD_NUMBER,push=true
    plugins:
      - kubernetes:
          podSpec:
            volumes:
              - name: buildkit-cache
                emptyDir: {}
              - name: tmp-space
                emptyDir: {}
            containers:
              - name: main
                image: moby/buildkit:latest-rootless
                volumeMounts:
                  - name: buildkit-cache
                    mountPath: "/home/user/.local/share/buildkit"
                  - name: tmp-space
                    mountPath: "/tmp"
                securityContext:
                  runAsNonRoot: true
                  runAsUser: 1000
                  runAsGroup: 1000
```

### GPU Workload

```yaml
steps:
  - label: "ML Training"
    command: "python train.py"
    agents:
      queue: aws-gpu
```

---

## Rootless BuildKit Security Tiers

Choose based on your cluster's security posture:

| Mode | Security Level | Image | Use When |
|------|---------------|-------|----------|
| **Rootless (strict)** | Highest | `moby/buildkit:latest-rootless` | Production, untrusted builds |
| **Rootless (non-privileged)** | High | `moby/buildkit:latest-rootless` | General use, cluster allows `runAsNonRoot` |
| **Privileged** | Lower | `moby/buildkit:latest` | Trusted env, max compatibility needed |

### Configuration Comparison

| Feature | Privileged | Rootless (Non-Privileged) | Rootless (Strict) |
|---------|-----------|---------------------------|-------------------|
| **Runs as user** | root (0) | user (1000) | user (1000) |
| **Privileged access** | Yes (`privileged: true`) | No | No |
| **BuildKit process sandbox** | Enabled | Enabled | Disabled* |
| **Kernel security profiles** | Default | Default | Unconfined |
| **Kubernetes version** | Any | Any | ≥1.19 (seccomp), ≥1.30 (AppArmor) |
| **Cache path** | `/var/lib/buildkit` | `/home/user/.local/share/buildkit` | `/home/user/.local/share/buildkit` |

*Process sandbox disabled due to Kubernetes limitations with PID namespaces.

### Rootless Strict Example

For maximum security isolation:

```yaml
steps:
  - label: "BuildKit rootless strict"
    agents:
      queue: aws-buildkit
    command: |
      BUILDKITD_FLAGS="--oci-worker-no-process-sandbox" \
      buildctl-daemonless.sh build \
        --frontend dockerfile.v0 \
        --local context=. \
        --local dockerfile=. \
        --progress=plain
    plugins:
      - kubernetes:
          podSpec:
            volumes:
              - name: buildkit-cache
                emptyDir: {}
              - name: tmp-space
                emptyDir: {}
            containers:
              - name: main
                image: moby/buildkit:latest-rootless
                volumeMounts:
                  - name: buildkit-cache
                    mountPath: "/home/user/.local/share/buildkit"
                  - name: tmp-space
                    mountPath: "/tmp"
                securityContext:
                  runAsNonRoot: true
                  runAsUser: 1000
                  runAsGroup: 1000
                  seccompProfile:
                    type: Unconfined
                  appArmorProfile:
                    type: Unconfined
```

---

## Multi-Cloud Deployment Pattern

Deploy the same agent-stack-k8s Helm chart to each cloud provider:

```bash
# AWS EKS
helm install bk-agents oci://ghcr.io/buildkite/helm/agent-stack-k8s \
  --set agentToken=$TOKEN \
  --set config.queue=aws-builders

# GCP GKE
helm install bk-agents oci://ghcr.io/buildkite/helm/agent-stack-k8s \
  --set agentToken=$TOKEN \
  --set config.queue=gcp-builders

# Azure AKS
helm install bk-agents oci://ghcr.io/buildkite/helm/agent-stack-k8s \
  --set agentToken=$TOKEN \
  --set config.queue=azure-builders
```

Route jobs to specific clouds via agent tags:

```yaml
steps:
  - label: "Build on AWS"
    command: "make build"
    agents:
      queue: aws-builders

  - label: "Build on GCP"
    command: "make build"
    agents:
      queue: gcp-builders
```

---

## Alternative: Remote BuildKit Daemon

If you need shared build cache across many jobs, consider a **remote BuildKit daemon** pattern:

- Dedicated BuildKit daemon on a persistent instance
- Agents connect via `buildctl --addr tcp://buildkitd:1234`
- Shared cache improves build speeds across all jobs

```yaml
steps:
  - label: "Build with remote BuildKit"
    command: |
      buildctl --addr tcp://buildkitd.internal:1234 build \
        --frontend dockerfile.v0 \
        --local context=. \
        --local dockerfile=. \
        --output type=image,name=$REGISTRY/myapp:$TAG,push=true
```

This works well with either K8s or EC2 agents but adds operational complexity.

---

## Quick Start

1. **Set up EKS cluster** with node groups for different workload types (standard, builder, GPU)
2. **Install controllers per queue**:
   ```bash
   # Test queue
   helm install bk-test oci://ghcr.io/buildkite/helm/agent-stack-k8s \
     --set agentToken=<your-token> \
     --set config.queue=aws-test \
     --namespace buildkite-test

   # BuildKit queue
   helm install bk-buildkit oci://ghcr.io/buildkite/helm/agent-stack-k8s \
     --set agentToken=<your-token> \
     --set config.queue=aws-buildkit \
     --namespace buildkite-buildkit \
     -f values-buildkit.yaml
   ```
3. **Configure node selectors** in each controller's values file to target appropriate node pools
4. **Update pipelines** to use queue-specific agent tags (`queue: aws-test`, `queue: aws-buildkit`, etc.)

---

## References

- [Agent Stack for Kubernetes Documentation](https://buildkite.com/docs/agent/v3/agent-stack-k8s)
- [BuildKit Container Builds Guide](https://buildkite.com/docs/agent/v3/agent-stack-k8s/buildkit-container-builds)
- [Container Resource Limits](https://buildkite.com/docs/agent/v3/agent-stack-k8s/container-resource-limits)
- [Elastic CI Stack for AWS](https://buildkite.com/docs/agent/v3/aws/elastic-ci-stack) (alternative for AWS-only deployments)

---

## Summary

**Key decisions**:

1. **Use Agent Stack for Kubernetes** - Cloud-agnostic, supports rootless BuildKit natively
2. **Separate queues per workload type** - Enables accurate queue metrics, independent scaling, and cost tracking
3. **One controller per queue** - Each watches its own queue and schedules to its node pool
4. **Rootless non-privileged BuildKit** - Best balance of security and compatibility

This architecture ports cleanly to GKE/AKS when you expand to other clouds - just deploy additional controllers with cloud-specific queue names.
