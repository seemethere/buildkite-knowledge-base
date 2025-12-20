#!/usr/bin/env python3
"""
Sync Buildkite GitHub repositories as submodules.

Usage:
    uv run sync.py [--dry-run]

This script manages git submodules for Buildkite repositories based on an allowlist.
- Adds new submodules for repos in the allowlist that aren't present
- Removes submodules for repos not in the allowlist
- Updates all submodules (pinned repos checkout their ref, unpinned get latest)
"""

import argparse
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table
from rich.text import Text

# =============================================================================
# ALLOWLIST CONFIGURATION
# =============================================================================
# Add or remove repositories here to manage which Buildkite repos are synced.
#
# Format:
#   "repo-name"                    -> Track latest default branch
#   ("repo-name", "v1.2.3")        -> Pin to a tag
#   ("repo-name", "abc123")        -> Pin to a commit SHA
#   ("repo-name", "refs/heads/x")  -> Pin to a specific branch
# =============================================================================

ALLOWED_REPOS: list[str | tuple[str, str]] = [
    # Core Buildkite tools
    ("agent", "v3.115.2"),
    ("cli", "v3.16.0"),
    # Documentation
    ("docs", "86bbdc9"),
    # Kubernetes
    ("agent-stack-k8s", "v0.36.1"),
    # AWS infrastructure
    ("elastic-ci-stack-for-aws", "v6.52.0"),
    ("buildkite-agent-scaler", "v1.10.0"),
    ("terraform-buildkite-elastic-ci-stack-for-aws", "v0.6.2"),
    ("elastic-ci-stack-s3-secrets-hooks", "v2.8.0"),
    ("lifecycled", "v3.5.0"),
    # Python SDK & tools
    ("buildkite-sdk", "v0.6.0"),  # Multi-language SDK (includes Python)
    ("test-collector-python", "v1.2.0"),
]


# =============================================================================
# Configuration
# =============================================================================


@dataclass
class RepoConfig:
    """Configuration for a repository."""

    name: str
    ref: str | None = None  # None means track latest

    @property
    def is_pinned(self) -> bool:
        return self.ref is not None


def parse_repo_config(entry: str | tuple[str, str]) -> RepoConfig:
    """Parse an allowlist entry into a RepoConfig."""
    if isinstance(entry, str):
        return RepoConfig(name=entry)
    return RepoConfig(name=entry[0], ref=entry[1])


def get_repo_configs() -> list[RepoConfig]:
    """Get parsed repo configurations from the allowlist."""
    return [parse_repo_config(entry) for entry in ALLOWED_REPOS]


GITHUB_ORG = "buildkite"
GITHUB_BASE_URL = f"https://github.com/{GITHUB_ORG}"
SUBMODULE_DIR = Path("repos")

console = Console()


def run_git(
    *args: str, check: bool = True, capture: bool = False
) -> subprocess.CompletedProcess:
    """Run a git command."""
    cmd = ["git", *args]
    return subprocess.run(
        cmd,
        check=check,
        capture_output=capture,
        text=True,
    )


def get_existing_submodules() -> dict[str, Path]:
    """Get a mapping of submodule names to their paths."""
    result = run_git("submodule", "status", capture=True, check=False)
    submodules = {}

    if result.returncode != 0:
        return submodules

    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        # Format: " <sha> <path> (<describe>)" or "-<sha> <path>" for uninitialized
        parts = line.strip().split()
        if len(parts) >= 2:
            # Remove leading +/- status indicators from sha
            path = Path(parts[1])
            # Extract repo name from path (repos/agent -> agent)
            if path.parent == SUBMODULE_DIR:
                submodules[path.name] = path

    return submodules


def add_submodule(repo_name: str, dry_run: bool = False) -> tuple[str, bool, str]:
    """Add a submodule. Returns (repo_name, success, message)."""
    url = f"{GITHUB_BASE_URL}/{repo_name}.git"
    path = SUBMODULE_DIR / repo_name

    if path.exists() and any(path.iterdir()):
        return (repo_name, False, "already exists")

    if dry_run:
        return (repo_name, True, "would add")

    try:
        # Remove empty directory if it exists (leftover from failed attempt)
        if path.exists():
            shutil.rmtree(path)

        subprocess.run(
            ["git", "submodule", "add", url, str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        return (repo_name, True, "added")
    except subprocess.CalledProcessError as e:
        return (repo_name, False, e.stderr.strip() or str(e))


def add_submodules(
    repos: set[str], dry_run: bool = False
) -> list[tuple[str, bool, str]]:
    """Add submodules sequentially with progress display."""
    results: list[tuple[str, bool, str]] = []

    if not repos:
        return results

    sorted_repos = sorted(repos)

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        for repo_name in sorted_repos:
            progress.update(
                progress.add_task(f"[cyan]Adding {repo_name}...", total=None),
            )
            result = add_submodule(repo_name, dry_run)
            results.append(result)

    return results


def remove_submodule(
    repo_name: str, path: Path, dry_run: bool = False
) -> tuple[str, bool, str]:
    """Remove a submodule that's no longer in the allowlist."""
    if dry_run:
        return (repo_name, True, "would remove")

    try:
        # Deinitialize the submodule
        run_git("submodule", "deinit", "-f", str(path), check=False, capture=True)

        # Remove from git index
        run_git("rm", "-f", str(path), check=False, capture=True)

        # Clean up .git/modules directory
        git_modules_path = Path(".git/modules") / path
        if git_modules_path.exists():
            shutil.rmtree(git_modules_path)

        # Remove the directory if it still exists
        if path.exists():
            shutil.rmtree(path)

        return (repo_name, True, "removed")
    except Exception as e:
        return (repo_name, False, str(e))


def update_submodule(
    config: RepoConfig, dry_run: bool = False
) -> tuple[str, bool, str]:
    """Update a single submodule. Returns (repo_name, success, message)."""
    path = SUBMODULE_DIR / config.name

    if not path.exists():
        return (config.name, False, "not found")

    if dry_run:
        if config.is_pinned:
            return (config.name, True, f"would checkout {config.ref}")
        return (config.name, True, "would pull latest")

    try:
        if config.is_pinned:
            # Checkout the specific ref
            subprocess.run(
                ["git", "-C", str(path), "fetch", "--all", "--tags"],
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "-C", str(path), "checkout", config.ref],
                check=True,
                capture_output=True,
                text=True,
            )
            return (config.name, True, f"@ {config.ref}")
        else:
            # Pull latest from default branch
            subprocess.run(
                ["git", "-C", str(path), "pull", "origin", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            )
            return (config.name, True, "latest")
    except subprocess.CalledProcessError as e:
        return (config.name, False, e.stderr.strip() or str(e))


def update_submodules(
    configs: list[RepoConfig], dry_run: bool = False
) -> list[tuple[str, bool, str]]:
    """Update all submodules based on their config."""
    results: list[tuple[str, bool, str]] = []

    if not configs:
        return results

    # First, ensure all submodules are initialized (suppress output)
    if not dry_run:
        jobs = os.cpu_count() or 4
        try:
            run_git(
                "submodule",
                "update",
                "--init",
                "--recursive",
                "--jobs",
                str(jobs),
                capture=True,
            )
        except subprocess.CalledProcessError:
            pass  # Continue anyway, individual updates will report errors

    # Then update each based on its config
    for config in configs:
        result = update_submodule(config, dry_run)
        results.append(result)

    return results


def ensure_repos_dir() -> None:
    """Ensure the repos directory exists."""
    SUBMODULE_DIR.mkdir(exist_ok=True)


def print_results_table(
    title: str, results: list[tuple[str, bool, str]], action: str = "Status"
) -> None:
    """Print a styled results table."""
    table = Table(title=title, show_header=True, header_style="bold magenta")
    table.add_column("Repository", style="cyan")
    table.add_column(action, justify="left")

    for repo_name, success, message in sorted(results, key=lambda x: x[0]):
        if success:
            status = Text(message, style="green")
        else:
            status = Text(message, style="red")
        table.add_row(repo_name, status)

    console.print(table)
    console.print()


def sync(dry_run: bool = False) -> int:
    """Main sync logic."""
    # Header
    title = Text()
    title.append("Buildkite Knowledge Base", style="bold cyan")
    title.append(" - ", style="dim")
    title.append("Repository Sync", style="bold white")

    if dry_run:
        title.append(" [DRY RUN]", style="bold yellow")

    console.print(Panel(title, border_style="cyan"))
    console.print()

    # Ensure we're in a git repository
    result = run_git("rev-parse", "--git-dir", capture=True, check=False)
    if result.returncode != 0:
        console.print(
            "[red]Error:[/red] Not a git repository. Please run 'git init' first."
        )
        return 1

    ensure_repos_dir()

    # Parse repo configurations
    configs = get_repo_configs()
    config_by_name = {c.name: c for c in configs}

    # Get current state
    existing = get_existing_submodules()
    allowed_names = {c.name for c in configs}
    existing_set = set(existing.keys())

    # Determine what to add and remove
    to_add = allowed_names - existing_set
    to_remove = existing_set - allowed_names

    # Count pinned repos
    pinned_count = sum(1 for c in configs if c.is_pinned)

    # Status summary
    status_table = Table(show_header=False, box=None, padding=(0, 2))
    status_table.add_column("Label", style="dim")
    status_table.add_column("Value", style="bold")

    status_table.add_row("Allowlist", f"{len(configs)} repos ({pinned_count} pinned)")
    status_table.add_row("Existing", f"{len(existing)} submodules")
    status_table.add_row(
        "To add", Text(str(len(to_add)), style="green" if to_add else "dim")
    )
    status_table.add_row(
        "To remove", Text(str(len(to_remove)), style="red" if to_remove else "dim")
    )

    console.print(status_table)
    console.print()

    # Add new submodules
    if to_add:
        results = add_submodules(to_add, dry_run)
        print_results_table("Added Repositories", results, "Status")

    # Remove old submodules
    if to_remove:
        remove_results = []
        for repo_name in sorted(to_remove):
            result = remove_submodule(repo_name, existing[repo_name], dry_run)
            remove_results.append(result)

        print_results_table("Removed Repositories", remove_results, "Status")

    # Update all submodules (pinned to their ref, unpinned to latest)
    if configs:
        with console.status("[cyan]Updating submodules...", spinner="dots"):
            update_results = update_submodules(configs, dry_run)

        print_results_table("Updated Repositories", update_results, "Version")

    # Final summary
    console.print(Panel("[bold green]Done![/bold green]", border_style="green"))

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync Buildkite GitHub repositories as submodules.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    uv run sync.py              # Add missing submodules and update all to latest
    uv run sync.py --dry-run    # Preview changes without making them
        """,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without making them",
    )

    args = parser.parse_args()
    return sync(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
