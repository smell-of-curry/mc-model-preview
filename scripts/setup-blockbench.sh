#!/bin/bash
set -e

# Define BlockBench version
BB_VERSION="4.11.0"
BB_APP_IMAGE="Blockbench_${BB_VERSION}.AppImage"
BB_EXTRACTED_DIR="Blockbench_extracted"

# Download BlockBench AppImage
if [ ! -f "$BB_APP_IMAGE" ]; then
  echo "Downloading BlockBench v${BB_VERSION}... (this may take a moment)"
  wget -q "https://github.com/JannisX11/blockbench/releases/download/v${BB_VERSION}/${BB_APP_IMAGE}"
  echo "Download complete."
else
  echo "BlockBench AppImage already exists."
fi

# Make it executable
chmod +x "$BB_APP_IMAGE"

# Try to ensure AppImage can run; if FUSE is missing, fall back to extraction
echo "Verifying AppImage runtime..."
# Attempt to install libfuse2, xvfb, and mesa libraries for software rendering (ignore failures)
if command -v sudo >/dev/null 2>&1; then
  sudo apt-get update -y >/dev/null 2>&1 || true
  # Install dependencies:
  # - libfuse2: for AppImage support
  # - xvfb: virtual framebuffer for headless display
  # - libegl1-mesa, libgl1-mesa-dri, libgl1-mesa-glx: Mesa OpenGL for software rendering
  # - libosmesa6: Off-screen Mesa rendering
  sudo apt-get install -y libfuse2 xvfb libegl1-mesa libgl1-mesa-dri libgl1-mesa-glx libosmesa6 >/dev/null 2>&1 || true
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
