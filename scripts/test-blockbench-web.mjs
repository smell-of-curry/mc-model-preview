#!/usr/bin/env node
/**
 * Test script that mimics the GitHub Actions environment
 * Tests Blockbench web rendering with headless Chrome
 * 
 * Run locally: node scripts/test-blockbench-web.mjs
 * Run in Docker: docker build -f Dockerfile.test -t mc-model-test . && docker run --rm mc-model-test
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
                    
                    // CRITICAL FIX: The error is "Interface.tab_bar.new_tab" 
                    // where Interface.tab_bar is undefined in web version
                    // Replace all instances of Interface.tab_bar.new_tab with safe access
                    scriptContent = scriptContent.replace(
                        /Interface\.tab_bar\.new_tab/g,
                        '(Interface.tab_bar?.new_tab ?? {visible:false,selected:false,select:()=>{}})'
                    );
                    
                    // Also fix updateThumbnail which tries to access canvas on a null element
                    // The pattern is typically: something.canvas.toDataURL()
                    // Replace with safe access
                    scriptContent = scriptContent.replace(
                        /\.canvas\.toDataURL\(/g,
                        '?.canvas?.toDataURL?.('
                    );
                    
                    request.respond({
                        status: 200,
                        contentType: 'application/javascript',
                        body: scriptContent
                    });
                    console.log('[mc-model-preview] Patched bundle.js (Interface.tab_bar.new_tab fix)');
                    return;
                } catch (e) {
                    console.log('[mc-model-preview] Failed to patch bundle:', e.message);
                }
            }
            
            request.continue();
        });
        
        // Also inject early patching code to create Interface.tab_bar
        await page.evaluateOnNewDocument(() => {
            const patchInterface = () => {
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
                
                // Also patch settings just in case
                if (window.settings && !window.settings.new_tab) {
                    window.settings.new_tab = { value: false };
                }
            };
            const interval = setInterval(patchInterface, 10);
            setTimeout(() => clearInterval(interval), 30000);
        });
        
        console.log('\n--- Loading Blockbench web ---');
        await page.goto(BLOCKBENCH_WEB_URL, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });
        
        console.log('Page loaded, waiting for Blockbench to initialize...');
        
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
        
        // Check initial state of settings
        const initialState = await page.evaluate(() => {
            const win = window;
            return {
                hasSettings: typeof win.settings !== 'undefined',
                settingsType: typeof win.settings,
                settingsIsNull: win.settings === null,
                hasNewTab: win.settings?.new_tab !== undefined,
                newTabType: typeof win.settings?.new_tab,
                blockbenchVersion: win.Blockbench?.version,
                codecKeys: win.Codecs ? Object.keys(win.Codecs).slice(0, 10) : [],
                formatKeys: win.Formats ? Object.keys(win.Formats).slice(0, 10) : [],
            };
        });
        
        console.log('\n--- Initial Blockbench state ---');
        console.log(JSON.stringify(initialState, null, 2));
        
        // Test the actual rendering logic (same as in renderer.ts)
        console.log('\n--- Testing model load with settings fix ---');
        
        // Create a simple test geometry
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
                log('window.settings.new_tab exists: ' + !!win.settings?.new_tab);
                
                // Explore available APIs
                log('Codecs.bedrock methods: ' + Object.keys(win.Codecs?.bedrock || {}).join(', '));
                log('Formats.bedrock methods: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(win.Formats?.bedrock || {})).join(', '));
                
                // The error is in Format.select which has a module-scoped 'settings' that's undefined
                // Let's try to manually create a project and load geometry without triggering select
                
                // Method 1: Try to use setupProject directly instead of through Codecs
                if (win.setupProject && win.Formats?.bedrock) {
                    log('Trying setupProject directly...');
                    try {
                        // setupProject might not trigger select
                        win.setupProject(win.Formats.bedrock);
                        log('setupProject succeeded');
                    } catch (e) {
                        log('setupProject failed: ' + e.message);
                    }
                }
                
                // Method 2: Try to import geometry directly without newProject
                if (win.Codecs?.bedrock?.parse) {
                    log('Trying to parse geometry...');
                    try {
                        const parsed = win.Codecs.bedrock.parse(bedrockGeo, 'model.geo.json');
                        log('Parse result type: ' + typeof parsed);
                        log('Parsed keys: ' + Object.keys(parsed || {}).join(', '));
                    } catch (e) {
                        log('Parse error: ' + e.message);
                    }
                }
                
                // Method 3: Try Project.new() if available
                if (win.Project) {
                    log('Project class exists, methods: ' + Object.keys(win.Project).join(', '));
                }
                
                // Method 4: Try ModelProject if available
                if (win.ModelProject) {
                    log('ModelProject exists');
                }
                
                // Method 5: Check if there's a way to create elements directly
                if (win.Cube || win.Mesh) {
                    log('Direct element classes exist: Cube=' + !!win.Cube + ', Mesh=' + !!win.Mesh);
                }
                
                // Let's try to understand the Format.select code by getting its source
                if (win.Formats?.bedrock?.select) {
                    const selectStr = win.Formats.bedrock.select.toString().substring(0, 500);
                    log('Format.select source preview: ' + selectStr);
                }
                
                // Try to load - catch errors but continue to try to render
                log('Attempting Codecs.bedrock.load...');
                let loadError = null;
                try {
                    win.Codecs.bedrock.load(bedrockGeo, { name: 'model.geo.json' });
                    log('Load succeeded!');
                } catch (loadErr) {
                    loadError = loadErr;
                    log('Load error (might be recoverable): ' + loadErr.message);
                }
                
                // Check if a project was created despite the error
                log('Project created: ' + !!win.Project);
                log('Outliner elements: ' + (win.Outliner?.elements?.length || 0));
                
                // Even if there was an error, check if we can get a render
                // The model might have loaded partially
                
                // Wait for model to load
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Try to center the model
                if (win.Canvas?.center) {
                    win.Canvas.center();
                }
                
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Get the preview canvas
                const canvas = document.querySelector('#preview canvas');
                if (!canvas) {
                    return { success: false, error: 'Preview canvas not found' };
                }
                
                const dataUrl = canvas.toDataURL('image/png');
                
                if (dataUrl.length < 1000) {
                    return { 
                        success: false, 
                        error: `Canvas data too small (${dataUrl.length} chars)`,
                        dataUrlPreview: dataUrl.substring(0, 100)
                    };
                }
                
                const elementCount = win.Outliner?.elements?.length || 0;
                
                return { 
                    success: true, 
                    elementCount,
                    dataUrlLength: dataUrl.length,
                    dataUrlPreview: dataUrl.substring(0, 100) + '...',
                    logs
                };
                
            } catch (e) {
                return { 
                    success: false, 
                    error: e.message || String(e),
                    stack: e.stack,
                    logs: typeof logs !== 'undefined' ? logs : []
                };
            }
        }, testGeoJson);
        
        console.log('\n--- Render result ---');
        if (result.logs && result.logs.length > 0) {
            console.log('Logs from evaluate:');
            result.logs.forEach(log => console.log('  ' + log));
        }
        console.log('Result:', JSON.stringify({ ...result, logs: undefined }, null, 2));
        
        if (result.success) {
            console.log('\n✅ SUCCESS: Model rendered successfully!');
            console.log(`   Elements loaded: ${result.elementCount}`);
            console.log(`   Image data size: ${result.dataUrlLength} chars`);
        } else {
            console.log('\n❌ FAILED:', result.error);
            if (result.stack) {
                console.log('Stack trace:', result.stack);
            }
            
            // Take a screenshot for debugging
            await page.screenshot({ path: 'debug-screenshot.png' });
            console.log('Debug screenshot saved to debug-screenshot.png');
            
            // Get console logs
            page.on('console', msg => console.log('Browser console:', msg.text()));
        }
        
        // Additional debugging - check what's in settings after loading
        const finalState = await page.evaluate(() => {
            const win = window;
            return {
                settingsKeys: win.settings ? Object.keys(win.settings).slice(0, 20) : [],
                newTabValue: win.settings?.new_tab,
                projectExists: !!win.Project,
                outlinerElements: win.Outliner?.elements?.length || 0,
            };
        });
        
        console.log('\n--- Final state ---');
        console.log(JSON.stringify(finalState, null, 2));
        
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
