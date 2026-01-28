#!/bin/bash
# Run tests in a Docker environment matching GitHub Actions

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building Docker test image ==="
cd "$PROJECT_DIR"

docker build -f Dockerfile.test -t mc-model-preview-test .

echo ""
echo "=== Running tests in Docker ==="
docker run --rm \
    -v "$PROJECT_DIR/debug-screenshot.png:/app/debug-screenshot.png" \
    mc-model-preview-test

echo ""
echo "=== Test complete ==="
