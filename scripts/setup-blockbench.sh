#!/bin/bash
set -e

# Define BlockBench version
BB_VERSION="4.11.0"
BB_APP_IMAGE="Blockbench_${BB_VERSION}.AppImage"
BB_EXTRACTED_DIR="Blockbench_extracted"

# Download BlockBench AppImage
if [ ! -f "$BB_APP_IMAGE" ]; then
  echo "Downloading BlockBench v${BB_VERSION}..."
  wget "https://github.com/JannisX11/blockbench/releases/download/v${BB_VERSION}/${BB_APP_IMAGE}"
else
  echo "BlockBench AppImage already exists."
fi

# Make it executable
chmod +x "$BB_APP_IMAGE"

# Try to ensure AppImage can run; if FUSE is missing, fall back to extraction
echo "Verifying AppImage runtime..."
# Attempt to install libfuse2 and xvfb if possible (ignore failures)
if command -v sudo >/dev/null 2>&1; then
  sudo apt-get update -y >/dev/null 2>&1 || true
  sudo apt-get install -y libfuse2 xvfb >/dev/null 2>&1 || true
fi

# Extract AppImage unconditionally to avoid setuid sandbox issues and prefer AppRun
if [ ! -d "$BB_EXTRACTED_DIR" ]; then
  echo "Extracting BlockBench AppImage..."
  ./$BB_APP_IMAGE --appimage-extract >/dev/null 2>&1 || true
  if [ -d "squashfs-root" ]; then
    rm -rf "$BB_EXTRACTED_DIR" >/dev/null 2>&1 || true
    mv squashfs-root "$BB_EXTRACTED_DIR"
    echo "Extracted BlockBench to ./$BB_EXTRACTED_DIR"
  fi
fi

echo "BlockBench setup complete."
