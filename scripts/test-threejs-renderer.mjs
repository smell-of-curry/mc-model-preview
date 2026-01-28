#!/usr/bin/env node
/**
 * Test script for the new Three.js renderer
 * Tests rendering Minecraft Bedrock models using Three.js directly
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
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
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

// The Three.js rendering code (same as in threejs-renderer.ts)
const THREEJS_RENDER_SCRIPT = `
function createCube(cube, textureWidth, textureHeight, boneColor) {
  const origin = cube.origin || [0, 0, 0];
  const size = cube.size || [1, 1, 1];
  const inflate = cube.inflate || 0;
  
  const geometry = new THREE.BoxGeometry(
    size[0] + inflate * 2,
    size[1] + inflate * 2,
    size[2] + inflate * 2
  );
  
  const material = new THREE.MeshStandardMaterial({
    color: boneColor,
    roughness: 0.8,
    metalness: 0.1,
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  
  mesh.position.set(
    origin[0] + size[0] / 2,
    origin[1] + size[1] / 2,
    origin[2] + size[2] / 2
  );
  
  if (cube.rotation && cube.pivot) {
    const pivot = cube.pivot;
    const group = new THREE.Group();
    group.position.set(pivot[0], pivot[1], pivot[2]);
    mesh.position.sub(new THREE.Vector3(pivot[0], pivot[1], pivot[2]));
    group.rotation.set(
      THREE.MathUtils.degToRad(cube.rotation[0] || 0),
      THREE.MathUtils.degToRad(cube.rotation[1] || 0),
      THREE.MathUtils.degToRad(cube.rotation[2] || 0)
    );
    group.add(mesh);
    return group;
  }
  
  return mesh;
}

function createBone(bone, textureWidth, textureHeight, colorIndex) {
  const group = new THREE.Group();
  group.name = bone.name;
  
  const colors = [
    0x4a90d9, 0x7cb342, 0xffa726, 0xab47bc, 
    0x26a69a, 0xef5350, 0x5c6bc0, 0x66bb6a
  ];
  const boneColor = colors[colorIndex % colors.length];
  
  if (bone.cubes) {
    for (const cube of bone.cubes) {
      const cubeMesh = createCube(cube, textureWidth, textureHeight, boneColor);
      group.add(cubeMesh);
    }
  }
  
  if (bone.pivot) {
    group.position.set(bone.pivot[0], bone.pivot[1], bone.pivot[2]);
  }
  
  if (bone.rotation) {
    group.rotation.set(
      THREE.MathUtils.degToRad(bone.rotation[0] || 0),
      THREE.MathUtils.degToRad(bone.rotation[1] || 0),
      THREE.MathUtils.degToRad(bone.rotation[2] || 0)
    );
  }
  
  return group;
}

function renderModel(geometry) {
  const description = geometry.description || {};
  const textureWidth = description.texture_width || 16;
  const textureHeight = description.texture_height || 16;
  const bones = geometry.bones || [];
  
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2d2d2d);
  
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 1000);
  
  const canvas = document.getElementById('renderCanvas');
  const renderer = new THREE.WebGLRenderer({ 
    canvas: canvas,
    antialias: true,
    preserveDrawingBuffer: true 
  });
  renderer.setSize(800, 600);
  renderer.setPixelRatio(1);
  
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(50, 100, 50);
  scene.add(directionalLight);
  
  const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  directionalLight2.position.set(-50, 50, -50);
  scene.add(directionalLight2);
  
  const modelGroup = new THREE.Group();
  const boneGroups = new Map();
  
  bones.forEach((bone, index) => {
    const boneGroup = createBone(bone, textureWidth, textureHeight, index);
    boneGroups.set(bone.name, boneGroup);
  });
  
  bones.forEach((bone) => {
    const boneGroup = boneGroups.get(bone.name);
    if (bone.parent && boneGroups.has(bone.parent)) {
      const parentGroup = boneGroups.get(bone.parent);
      if (bone.pivot) {
        const parentBone = bones.find(b => b.name === bone.parent);
        if (parentBone && parentBone.pivot) {
          boneGroup.position.sub(new THREE.Vector3(
            parentBone.pivot[0],
            parentBone.pivot[1],
            parentBone.pivot[2]
          ));
        }
      }
      parentGroup.add(boneGroup);
    } else {
      modelGroup.add(boneGroup);
    }
  });
  
  scene.add(modelGroup);
  
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  
  const distance = maxDim * 2.5;
  camera.position.set(
    center.x + distance * 0.7,
    center.y + distance * 0.5,
    center.z + distance * 0.7
  );
  camera.lookAt(center);
  
  renderer.render(scene, camera);
  
  return { 
    dataUrl: canvas.toDataURL('image/png'),
    boneCount: bones.length,
    cubeCount: bones.reduce((acc, b) => acc + (b.cubes?.length || 0), 0)
  };
}
`;

function getRendererHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #2d2d2d; }
    canvas { display: block; }
  </style>
</head>
<body>
  <canvas id="renderCanvas" width="800" height="600"></canvas>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script>
    ${THREEJS_RENDER_SCRIPT}
    
    window.renderBedrockModel = function(geometryJson) {
      try {
        const geometry = JSON.parse(geometryJson);
        const result = renderModel(geometry);
        return { success: true, ...result };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    };
    
    window.rendererReady = true;
  </script>
</body>
</html>`;
}

async function testThreeJSRenderer() {
    console.log('=== Three.js Renderer Test ===\n');
    
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
            // WebGL support in headless mode
            '--use-gl=swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--disable-software-rasterizer',
        ],
    });
    
    console.log('Browser launched');
    
    let page = null;
    
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 800, height: 600 });
        
        // Load the renderer HTML
        await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
        
        // Wait for renderer to be ready
        await page.waitForFunction(() => window.rendererReady === true, { timeout: 30000 });
        console.log('Three.js renderer ready');
        
        // Test geometry - a simple cube model like a Pokemon
        const testGeometry = {
            description: {
                identifier: 'geometry.test_pokemon',
                texture_width: 64,
                texture_height: 64,
            },
            bones: [
                {
                    name: 'body',
                    pivot: [0, 8, 0],
                    cubes: [
                        { origin: [-4, 4, -4], size: [8, 8, 8] },
                    ]
                },
                {
                    name: 'head',
                    parent: 'body',
                    pivot: [0, 12, 0],
                    cubes: [
                        { origin: [-3, 12, -3], size: [6, 6, 6] },
                    ]
                },
                {
                    name: 'left_arm',
                    parent: 'body',
                    pivot: [-4, 10, 0],
                    cubes: [
                        { origin: [-6, 4, -1], size: [2, 6, 2] },
                    ]
                },
                {
                    name: 'right_arm',
                    parent: 'body',
                    pivot: [4, 10, 0],
                    cubes: [
                        { origin: [4, 4, -1], size: [2, 6, 2] },
                    ]
                },
                {
                    name: 'left_leg',
                    parent: 'body',
                    pivot: [-2, 4, 0],
                    cubes: [
                        { origin: [-4, 0, -1], size: [2, 4, 2] },
                    ]
                },
                {
                    name: 'right_leg',
                    parent: 'body',
                    pivot: [2, 4, 0],
                    cubes: [
                        { origin: [2, 0, -1], size: [2, 4, 2] },
                    ]
                },
            ]
        };
        
        console.log('\n--- Rendering test model ---');
        console.log(`Model has ${testGeometry.bones.length} bones`);
        
        const result = await page.evaluate((geoJson) => {
            return window.renderBedrockModel(geoJson);
        }, JSON.stringify(testGeometry));
        
        console.log('\n--- Render result ---');
        console.log(JSON.stringify({ ...result, dataUrl: result.dataUrl ? `[${result.dataUrl.length} chars]` : null }, null, 2));
        
        if (result.success) {
            console.log('\n✅ SUCCESS: Model rendered successfully!');
            console.log(`   Bones: ${result.boneCount}`);
            console.log(`   Cubes: ${result.cubeCount}`);
            console.log(`   Image data: ${result.dataUrl.length} chars`);
            
            // Save the test image
            const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
            const outputPath = path.join(projectDir, 'test-render.png');
            await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
            console.log(`   Saved to: ${outputPath}`);
            
            return true;
        } else {
            console.log('\n❌ FAILED:', result.error);
            return false;
        }
        
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close();
    }
}

// Run the test
testThreeJSRenderer()
    .then(success => {
        console.log('\n=== Test completed ===');
        process.exit(success ? 0 : 1);
    })
    .catch(err => {
        console.error('Test error:', err);
        process.exit(1);
    });
