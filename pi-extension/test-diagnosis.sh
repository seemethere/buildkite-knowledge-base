#!/bin/bash
# Test script for buildkite-diagnose extension
# Usage: ./test-diagnosis.sh <org> <pipeline> <build-number>
# Environment: PI_BINARY (default: pi) - path to pi binary

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Allow overriding pi binary via environment variable
PI_BINARY="${PI_BINARY:-pi}"

ORG="${1:-my-org}"
PIPELINE="${2:-my-pipeline}"
BUILD="${3:-123}"

echo "Testing buildkite diagnosis for $ORG/$PIPELINE#$BUILD"
echo "Using pi binary: $PI_BINARY"
echo "=================================================="

# Check if API token is set
if [ -z "$BUILDKITE_API_TOKEN" ]; then
    echo "Error: BUILDKITE_API_TOKEN not set"
    echo "Get a token from: https://buildkite.com/user/api-access-tokens"
    exit 1
fi

# Run pi with the extension
cd /tmp
$PI_BINARY -e "$SCRIPT_DIR/extensions/buildkite-diagnose.ts" -p \
    "Use buildkite_analyze_failures with org=$ORG, pipeline=$PIPELINE, build_number=$BUILD. Then provide a diagnosis with root cause and suggested fix." \
    2>&1 | grep -A 200 "Analyzed\|Summary\|Root Cause\|Suggested Fix" | head -100
