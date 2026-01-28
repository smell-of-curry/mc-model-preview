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

// The Three.js rendering code that runs in the browser
const THREEJS_RENDER_SCRIPT = `
// Helper to create a cube mesh from Bedrock cube data
function createCube(cube, textureWidth, textureHeight, boneColor) {
  const origin = cube.origin || [0, 0, 0];
  const size = cube.size || [1, 1, 1];
  const inflate = cube.inflate || 0;
  
  // Create geometry with inflated size
  const geometry = new THREE.BoxGeometry(
    size[0] + inflate * 2,
    size[1] + inflate * 2,
    size[2] + inflate * 2
  );
  
  // Create material with a color based on bone
  const material = new THREE.MeshStandardMaterial({
    color: boneColor,
    roughness: 0.8,
    metalness: 0.1,
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  
  // Position: Bedrock uses origin as the corner, Three.js uses center
  // Also need to account for inflate
  mesh.position.set(
    origin[0] + size[0] / 2,
    origin[1] + size[1] / 2,
    origin[2] + size[2] / 2
  );
  
  // Handle rotation if present
  if (cube.rotation && cube.pivot) {
    const pivot = cube.pivot;
    // Create a group to handle pivot rotation
    const group = new THREE.Group();
    group.position.set(pivot[0], pivot[1], pivot[2]);
    
    // Offset the mesh by the negative pivot
    mesh.position.sub(new THREE.Vector3(pivot[0], pivot[1], pivot[2]));
    
    // Apply rotation (convert to radians)
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

// Create a bone group with all its cubes
function createBone(bone, textureWidth, textureHeight, colorIndex) {
  const group = new THREE.Group();
  group.name = bone.name;
  
  // Generate a color based on index for visual distinction
  const colors = [
    0x4a90d9, 0x7cb342, 0xffa726, 0xab47bc, 
    0x26a69a, 0xef5350, 0x5c6bc0, 0x66bb6a
  ];
  const boneColor = colors[colorIndex % colors.length];
  
  // Add cubes
  if (bone.cubes) {
    for (const cube of bone.cubes) {
      const cubeMesh = createCube(cube, textureWidth, textureHeight, boneColor);
      group.add(cubeMesh);
    }
  }
  
  // Set bone pivot and rotation
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

// Main render function
function renderModel(geometry) {
  const description = geometry.description || {};
  const textureWidth = description.texture_width || 16;
  const textureHeight = description.texture_height || 16;
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
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(50, 100, 50);
  scene.add(directionalLight);
  
  const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  directionalLight2.position.set(-50, 50, -50);
  scene.add(directionalLight2);
  
  // Create model group
  const modelGroup = new THREE.Group();
  
  // Build bone hierarchy
  const boneGroups = new Map();
  
  // First pass: create all bone groups
  bones.forEach((bone, index) => {
    const boneGroup = createBone(bone, textureWidth, textureHeight, index);
    boneGroups.set(bone.name, boneGroup);
  });
  
  // Second pass: establish parent-child relationships
  bones.forEach((bone) => {
    const boneGroup = boneGroups.get(bone.name);
    if (bone.parent && boneGroups.has(bone.parent)) {
      const parentGroup = boneGroups.get(bone.parent);
      // Adjust position relative to parent
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
  
  // Calculate bounding box to position camera
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  
  // Position camera to see the whole model
  const distance = maxDim * 2.5;
  camera.position.set(
    center.x + distance * 0.7,
    center.y + distance * 0.5,
    center.z + distance * 0.7
  );
  camera.lookAt(center);
  
  // Render
  renderer.render(scene, camera);
  
  // Return canvas data URL
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
    window.renderBedrockModel = function(geometryJson) {
      try {
        const geometry = JSON.parse(geometryJson);
        return { success: true, dataUrl: renderModel(geometry) };
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
    
    // Create page
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the renderer HTML
    await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
    
    // Wait for Three.js and our script to load
    await page.waitForFunction(() => (window as any).rendererReady === true, { timeout: 30000 });
    
    core.info('Three.js renderer ready');
    
    // Call the render function
    const result = await page.evaluate((geoJson: string) => {
      return (window as any).renderBedrockModel(geoJson);
    }, JSON.stringify(geometry));
    
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
        texture_width: bbmodel.resolution?.width || 16,
        texture_height: bbmodel.resolution?.height || 16,
      },
      bones: bbmodel.elements || [],
    };
    
    // Create page
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the renderer HTML
    await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
    
    // Wait for Three.js and our script to load
    await page.waitForFunction(() => (window as any).rendererReady === true, { timeout: 30000 });
    
    core.info('Three.js renderer ready');
    
    // Call the render function
    const result = await page.evaluate((geoJson: string) => {
      return (window as any).renderBedrockModel(geoJson);
    }, JSON.stringify(geometry));
    
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
  outputPath: string,
  browser: Browser
): Promise<boolean> {
  let page: Page | null = null;
  
  try {
    // Create page
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    
    // Load the renderer HTML
    await page.setContent(getRendererHTML(), { waitUntil: 'networkidle0' });
    
    // Wait for Three.js and our script to load
    await page.waitForFunction(() => (window as any).rendererReady === true, { timeout: 30000 });
    
    // Call the render function
    const result = await page.evaluate((geoJson: string) => {
      return (window as any).renderBedrockModel(geoJson);
    }, JSON.stringify(geometry));
    
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
