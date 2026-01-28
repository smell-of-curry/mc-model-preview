/**
 * Three.js based model renderer for Minecraft Bedrock geometry
 * This replaces the Blockbench Web approach which has UI dependency issues in headless mode.
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Browser, Page } from 'puppeteer-core';

// Bedrock geometry types
interface BedrockCube {
  origin?: [number, number, number];
  size?: [number, number, number];
  uv?: [number, number] | Record<string, { uv: [number, number]; uv_size: [number, number] }>;
  rotation?: [number, number, number];
  pivot?: [number, number, number];
  inflate?: number;
  mirror?: boolean;
}

interface BedrockBone {
  name: string;
  parent?: string;
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  cubes?: BedrockCube[];
  locators?: Record<string, any>;
}

interface BedrockGeometry {
  description?: {
    identifier?: string;
    texture_width?: number;
    texture_height?: number;
  };
  bones?: BedrockBone[];
}

interface BedrockGeoFile {
  format_version?: string;
  'minecraft:geometry'?: BedrockGeometry[];
}

// The Three.js rendering code that runs in the browser - with texture support
const THREEJS_RENDER_SCRIPT = `
// Create a textured cube mesh from Bedrock cube data
// bonePivot is needed to position cube relative to its bone
function createTexturedCube(cube, bonePivot, textureWidth, textureHeight, texture, fallbackColor) {
  const origin = cube.origin || [0, 0, 0];
  const size = cube.size || [1, 1, 1];
  const inflate = cube.inflate || 0;
  
  const w = Math.abs(size[0]) + inflate * 2;
  const h = Math.abs(size[1]) + inflate * 2;
  const d = Math.abs(size[2]) + inflate * 2;
  
  // Determine UV mode
  const uv = cube.uv;
  const isPerFaceUV = uv && typeof uv === 'object' && !Array.isArray(uv);
  const isBoxUV = uv && Array.isArray(uv);
  
  let material;
  
  if (texture && (isPerFaceUV || isBoxUV)) {
    // Create materials for each face with proper UV mapping
    const materials = [];
    
    if (isPerFaceUV) {
      // Per-face UV mapping
      // Three.js BoxGeometry face order: +X(east), -X(west), +Y(up), -Y(down), +Z(south), -Z(north)
      const faces = ['east', 'west', 'up', 'down', 'south', 'north'];
      
      for (let i = 0; i < 6; i++) {
        const faceName = faces[i];
        const faceUV = uv[faceName];
        
        if (faceUV && faceUV.uv && faceUV.uv_size) {
          // Clone texture for this face
          const faceTexture = texture.clone();
          faceTexture.needsUpdate = true;
          faceTexture.magFilter = THREE.NearestFilter;
          faceTexture.minFilter = THREE.NearestFilter;
          
          // Handle negative UV sizes (texture flip)
          let uvX = faceUV.uv[0];
          let uvY = faceUV.uv[1];
          let uvW = faceUV.uv_size[0];
          let uvH = faceUV.uv_size[1];
          
          // If negative size, adjust start position
          if (uvW < 0) {
            uvX = uvX + uvW;
            uvW = Math.abs(uvW);
          }
          if (uvH < 0) {
            uvY = uvY + uvH;
            uvH = Math.abs(uvH);
          }
          
          // Calculate UV offset and repeat (normalized 0-1)
          const offsetU = uvX / textureWidth;
          const offsetV = 1 - (uvY + uvH) / textureHeight;
          const repeatU = uvW / textureWidth;
          const repeatV = uvH / textureHeight;
          
          faceTexture.offset.set(offsetU, offsetV);
          faceTexture.repeat.set(repeatU, repeatV);
          
          const mat = new THREE.MeshStandardMaterial({
            map: faceTexture,
            transparent: true,
            alphaTest: 0.1,
            side: THREE.DoubleSide,
          });
          
          materials.push(mat);
        } else {
          // No UV for this face, use fallback
          materials.push(new THREE.MeshStandardMaterial({ 
            color: fallbackColor,
            transparent: true,
          }));
        }
      }
      
      material = materials;
    } else if (isBoxUV) {
      // Box UV mapping (legacy format) - simplified
      const mat = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide,
      });
      material = mat;
    }
  } else {
    // No texture or no UV, use fallback color
    material = new THREE.MeshStandardMaterial({
      color: fallbackColor,
      roughness: 0.8,
      metalness: 0.1,
    });
  }
  
  const geometry = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geometry, material);
  
  // Position cube relative to bone pivot
  // Bedrock origin is corner, Three.js uses center, so add size/2
  // Then subtract bone pivot since bone group is positioned at pivot
  mesh.position.set(
    origin[0] + size[0] / 2 - bonePivot[0],
    origin[1] + size[1] / 2 - bonePivot[1],
    origin[2] + size[2] / 2 - bonePivot[2]
  );
  
  // Handle per-cube rotation if present
  if (cube.rotation && cube.pivot) {
    const cubePivot = cube.pivot;
    // Create a group for rotation around cube's pivot
    const rotGroup = new THREE.Group();
    // Position rotation group at cube pivot relative to bone
    rotGroup.position.set(
      cubePivot[0] - bonePivot[0],
      cubePivot[1] - bonePivot[1],
      cubePivot[2] - bonePivot[2]
    );
    // Offset mesh from the rotation pivot
    mesh.position.set(
      origin[0] + size[0] / 2 - cubePivot[0],
      origin[1] + size[1] / 2 - cubePivot[1],
      origin[2] + size[2] / 2 - cubePivot[2]
    );
    // Apply rotation (Bedrock uses XYZ order in degrees)
    rotGroup.rotation.set(
      THREE.MathUtils.degToRad(-(cube.rotation[0] || 0)),
      THREE.MathUtils.degToRad(-(cube.rotation[1] || 0)),
      THREE.MathUtils.degToRad(cube.rotation[2] || 0)
    );
    rotGroup.add(mesh);
    return rotGroup;
  }
  
  return mesh;
}

// Create a bone group with all its cubes
function createBone(bone, textureWidth, textureHeight, texture, colorIndex) {
  const group = new THREE.Group();
  group.name = bone.name;
  
  const colors = [
    0x4a90d9, 0x7cb342, 0xffa726, 0xab47bc, 
    0x26a69a, 0xef5350, 0x5c6bc0, 0x66bb6a
  ];
  const boneColor = colors[colorIndex % colors.length];
  
  const bonePivot = bone.pivot || [0, 0, 0];
  
  if (bone.cubes) {
    for (const cube of bone.cubes) {
      const cubeMesh = createTexturedCube(cube, bonePivot, textureWidth, textureHeight, texture, boneColor);
      group.add(cubeMesh);
    }
  }
  
  // Position bone at its pivot
  group.position.set(bonePivot[0], bonePivot[1], bonePivot[2]);
  
  // Apply bone rotation (Bedrock uses XYZ in degrees)
  if (bone.rotation) {
    group.rotation.set(
      THREE.MathUtils.degToRad(-(bone.rotation[0] || 0)),
      THREE.MathUtils.degToRad(-(bone.rotation[1] || 0)),
      THREE.MathUtils.degToRad(bone.rotation[2] || 0)
    );
  }
  
  return group;
}

// Main render function
async function renderModel(geometry, textureDataUrl) {
  const description = geometry.description || {};
  const textureWidth = description.texture_width || 64;
  const textureHeight = description.texture_height || 64;
  const bones = geometry.bones || [];
  
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2d2d2d);
  
  // Create camera
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 1000);
  
  // Create renderer
  const canvas = document.getElementById('renderCanvas');
  const renderer = new THREE.WebGLRenderer({ 
    canvas: canvas,
    antialias: true,
    preserveDrawingBuffer: true 
  });
  renderer.setSize(800, 600);
  renderer.setPixelRatio(1);
  
  // Add lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
  directionalLight.position.set(50, 100, 50);
  scene.add(directionalLight);
  
  const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
  directionalLight2.position.set(-50, 50, -50);
  scene.add(directionalLight2);
  
  // Load texture if provided
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
  
  // Create model group
  const modelGroup = new THREE.Group();
  const boneGroups = new Map();
  const boneData = new Map();
  
  // Store bone data for hierarchy calculations
  bones.forEach((bone) => {
    boneData.set(bone.name, bone);
  });
  
  // First pass: create all bone groups
  bones.forEach((bone, index) => {
    const boneGroup = createBone(bone, textureWidth, textureHeight, texture, index);
    boneGroups.set(bone.name, boneGroup);
  });
  
  // Second pass: establish parent-child relationships
  bones.forEach((bone) => {
    const boneGroup = boneGroups.get(bone.name);
    if (bone.parent && boneGroups.has(bone.parent)) {
      const parentGroup = boneGroups.get(bone.parent);
      const parentBone = boneData.get(bone.parent);
      
      // Child bone position should be relative to parent's pivot
      if (parentBone && parentBone.pivot) {
        const childPivot = bone.pivot || [0, 0, 0];
        boneGroup.position.set(
          childPivot[0] - parentBone.pivot[0],
          childPivot[1] - parentBone.pivot[1],
          childPivot[2] - parentBone.pivot[2]
        );
      }
      parentGroup.add(boneGroup);
    } else {
      modelGroup.add(boneGroup);
    }
  });
  
  scene.add(modelGroup);
  
  // Calculate bounding box to position camera
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  
  // Position camera to see the whole model from North-West corner
  // In Minecraft: North = -Z, West = -X
  const distance = maxDim * 2.5;
  camera.position.set(
    center.x - distance * 0.7,
    center.y + distance * 0.5,
    center.z - distance * 0.7
  );
  camera.lookAt(center);
  
  // Render
  renderer.render(scene, camera);
  
  return canvas.toDataURL('image/png');
}
`;

/**
 * HTML template for the Three.js renderer page
 */
function getRendererHTML(): string {
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
    
    // This will be called from puppeteer
    window.renderBedrockModel = async function(geometryJson, textureDataUrl) {
      try {
        const geometry = JSON.parse(geometryJson);
        const dataUrl = await renderModel(geometry, textureDataUrl);
        return { success: true, dataUrl };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    };
    
    // Signal that the page is ready
    window.rendererReady = true;
  </script>
</body>
</html>`;
}

/**
 * Load a texture file and convert to data URL
 */
async function loadTextureAsDataURL(texturePath: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(texturePath);
    const ext = path.extname(texturePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (e) {
    core.warning(`Failed to load texture ${texturePath}: ${e}`);
    return null;
  }
}

/**
 * Render a Bedrock geometry model using Three.js
 */
export async function renderModelWithThreeJS(
  geometryPath: string,
  texturePath: string | null,
  outputPath: string,
  browser: Browser
): Promise<boolean> {
  let page: Page | null = null;
  
  try {
    // Read the geometry file
    const geoContent = await fs.readFile(geometryPath, 'utf-8');
    const geoJson: BedrockGeoFile = JSON.parse(geoContent);
    
    // Get the first geometry
    const geometries = geoJson['minecraft:geometry'];
    if (!geometries || geometries.length === 0) {
      core.warning(`No geometry found in ${geometryPath}`);
      return false;
    }
    const geometry = geometries[0];
    
    // Load texture if provided
    const textureDataUrl = texturePath ? await loadTextureAsDataURL(texturePath) : null;
    
    // Create page
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the renderer HTML
    await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
    
    // Wait for Three.js and our script to load
    await page.waitForFunction(() => (window as any).rendererReady === true, { timeout: 30000 });
    
    core.info('Three.js renderer ready');
    
    // Call the render function
    const result = await page.evaluate(async (geoJson: string, textureUrl: string | null) => {
      return await (window as any).renderBedrockModel(geoJson, textureUrl);
    }, JSON.stringify(geometry), textureDataUrl);
    
    if (!result.success) {
      core.warning(`Three.js render failed: ${result.error}`);
      return false;
    }
    
    if (result.dataUrl) {
      // Convert data URL to buffer and save
      const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
      core.info(`Saved render to ${outputPath}`);
      return true;
    }
    
    return false;
  } catch (e) {
    core.warning(`Three.js render error: ${e}`);
    return false;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Render from a BBModel file (for backward compatibility during transition)
 */
export async function renderBBModelWithThreeJS(
  bbmodelPath: string,
  outputPath: string,
  browser: Browser
): Promise<boolean> {
  let page: Page | null = null;
  
  try {
    // Read the BBModel file
    const bbmodelContent = await fs.readFile(bbmodelPath, 'utf-8');
    const bbmodel = JSON.parse(bbmodelContent);
    
    // Extract geometry from BBModel format
    // BBModel stores bones in 'elements' (confusingly named)
    const geometry: BedrockGeometry = {
      description: {
        identifier: bbmodel.name || 'model',
        texture_width: bbmodel.resolution?.width || 64,
        texture_height: bbmodel.resolution?.height || 64,
      },
      bones: bbmodel.elements || [],
    };
    
    // Load texture from BBModel if available
    let textureDataUrl: string | null = null;
    if (bbmodel.textures && bbmodel.textures.length > 0) {
      const firstTexture = bbmodel.textures[0];
      if (firstTexture.path) {
        textureDataUrl = await loadTextureAsDataURL(firstTexture.path);
      }
    }
    
    // Create page
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the renderer HTML
    await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
    
    // Wait for Three.js and our script to load
    await page.waitForFunction(() => (window as any).rendererReady === true, { timeout: 30000 });
    
    core.info('Three.js renderer ready');
    
    // Call the render function
    const result = await page.evaluate(async (geoJson: string, textureUrl: string | null) => {
      return await (window as any).renderBedrockModel(geoJson, textureUrl);
    }, JSON.stringify(geometry), textureDataUrl);
    
    if (!result.success) {
      core.warning(`Three.js render failed: ${result.error}`);
      return false;
    }
    
    if (result.dataUrl) {
      // Convert data URL to buffer and save
      const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
      core.info(`Saved render to ${outputPath}`);
      return true;
    }
    
    return false;
  } catch (e) {
    core.warning(`Three.js render error: ${e}`);
    return false;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Render directly from a Bedrock geometry object
 * This is the preferred method as it skips the BBModel intermediate format
 */
export async function renderGeometryWithThreeJS(
  geometry: BedrockGeometry,
  texturePath: string | null,
  outputPath: string,
  browser: Browser
): Promise<boolean> {
  let page: Page | null = null;
  
  try {
    // Load texture if provided
    const textureDataUrl = texturePath ? await loadTextureAsDataURL(texturePath) : null;
    
    // Create page
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the renderer HTML
    await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
    
    // Wait for Three.js and our script to load
    await page.waitForFunction(() => (window as any).rendererReady === true, { timeout: 30000 });
    
    // Call the render function
    const result = await page.evaluate(async (geoJson: string, textureUrl: string | null) => {
      return await (window as any).renderBedrockModel(geoJson, textureUrl);
    }, JSON.stringify(geometry), textureDataUrl);
    
    if (!result.success) {
      core.warning(`Three.js render failed: ${result.error}`);
      return false;
    }
    
    if (result.dataUrl) {
      // Convert data URL to buffer and save
      const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
      return true;
    }
    
    return false;
  } catch (e) {
    core.warning(`Three.js render error: ${e}`);
    return false;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

// Export types for use in other modules
export type { BedrockGeometry, BedrockBone, BedrockCube, BedrockGeoFile };
