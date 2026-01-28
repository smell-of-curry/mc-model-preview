#!/bin/bash
# Local test script for mc-model-preview
# This allows testing the rendering locally without pushing to GitHub

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== MC Model Preview Local Test ==="
echo "Project dir: $PROJECT_DIR"

# Check if we have a test bbmodel file
TEST_MODEL="${1:-$PROJECT_DIR/test-data/creeper_pack/models/entity/creeper.geo.json}"
if [ ! -f "$TEST_MODEL" ]; then
    echo "Error: Test model not found at $TEST_MODEL"
    echo "Usage: $0 [path-to-bbmodel-or-geo-file]"
    exit 1
fi

# Build the project first
echo ""
echo "=== Building project ==="
cd "$PROJECT_DIR"
npm run build

# Setup Blockbench if not already done
echo ""
echo "=== Setting up Blockbench ==="
if [ ! -d "$PROJECT_DIR/Blockbench_extracted" ]; then
    bash "$SCRIPT_DIR/setup-blockbench.sh"
else
    echo "Blockbench already extracted, skipping download"
fi

# Start Xvfb if on Linux and not running
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if ! pgrep -x Xvfb > /dev/null; then
        echo ""
        echo "=== Starting Xvfb ==="
        Xvfb :99 -screen 0 1280x720x24 &
        export DISPLAY=:99
        sleep 1
    fi
fi

# Create a simple test script that uses the renderer directly
echo ""
echo "=== Running render test ==="
cat > "$PROJECT_DIR/test-render.mjs" << 'TESTEOF'
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

const REMOTE_DEBUG_PORT = 9222;
const BB_EXTRACTED_DIR = './Blockbench_extracted';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const testModelPath = process.argv[2] || './test-data/creeper_pack/models/entity/creeper.geo.json';
    const outputPath = './test-output.png';
    
    console.log('Test model:', testModelPath);
    console.log('Output path:', outputPath);
    
    // Start Blockbench
    const appRunPath = path.join(BB_EXTRACTED_DIR, 'AppRun');
    console.log('Starting Blockbench from:', appRunPath);
    
    const env = {
        ...process.env,
        APPDIR: path.resolve(BB_EXTRACTED_DIR),
        LD_LIBRARY_PATH: `${path.resolve(BB_EXTRACTED_DIR)}:${path.resolve(BB_EXTRACTED_DIR)}/usr/lib:${process.env.LD_LIBRARY_PATH || ''}`,
        DISPLAY: process.env.DISPLAY || ':99',
        ELECTRON_NO_UPDATER: '1',
    };
    
    const blockbench = spawn(appRunPath, [
        `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
    ], {
        env,
        cwd: BB_EXTRACTED_DIR,
        stdio: 'inherit',
    });
    
    blockbench.on('error', (err) => {
        console.error('Blockbench error:', err);
    });
    
    // Wait for Blockbench to start
    console.log('Waiting for Blockbench to start...');
    let browser = null;
    for (let i = 0; i < 30; i++) {
        try {
            await sleep(2000);
            browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${REMOTE_DEBUG_PORT}`,
            });
            console.log('Connected to Blockbench!');
            break;
        } catch (e) {
            console.log(`Attempt ${i + 1}/30 failed, retrying...`);
        }
    }
    
    if (!browser) {
        console.error('Failed to connect to Blockbench');
        blockbench.kill();
        process.exit(1);
    }
    
    try {
        const pages = await browser.pages();
        console.log('Found pages:', pages.length);
        
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const url = page.url();
            const title = await page.title();
            console.log(`  Page ${i}: ${title} (${url})`);
        }
        
        // Find the main Blockbench page (not about:blank or devtools)
        let mainPage = null;
        for (const page of pages) {
            const url = page.url();
            if (url.includes('blockbench') || url.startsWith('file://') || url === 'about:blank') {
                // Check if Blockbench is loaded on this page
                const hasBlockbench = await page.evaluate(() => {
                    return typeof window.Blockbench !== 'undefined';
                }).catch(() => false);
                
                console.log(`  Page ${page.url()} has Blockbench: ${hasBlockbench}`);
                
                if (hasBlockbench) {
                    mainPage = page;
                    break;
                }
            }
        }
        
        if (!mainPage) {
            // Wait longer and check all pages again
            console.log('Blockbench not found yet, waiting 10 more seconds...');
            await sleep(10000);
            
            const pages2 = await browser.pages();
            for (const page of pages2) {
                const hasBlockbench = await page.evaluate(() => {
                    return typeof window.Blockbench !== 'undefined';
                }).catch(() => false);
                
                console.log(`  Page ${page.url()} has Blockbench: ${hasBlockbench}`);
                
                if (hasBlockbench) {
                    mainPage = page;
                    break;
                }
            }
        }
        
        if (!mainPage) {
            console.error('Could not find Blockbench main page');
            await browser.disconnect();
            blockbench.kill();
            process.exit(1);
        }
        
        console.log('Using page:', mainPage.url());
        
        // Now try to interact with Blockbench
        const bbInfo = await mainPage.evaluate(() => {
            const win = window;
            if (!win.Blockbench) return { loaded: false };
            return {
                loaded: true,
                version: win.Blockbench.version,
                hasCodecs: typeof win.Codecs !== 'undefined',
                hasFormats: typeof win.Formats !== 'undefined',
            };
        });
        
        console.log('Blockbench info:', bbInfo);
        
        if (!bbInfo.loaded) {
            console.error('Blockbench still not loaded');
            await browser.disconnect();
            blockbench.kill();
            process.exit(1);
        }
        
        // Read test model
        const modelContent = await fs.readFile(testModelPath, 'utf-8');
        console.log('Model content length:', modelContent.length);
        
        // Try to render
        const result = await mainPage.evaluate(async (modelJson) => {
            try {
                const win = window;
                
                // Parse the geometry file (not a bbmodel, but a geo.json)
                const geoData = JSON.parse(modelJson);
                
                // Log what we have
                console.log('Geo data keys:', Object.keys(geoData));
                
                // Check if this is a geometry file or bbmodel
                if (geoData['minecraft:geometry']) {
                    console.log('This is a Bedrock geometry file');
                }
                
                // Get the preview canvas
                const canvas = document.querySelector('#preview canvas');
                if (!canvas) {
                    return { success: false, error: 'Canvas not found', canvasQuery: '#preview canvas' };
                }
                
                // Take a screenshot of whatever is there
                const dataUrl = canvas.toDataURL('image/png');
                return { success: true, dataUrl };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }, modelContent);
        
        console.log('Render result:', result.success ? 'Success!' : `Failed: ${result.error}`);
        
        if (result.success && result.dataUrl) {
            const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
            await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
            console.log('Saved to:', outputPath);
        }
        
    } finally {
        await browser.disconnect();
        blockbench.kill();
    }
}

main().catch(console.error);
TESTEOF

# Run the test
node --experimental-modules "$PROJECT_DIR/test-render.mjs" "$TEST_MODEL"

echo ""
echo "=== Test complete ==="
