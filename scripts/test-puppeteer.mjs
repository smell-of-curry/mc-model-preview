#!/usr/bin/env node
/**
 * Local test script for debugging Puppeteer + Blockbench connection
 * Run with: node scripts/test-puppeteer.mjs
 */

import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(__dirname);

const REMOTE_DEBUG_PORT = 9222;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function findBlockbenchPath() {
    const platform = process.platform;
    
    if (platform === 'darwin') {
        // macOS - check common locations
        const paths = [
            '/Applications/Blockbench.app/Contents/MacOS/Blockbench',
            path.join(process.env.HOME, 'Applications/Blockbench.app/Contents/MacOS/Blockbench'),
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
        console.log('Blockbench not found. Please install from https://www.blockbench.net/downloads');
        console.log('Checked paths:', paths);
        return null;
    } else if (platform === 'linux') {
        // Linux - check for extracted AppImage
        const extractedPath = path.join(projectDir, 'Blockbench_extracted', 'AppRun');
        if (fs.existsSync(extractedPath)) return extractedPath;
        
        // Try to download and extract
        console.log('Running setup script...');
        execSync('bash scripts/setup-blockbench.sh', { cwd: projectDir, stdio: 'inherit' });
        if (fs.existsSync(extractedPath)) return extractedPath;
        
        return null;
    }
    
    console.log('Unsupported platform:', platform);
    return null;
}

async function main() {
    console.log('=== Blockbench + Puppeteer Debug Test ===\n');
    
    const bbPath = await findBlockbenchPath();
    if (!bbPath) {
        process.exit(1);
    }
    console.log('Using Blockbench at:', bbPath);
    
    // Start Blockbench with remote debugging
    console.log('\nStarting Blockbench with remote debugging on port', REMOTE_DEBUG_PORT);
    
    const args = [
        `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
        '--no-sandbox',
    ];
    
    // On Linux headless, we need more flags
    if (process.platform === 'linux' && !process.env.DISPLAY) {
        console.log('No DISPLAY set, starting Xvfb...');
        try {
            execSync('pgrep -x Xvfb || (Xvfb :99 -screen 0 1280x720x24 &)', { shell: true });
            process.env.DISPLAY = ':99';
            await sleep(1000);
        } catch (e) {
            console.log('Xvfb error:', e.message);
        }
        args.push('--disable-gpu', '--disable-dev-shm-usage');
    }
    
    const env = {
        ...process.env,
        ELECTRON_NO_UPDATER: '1',
    };
    
    if (process.platform === 'linux') {
        const extractedDir = path.join(projectDir, 'Blockbench_extracted');
        env.APPDIR = extractedDir;
        env.LD_LIBRARY_PATH = `${extractedDir}:${extractedDir}/usr/lib:${process.env.LD_LIBRARY_PATH || ''}`;
    }
    
    console.log('Launch args:', args.join(' '));
    
    const blockbench = spawn(bbPath, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    
    blockbench.stdout.on('data', (data) => {
        console.log('[BB stdout]', data.toString().trim());
    });
    
    blockbench.stderr.on('data', (data) => {
        console.log('[BB stderr]', data.toString().trim());
    });
    
    blockbench.on('error', (err) => {
        console.error('Blockbench spawn error:', err);
    });
    
    blockbench.on('exit', (code, signal) => {
        console.log('Blockbench exited with code:', code, 'signal:', signal);
    });
    
    // Wait for Blockbench to start
    console.log('\nWaiting for Blockbench to start (may take 10-20 seconds)...');
    
    let browser = null;
    for (let i = 0; i < 30; i++) {
        await sleep(2000);
        try {
            browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${REMOTE_DEBUG_PORT}`,
            });
            console.log('Connected to Blockbench via Puppeteer!');
            break;
        } catch (e) {
            console.log(`Attempt ${i + 1}/30: ${e.message}`);
        }
    }
    
    if (!browser) {
        console.error('Failed to connect to Blockbench');
        blockbench.kill();
        process.exit(1);
    }
    
    try {
        // List all targets (pages, workers, etc.)
        console.log('\n=== Listing all browser targets ===');
        const targets = browser.targets();
        for (const target of targets) {
            console.log(`  Type: ${target.type()}, URL: ${target.url()}`);
        }
        
        // Get all pages
        console.log('\n=== Listing all pages ===');
        const pages = await browser.pages();
        console.log(`Found ${pages.length} page(s)`);
        
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const url = page.url();
            const title = await page.title().catch(() => 'N/A');
            console.log(`\nPage ${i}: "${title}" (${url})`);
            
            // Check what globals are available
            const globals = await page.evaluate(() => {
                return {
                    hasBlockbench: typeof window.Blockbench !== 'undefined',
                    hasCodecs: typeof window.Codecs !== 'undefined',
                    hasFormats: typeof window.Formats !== 'undefined',
                    hasProject: typeof window.Project !== 'undefined',
                    windowKeys: Object.keys(window).filter(k => 
                        k.startsWith('Blockbench') || 
                        k === 'Codecs' || 
                        k === 'Formats' ||
                        k === 'Project' ||
                        k === 'Canvas' ||
                        k === 'Preview'
                    ),
                    documentBody: document.body ? document.body.innerHTML.substring(0, 200) : 'no body',
                };
            }).catch(e => ({ error: e.message }));
            
            console.log('  Globals:', JSON.stringify(globals, null, 2));
        }
        
        // Wait a bit more and check again
        console.log('\n=== Waiting 10 more seconds for Blockbench to fully load ===');
        await sleep(10000);
        
        const pages2 = await browser.pages();
        console.log(`\nNow have ${pages2.length} page(s)`);
        
        for (let i = 0; i < pages2.length; i++) {
            const page = pages2[i];
            const url = page.url();
            const title = await page.title().catch(() => 'N/A');
            console.log(`\nPage ${i}: "${title}" (${url})`);
            
            const globals = await page.evaluate(() => {
                return {
                    hasBlockbench: typeof window.Blockbench !== 'undefined',
                    blockbenchVersion: window.Blockbench?.version,
                    hasCodecs: typeof window.Codecs !== 'undefined',
                    codecKeys: window.Codecs ? Object.keys(window.Codecs) : [],
                    hasFormats: typeof window.Formats !== 'undefined',
                    formatKeys: window.Formats ? Object.keys(window.Formats) : [],
                    hasCanvas: !!document.querySelector('#preview canvas'),
                    canvasSize: document.querySelector('#preview canvas') 
                        ? { 
                            width: document.querySelector('#preview canvas').width,
                            height: document.querySelector('#preview canvas').height 
                          }
                        : null,
                };
            }).catch(e => ({ error: e.message }));
            
            console.log('  Globals:', JSON.stringify(globals, null, 2));
            
            if (globals.hasBlockbench) {
                console.log('\n=== Found Blockbench! Taking screenshot... ===');
                const screenshot = await page.screenshot({ path: 'blockbench-debug.png' });
                console.log('Screenshot saved to blockbench-debug.png');
                
                // Try to capture the canvas
                const canvasData = await page.evaluate(() => {
                    const canvas = document.querySelector('#preview canvas');
                    if (!canvas) return { error: 'No canvas found' };
                    return { dataUrl: canvas.toDataURL('image/png').substring(0, 100) + '...' };
                });
                console.log('Canvas data:', canvasData);
            }
        }
        
    } finally {
        console.log('\nDisconnecting and cleaning up...');
        await browser.disconnect();
        blockbench.kill();
    }
}

main().catch(console.error);
