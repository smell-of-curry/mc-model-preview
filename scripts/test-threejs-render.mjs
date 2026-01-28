#!/usr/bin/env node
/**
 * Test direct Three.js rendering of Minecraft models
 * Bypasses Blockbench's buggy web API entirely
 */

import puppeteer from 'puppeteer-core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(__dirname);

async function findChromePath() {
    const possiblePaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of possiblePaths) {
        try {
            await fs.access(p);
            return p;
        } catch {}
    }
    throw new Error('Chrome not found');
}

async function testThreeJsRender() {
    console.log('=== Three.js Direct Rendering Test ===\n');
    
    const chromePath = await findChromePath();
    console.log('Using Chrome at:', chromePath);
    
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--headless=new',
            // Enable WebGL in headless mode
            '--use-gl=swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
        ],
    });
    
    let page = null;
    
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 800, height: 600 });
        
        // Create a minimal HTML page with Three.js
        const html = `
<!DOCTYPE html>
<html>
<head>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body style="margin:0;overflow:hidden;">
    <canvas id="canvas"></canvas>
    <script>
        window.renderMinecraftModel = function(geometry) {
            const canvas = document.getElementById('canvas');
            canvas.width = 800;
            canvas.height = 600;
            
            const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
            renderer.setSize(800, 600);
            renderer.setClearColor(0x87ceeb); // Sky blue background
            
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(45, 800/600, 0.1, 1000);
            camera.position.set(20, 15, 20);
            camera.lookAt(0, 5, 0);
            
            // Add lighting
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
            scene.add(ambientLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
            directionalLight.position.set(10, 20, 10);
            scene.add(directionalLight);
            
            // Parse Minecraft geometry and create meshes
            const geoData = geometry['minecraft:geometry']?.[0];
            if (!geoData) {
                return { error: 'No minecraft:geometry found' };
            }
            
            const bones = geoData.bones || [];
            const material = new THREE.MeshLambertMaterial({ color: 0x808080 });
            
            bones.forEach(bone => {
                const pivot = bone.pivot || [0, 0, 0];
                const rotation = bone.rotation || [0, 0, 0];
                
                const cubes = bone.cubes || [];
                cubes.forEach(cube => {
                    const origin = cube.origin || [0, 0, 0];
                    const size = cube.size || [1, 1, 1];
                    
                    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
                    const mesh = new THREE.Mesh(geometry, material);
                    
                    // Position: origin is corner, we need center
                    mesh.position.set(
                        origin[0] + size[0]/2,
                        origin[1] + size[1]/2,
                        origin[2] + size[2]/2
                    );
                    
                    // Apply bone pivot offset
                    mesh.position.x += pivot[0];
                    mesh.position.y += pivot[1];
                    mesh.position.z += pivot[2];
                    
                    scene.add(mesh);
                });
            });
            
            // Render
            renderer.render(scene, camera);
            
            const dataUrl = canvas.toDataURL('image/png');
            return { success: true, dataUrl, boneCount: bones.length };
        };
    </script>
</body>
</html>`;
        
        await page.setContent(html);
        
        // Wait for Three.js to load
        await page.waitForFunction(() => typeof THREE !== 'undefined', { timeout: 10000 });
        console.log('Three.js loaded');
        
        // Test geometry
        const testGeo = {
            format_version: '1.12.0',
            'minecraft:geometry': [{
                description: {
                    identifier: 'geometry.test_cube',
                    texture_width: 16,
                    texture_height: 16,
                },
                bones: [{
                    name: 'body',
                    pivot: [0, 0, 0],
                    cubes: [{
                        origin: [-4, 0, -4],
                        size: [8, 8, 8],
                        uv: [0, 0]
                    }]
                }, {
                    name: 'head',
                    pivot: [0, 8, 0],
                    cubes: [{
                        origin: [-3, 8, -3],
                        size: [6, 6, 6],
                        uv: [0, 0]
                    }]
                }]
            }]
        };
        
        console.log('Rendering test geometry...');
        const result = await page.evaluate((geo) => {
            return window.renderMinecraftModel(geo);
        }, testGeo);
        
        console.log('Result:', result.success ? 'SUCCESS' : `FAILED: ${result.error}`);
        
        if (result.success) {
            console.log(`Rendered ${result.boneCount} bones`);
            
            // Save the image
            const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
            await fs.writeFile('test-threejs-output.png', Buffer.from(base64Data, 'base64'));
            console.log('Saved to test-threejs-output.png');
        }
        
        return result.success;
        
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close();
    }
}

testThreeJsRender()
    .then(success => {
        console.log('\n=== Test completed ===');
        process.exit(success ? 0 : 1);
    })
    .catch(err => {
        console.error('Test error:', err);
        process.exit(1);
    });
