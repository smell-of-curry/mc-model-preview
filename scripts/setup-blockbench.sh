#!/bin/bash
set -e

# Define BlockBench version
BB_VERSION="4.11.0"
BB_APP_IMAGE="Blockbench_${BB_VERSION}.AppImage"

# Download BlockBench AppImage
if [ ! -f "$BB_APP_IMAGE" ]; then
  echo "Downloading BlockBench v${BB_VERSION}..."
  wget "https://github.com/JannisX11/blockbench/releases/download/v${BB_VERSION}/${BB_APP_IMAGE}"
else
  echo "BlockBench AppImage already exists."
fi

# Make it executable
chmod +x "$BB_APP_IMAGE"

echo "BlockBench setup complete."
