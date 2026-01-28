#!/usr/bin/env node
/**
 * Test script that mimics the GitHub Actions environment
 * Tests Blockbench web rendering with headless Chrome
 * 
 * Run locally: node scripts/test-blockbench-web.mjs
 * Run in Docker: ./scripts/test-docker.sh
 */

import puppeteer from 'puppeteer-core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(__dirname);

const BLOCKBENCH_WEB_URL = 'https://web.blockbench.net/';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function findChromePath() {
    const possiblePaths = [
        // Linux (GitHub Actions)
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    
    for (const p of possiblePaths) {
        try {
            await fs.access(p);
            return p;
        } catch {
            // Try next
        }
    }
    
    throw new Error('Chrome/Chromium not found');
}

async function testBlockbenchWebRender() {
    console.log('=== Blockbench Web Rendering Test ===\n');
    console.log('This test mimics the GitHub Actions environment\n');
    
    const chromePath = await findChromePath();
    console.log('Using Chrome at:', chromePath);
    
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--headless=new',
            // WebGL support
            '--use-gl=swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
        ],
    });
    
    console.log('Browser launched');
    
    let page = null;
    
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        
        // Intercept the Blockbench bundle and patch it before execution
        await page.setRequestInterception(true);
        
        page.on('request', async (request) => {
            const url = request.url();
            
            // Intercept the main bundle.js
            if (url.includes('bundle.js') && url.includes('blockbench')) {
                try {
                    // Fetch the original script
                    const response = await fetch(url);
                    let scriptContent = await response.text();
                    
                    // === CRITICAL PATCH: Interface.tab_bar.new_tab ===
                    // Blockbench web doesn't have tab_bar initialized in headless mode
                    scriptContent = scriptContent.replace(
                        /Interface\.tab_bar\.new_tab/g,
                        '(Interface.tab_bar?.new_tab ?? {visible:false,selected:false,select:()=>{}})'
                    );
                    
                    // === PATCH: northMarkMaterial.color in buildGrid ===
                    // When 3D preview fails to init, this material might not exist
                    scriptContent = scriptContent.replace(
                        /ct\.northMarkMaterial\.color=/g,
                        '(ct.northMarkMaterial?ct.northMarkMaterial.color='
                    );
                    // Close the ternary
                    scriptContent = scriptContent.replace(
                        /\(ct\.northMarkMaterial\?ct\.northMarkMaterial\.color=([^;]+);/g,
                        '(ct.northMarkMaterial?ct.northMarkMaterial.color=$1:0);'
                    );
                    
                    // === PATCH: three_grid.children.empty() ===
                    scriptContent = scriptContent.replace(
                        /three_grid\.children\.empty\(\)/g,
                        '(three_grid&&three_grid.children?three_grid.children.empty():null)'
                    );
                    
                    // === PATCH: side_grids access ===
                    scriptContent = scriptContent.replace(
                        /ct\.side_grids&&\(ct\.side_grids\.x\.children\.empty\(\),ct\.side_grids\.z\.children\.empty\(\)\)/g,
                        'ct.side_grids&&ct.side_grids.x&&ct.side_grids.z&&(ct.side_grids.x.children.empty(),ct.side_grids.z.children.empty())'
                    );
                    
                    request.respond({
                        status: 200,
                        contentType: 'application/javascript',
                        body: scriptContent
                    });
                    console.log('[mc-model-preview] Patched Blockbench bundle.js');
                    return;
                } catch (e) {
                    console.log('[mc-model-preview] Failed to patch bundle:', e.message);
                }
            }
            
            request.continue();
        });
        
        // Inject early patching code
        await page.evaluateOnNewDocument(() => {
            const patchGlobals = () => {
                // Ensure Interface.tab_bar exists with new_tab stub
                if (window.Interface && !window.Interface.tab_bar) {
                    window.Interface.tab_bar = {
                        new_tab: {
                            visible: false,
                            selected: false,
                            select: () => {},
                            getDisplayName: () => 'New Tab'
                        }
                    };
                    console.log('[mc-model-preview] Created Interface.tab_bar stub');
                }
                
                // Ensure markerColors exists (needed for element color property)
                if (!window.markerColors) {
                    window.markerColors = [
                        { id: 'gray', standard: '#808080', pastel: '#c0c0c0' },
                        { id: 'red', standard: '#ff0000', pastel: '#ffcccc' },
                        { id: 'orange', standard: '#ff8800', pastel: '#ffe0cc' },
                        { id: 'yellow', standard: '#ffff00', pastel: '#ffffcc' },
                        { id: 'green', standard: '#00ff00', pastel: '#ccffcc' },
                        { id: 'blue', standard: '#0088ff', pastel: '#cce5ff' },
                        { id: 'purple', standard: '#8800ff', pastel: '#e5ccff' },
                        { id: 'pink', standard: '#ff00ff', pastel: '#ffccff' },
                    ];
                }
                
                // Ensure settings has needed properties
                if (window.settings) {
                    if (!window.settings.new_tab) {
                        window.settings.new_tab = { value: false };
                    }
                    if (!window.settings.inherit_parent_color) {
                        window.settings.inherit_parent_color = { value: false };
                    }
                }
            };
            const interval = setInterval(patchGlobals, 10);
            setTimeout(() => clearInterval(interval), 30000);
        });
        
        // Enable console logging from the page
        page.on('console', msg => {
            if (msg.type() === 'error' || msg.text().includes('[mc-model-preview]')) {
                console.log(`Browser ${msg.type()}: ${msg.text()}`);
            }
        });
        
        page.on('pageerror', err => {
            console.log('Page error:', err.message);
        });
        
        console.log('\n--- Loading Blockbench web ---');
        await page.goto(BLOCKBENCH_WEB_URL, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });
        
        console.log('Page loaded, waiting for Blockbench to initialize...');
        
        // Check what globals exist before waiting
        const preCheck = await page.evaluate(() => {
            return {
                hasBlockbench: typeof window.Blockbench !== 'undefined',
                hasCodecs: typeof window.Codecs !== 'undefined',
                hasFormats: typeof window.Formats !== 'undefined',
                hasNewProject: typeof window.newProject !== 'undefined',
                windowKeys: Object.keys(window).filter(k => k.match(/^[A-Z]/)).slice(0, 20),
            };
        });
        console.log('Pre-check globals:', JSON.stringify(preCheck, null, 2));
        
        // Wait for Blockbench globals
        await page.waitForFunction(
            () => {
                const win = window;
                return typeof win.Blockbench !== 'undefined' && 
                       typeof win.Codecs !== 'undefined' &&
                       typeof win.Formats !== 'undefined' &&
                       typeof win.newProject !== 'undefined';
            },
            { timeout: 30000 }
        );
        
        console.log('Blockbench loaded successfully!');
        
        // Initialize missing globals after Blockbench loads
        await page.evaluate(() => {
            const win = window;
            
            // Ensure markerColors exists
            if (!win.markerColors) {
                win.markerColors = [
                    { id: 'gray', standard: '#808080', pastel: '#c0c0c0' },
                    { id: 'red', standard: '#ff0000', pastel: '#ffcccc' },
                    { id: 'orange', standard: '#ff8800', pastel: '#ffe0cc' },
                    { id: 'yellow', standard: '#ffff00', pastel: '#ffffcc' },
                    { id: 'green', standard: '#00ff00', pastel: '#ccffcc' },
                    { id: 'blue', standard: '#0088ff', pastel: '#cce5ff' },
                    { id: 'purple', standard: '#8800ff', pastel: '#e5ccff' },
                    { id: 'pink', standard: '#ff00ff', pastel: '#ffccff' },
                ];
            }
            
            // Ensure settings.inherit_parent_color exists
            if (win.settings && !win.settings.inherit_parent_color) {
                win.settings.inherit_parent_color = { value: false };
            }
        });
        
        // Check initial state
        const initialState = await page.evaluate(() => {
            const win = window;
            return {
                blockbenchVersion: win.Blockbench?.version,
                hasMarkerColors: Array.isArray(win.markerColors),
                markerColorsLength: win.markerColors?.length,
                hasSettings: typeof win.settings !== 'undefined',
                codecKeys: win.Codecs ? Object.keys(win.Codecs).slice(0, 10) : [],
            };
        });
        
        console.log('\n--- Initial Blockbench state ---');
        console.log(JSON.stringify(initialState, null, 2));
        
        // Test the actual rendering logic
        console.log('\n--- Testing model load ---');
        
        // Create a simple test geometry (same format as we generate)
        const testGeoJson = {
            format_version: '1.12.0',
            'minecraft:geometry': [{
                description: {
                    identifier: 'geometry.test_cube',
                    texture_width: 16,
                    texture_height: 16,
                },
                bones: [{
                    name: 'root',
                    pivot: [0, 0, 0],
                    cubes: [{
                        origin: [-4, 0, -4],
                        size: [8, 8, 8],
                        uv: [0, 0]
                    }]
                }]
            }]
        };
        
        const result = await page.evaluate(async (bedrockGeo) => {
            const logs = [];
            const log = (msg) => { logs.push(msg); console.log('[test] ' + msg); };
            
            try {
                const win = window;
                
                log('Starting model load...');
                log('markerColors exists: ' + Array.isArray(win.markerColors));
                log('markerColors length: ' + (win.markerColors?.length || 0));
                
                // Try to load using the bedrock codec
                log('Attempting Codecs.bedrock.load...');
                let loadError = null;
                try {
                    win.Codecs.bedrock.load(bedrockGeo, { name: 'model.geo.json' });
                    log('Load succeeded!');
                } catch (loadErr) {
                    loadError = loadErr;
                    log('Load error: ' + loadErr.message);
                    log('Stack: ' + (loadErr.stack || '').split('\n').slice(0, 3).join('\n'));
                }
                
                // Check if anything was created
                log('Outliner elements: ' + (win.Outliner?.elements?.length || 0));
                log('Project exists: ' + !!win.Project);
                
                // Wait for any async loading
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Try to center the model
                if (win.Canvas?.center) {
                    try {
                        win.Canvas.center();
                        log('Canvas.center() called');
                    } catch (e) {
                        log('Canvas.center() error: ' + e.message);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Get the preview canvas
                const canvas = document.querySelector('#preview canvas');
                if (!canvas) {
                    return { 
                        success: false, 
                        error: 'Preview canvas not found',
                        logs 
                    };
                }
                
                log('Canvas found, getting image data...');
                const dataUrl = canvas.toDataURL('image/png');
                
                if (dataUrl.length < 1000) {
                    return { 
                        success: false, 
                        error: `Canvas data too small (${dataUrl.length} chars)`,
                        logs
                    };
                }
                
                const elementCount = win.Outliner?.elements?.length || 0;
                
                return { 
                    success: !loadError,
                    loadError: loadError?.message,
                    elementCount,
                    dataUrlLength: dataUrl.length,
                    logs
                };
                
            } catch (e) {
                return { 
                    success: false, 
                    error: e.message || String(e),
                    stack: e.stack,
                    logs
                };
            }
        }, testGeoJson);
        
        console.log('\n--- Render result ---');
        if (result.logs && result.logs.length > 0) {
            console.log('Logs from evaluate:');
            result.logs.forEach(log => console.log('  ' + log));
        }
        console.log('\nResult:', JSON.stringify({ ...result, logs: undefined }, null, 2));
        
        if (result.success) {
            console.log('\n✅ SUCCESS: Model rendered successfully!');
            console.log(`   Elements loaded: ${result.elementCount}`);
            console.log(`   Image data size: ${result.dataUrlLength} chars`);
        } else {
            console.log('\n❌ FAILED:', result.error || result.loadError);
            if (result.stack) {
                console.log('Stack trace:', result.stack);
            }
            
            // Take a screenshot for debugging
            const screenshotPath = path.join(projectDir, 'debug-screenshot.png');
            await page.screenshot({ path: screenshotPath });
            console.log(`Debug screenshot saved to ${screenshotPath}`);
        }
        
        return result.success;
        
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close();
    }
}

// Run the test
testBlockbenchWebRender()
    .then(success => {
        console.log('\n=== Test completed ===');
        process.exit(success ? 0 : 1);
    })
    .catch(err => {
        console.error('Test error:', err);
        process.exit(1);
    });
