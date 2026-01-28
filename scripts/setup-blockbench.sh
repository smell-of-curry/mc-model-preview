#!/bin/bash
# Setup script for mc-model-preview
# This script ensures Chrome/Chromium is available for rendering

set -e

echo "Checking for Chrome/Chromium..."

# Check for Google Chrome
if command -v google-chrome &> /dev/null; then
    echo "Found Google Chrome: $(google-chrome --version)"
    exit 0
fi

# Check for Chromium
if command -v chromium-browser &> /dev/null; then
    echo "Found Chromium: $(chromium-browser --version)"
    exit 0
fi

if command -v chromium &> /dev/null; then
    echo "Found Chromium: $(chromium --version)"
    exit 0
fi

# If running on Ubuntu/Debian, try to install Chrome
if command -v apt-get &> /dev/null; then
    echo "Chrome not found, attempting to install..."
    
    # Try to install chromium-browser
    sudo apt-get update || true
    sudo apt-get install -y chromium-browser || {
        # If chromium-browser fails, try google-chrome
        echo "Installing Google Chrome..."
        wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
        sudo dpkg -i /tmp/chrome.deb || sudo apt-get install -f -y
        rm /tmp/chrome.deb
    }
fi

# Verify installation
if command -v google-chrome &> /dev/null; then
    echo "Google Chrome installed: $(google-chrome --version)"
elif command -v chromium-browser &> /dev/null; then
    echo "Chromium installed: $(chromium-browser --version)"
else
    echo "Warning: Chrome/Chromium installation may have failed"
    echo "The action will try to find a browser at runtime"
fi

echo "Setup complete."
