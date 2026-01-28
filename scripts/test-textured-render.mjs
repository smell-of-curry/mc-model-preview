#!/usr/bin/env node
/**
 * Test rendering an actual Pokemon model with textures
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

async function loadTextureAsDataURL(texturePath) {
    try {
        const buffer = await fs.readFile(texturePath);
        const ext = path.extname(texturePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (e) {
        console.warn('Failed to load texture:', e.message);
        return null;
    }
}

// Same render script as threejs-renderer.ts (with texture support)
const THREEJS_RENDER_SCRIPT = `
function createTexturedCube(cube, textureWidth, textureHeight, texture, fallbackColor) {
  const origin = cube.origin || [0, 0, 0];
  const size = cube.size || [1, 1, 1];
  const inflate = cube.inflate || 0;
  
  const w = size[0] + inflate * 2;
  const h = size[1] + inflate * 2;
  const d = size[2] + inflate * 2;
  
  const uv = cube.uv;
  const isPerFaceUV = uv && typeof uv === 'object' && !Array.isArray(uv);
  const isBoxUV = uv && Array.isArray(uv);
  
  let material;
  
  if (texture && (isPerFaceUV || isBoxUV)) {
    const materials = [];
    
    if (isPerFaceUV) {
      const faces = ['east', 'west', 'up', 'down', 'south', 'north'];
      
      for (let i = 0; i < 6; i++) {
        const faceName = faces[i];
        const faceUV = uv[faceName];
        
        if (faceUV && faceUV.uv && faceUV.uv_size) {
          const mat = new THREE.MeshStandardMaterial({
            map: texture.clone(),
            transparent: true,
            alphaTest: 0.1,
            side: THREE.DoubleSide,
          });
          
          const u = faceUV.uv[0] / textureWidth;
          const v = 1 - (faceUV.uv[1] + Math.abs(faceUV.uv_size[1])) / textureHeight;
          const repeatU = Math.abs(faceUV.uv_size[0]) / textureWidth;
          const repeatV = Math.abs(faceUV.uv_size[1]) / textureHeight;
          
          mat.map.offset.set(u, v);
          mat.map.repeat.set(repeatU, repeatV);
          mat.map.needsUpdate = true;
          
          materials.push(mat);
        } else {
          materials.push(new THREE.MeshStandardMaterial({ 
            color: fallbackColor,
            transparent: true,
          }));
        }
      }
      
      material = materials;
    } else if (isBoxUV) {
      const mat = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide,
      });
      material = mat;
    }
  } else {
    material = new THREE.MeshStandardMaterial({
      color: fallbackColor,
      roughness: 0.8,
      metalness: 0.1,
    });
  }
  
  const geometry = new THREE.BoxGeometry(w, h, d);
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

function createBone(bone, textureWidth, textureHeight, texture, colorIndex) {
  const group = new THREE.Group();
  group.name = bone.name;
  
  const colors = [
    0x4a90d9, 0x7cb342, 0xffa726, 0xab47bc, 
    0x26a69a, 0xef5350, 0x5c6bc0, 0x66bb6a
  ];
  const boneColor = colors[colorIndex % colors.length];
  
  if (bone.cubes) {
    for (const cube of bone.cubes) {
      const cubeMesh = createTexturedCube(cube, textureWidth, textureHeight, texture, boneColor);
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

async function renderModel(geometry, textureDataUrl) {
  const description = geometry.description || {};
  const textureWidth = description.texture_width || 64;
  const textureHeight = description.texture_height || 64;
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
  
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
  directionalLight.position.set(50, 100, 50);
  scene.add(directionalLight);
  
  const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
  directionalLight2.position.set(-50, 50, -50);
  scene.add(directionalLight2);
  
  let texture = null;
  if (textureDataUrl) {
    const textureLoader = new THREE.TextureLoader();
    texture = await new Promise((resolve, reject) => {
      textureLoader.load(
        textureDataUrl,
        (tex) => {
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          resolve(tex);
        },
        undefined,
        (err) => {
          console.warn('Failed to load texture:', err);
          resolve(null);
        }
      );
    });
  }
  
  const modelGroup = new THREE.Group();
  const boneGroups = new Map();
  
  bones.forEach((bone, index) => {
    const boneGroup = createBone(bone, textureWidth, textureHeight, texture, index);
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
  
  return canvas.toDataURL('image/png');
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
    
    window.renderBedrockModel = async function(geometryJson, textureDataUrl) {
      try {
        const geometry = JSON.parse(geometryJson);
        const dataUrl = await renderModel(geometry, textureDataUrl);
        return { success: true, dataUrl };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    };
    
    window.rendererReady = true;
  </script>
</body>
</html>`;
}

async function testTexturedRender() {
    console.log('=== Textured Pokemon Model Rendering Test ===\n');
    
    // Paths
    const resPath = path.resolve(projectDir, '../pokebedrock/pokebedrock-res');
    const geoPath = path.join(resPath, 'models/entity/pokemon/ferroseed.geo.json');
    const texturePath = path.join(resPath, 'textures/entity/pokemon/ferroseed/ferroseed.png');
    
    console.log('Loading geometry from:', geoPath);
    console.log('Loading texture from:', texturePath);
    
    let geoContent;
    try {
        geoContent = await fs.readFile(geoPath, 'utf-8');
    } catch (e) {
        console.error('Failed to read geometry file:', e.message);
        return false;
    }
    
    const geoJson = JSON.parse(geoContent);
    const geometry = geoJson['minecraft:geometry'][0];
    
    // Load texture
    const textureDataUrl = await loadTextureAsDataURL(texturePath);
    console.log('Texture loaded:', textureDataUrl ? 'yes' : 'no');
    
    console.log('Model:', geometry.description?.identifier || 'unknown');
    console.log('Texture size:', geometry.description?.texture_width || 64, 'x', geometry.description?.texture_height || 64);
    console.log('Bones:', geometry.bones?.length || 0);
    
    const chromePath = await findChromePath();
    console.log('\nUsing Chrome at:', chromePath);
    
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--headless=new',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--enable-gpu',
            '--use-angle=default',
        ],
    });
    
    console.log('Browser launched');
    
    let page = null;
    
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 800, height: 600 });
        
        await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.rendererReady === true, { timeout: 30000 });
        
        console.log('Renderer ready, rendering model with texture...');
        
        const result = await page.evaluate(async (geoJson, textureUrl) => {
            return await window.renderBedrockModel(geoJson, textureUrl);
        }, JSON.stringify(geometry), textureDataUrl);
        
        console.log('\n--- Render result ---');
        
        if (result.success) {
            console.log('✅ SUCCESS!');
            console.log(`   Image size: ${result.dataUrl.length} chars`);
            
            const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
            const outputPath = path.join(projectDir, 'ferroseed-textured.png');
            await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
            console.log(`   Saved to: ${outputPath}`);
            
            return true;
        } else {
            console.log('❌ FAILED:', result.error);
            return false;
        }
        
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close();
    }
}

testTexturedRender()
    .then(success => {
        console.log('\n=== Test completed ===');
        process.exit(success ? 0 : 1);
    })
    .catch(err => {
        console.error('Test error:', err);
        process.exit(1);
    });
