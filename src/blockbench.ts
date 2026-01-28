// This file will contain the logic for generating BlockBench project files
// and calling the BlockBench CLI.

// A simplified interface for the parts of the .bbmodel format we care about.
// See the BlockBench documentation for the full format.
export interface BBModel {
  meta: {
    format_version: string;
    model_format: string;
    box_uv: boolean;
  };
  name: string;
  resolution: {
    width: number;
    height: number;
  };
  elements: any[]; // From geometry file
  outliner: any[]; // From geometry file
  textures: BBTexture[];
  animations: BBAnimation[];
}

export interface BBTexture {
  path: string;
  name: string;
  folder: string;
  namespace: string;
  id: string;
  particle: boolean;
  render_mode: string;
  frame_time: number;
  frame_order: any[];
  visible: boolean;
  saved: boolean;
  uuid: string;
}

export interface BBAnimation {
  name: string;
  loop: string;
  override: boolean;
  length: number;
  snapping: number;
  animators: any; // From animation file
  uuid: string;
}

import { Entity } from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export async function createBBFile(
  entity: Entity,
  resourcePackPath: string
): Promise<BBModel> {
  if (!entity.geometryFiles || entity.geometryFiles.length === 0) {
    throw new Error(
      `No geometry files mapped for entity "${entity.identifier}". ` +
      `This usually means the geometry was not found in the resource map.`
    );
  }
  
  const firstGeoFile = entity.geometryFiles[0];
  if (typeof firstGeoFile !== 'string') {
    throw new Error(
      `Invalid geometry file for entity "${entity.identifier}": expected string, got ${typeof firstGeoFile}`
    );
  }
  
  // Load the first geometry file
  // Note: We are simplifying by only loading the first geometry file.
  const geoPath = path.join(resourcePackPath, firstGeoFile);
  const geoContent = await fs.readFile(geoPath, 'utf-8');
  const geoJson = JSON.parse(geoContent);
  const geoArray = geoJson['minecraft:geometry'];
  if (!Array.isArray(geoArray) || geoArray.length === 0) {
    throw new Error(
      `Geometry file "${entity.geometryFiles[0]}" missing minecraft:geometry array`
    );
  }
  const bedrockGeo = geoArray[0];

  // Load and process textures
  // Prefer the "default" texture, then textures with proper paths
  const textures: BBTexture[] = [];
  
  // Build prioritized texture list
  const textureEntries: Array<{ key: string; path: string }> = [];
  
  // First priority: "default" texture
  if (entity.textureMap['default']) {
    textureEntries.push({ key: 'default', path: entity.textureMap['default'] });
  }
  
  // Second priority: textures with "default" in the key name
  for (const [key, texPath] of Object.entries(entity.textureMap)) {
    if (key !== 'default' && key.includes('default')) {
      textureEntries.push({ key, path: texPath });
    }
  }
  
  // Third priority: other textures sorted by quality
  const otherTextures = Object.entries(entity.textureMap)
    .filter(([key]) => key !== 'default' && !key.includes('default'))
    .sort(([, a], [, b]) => {
      // Prefer textures with .png extension
      const aHasExt = a.endsWith('.png') || a.endsWith('.jpg');
      const bHasExt = b.endsWith('.png') || b.endsWith('.jpg');
      if (aHasExt && !bHasExt) return -1;
      if (!aHasExt && bHasExt) return 1;
      // Prefer textures in entity/pokemon folder
      const aIsPokemon = a.includes('entity/pokemon');
      const bIsPokemon = b.includes('entity/pokemon');
      if (aIsPokemon && !bIsPokemon) return -1;
      if (!aIsPokemon && bIsPokemon) return 1;
      return 0;
    });
  
  for (const [key, texPath] of otherTextures) {
    textureEntries.push({ key, path: texPath });
  }
  
  for (const { key, path: textureFile } of textureEntries) {
    let txPath = path.join(resourcePackPath, textureFile);
    
    // If path doesn't have extension, try adding .png
    if (!textureFile.endsWith('.png') && !textureFile.endsWith('.jpg')) {
      txPath = path.join(resourcePackPath, textureFile + '.png');
    }
    
    textures.push({
      path: txPath,
      name: path.basename(textureFile),
      folder: '',
      namespace: '',
      id: key,
      particle: false,
      render_mode: 'normal',
      frame_time: 1,
      frame_order: [],
      visible: true,
      saved: true,
      uuid: uuidv4(),
    });
  }

  // Load and process animations
  const animations: BBAnimation[] = [];
  for (const animFile of entity.animationFiles) {
    const animPath = path.join(resourcePackPath, animFile);
    const animContent = await fs.readFile(animPath, 'utf-8');
    const animJson = JSON.parse(animContent);
    for (const animKey in animJson.animations) {
      const anim = animJson.animations[animKey];
      animations.push({
        name: animKey,
        loop: anim.loop || 'false',
        override: anim.override_previous_animation || false,
        length: anim.animation_length || 0,
        snapping: 24,
        animators: anim.bones || {},
        uuid: uuidv4(),
      });
    }
  }

  // Get texture resolution from geometry description
  const textureWidth = bedrockGeo.description?.texture_width || 64;
  const textureHeight = bedrockGeo.description?.texture_height || 64;
  
  // Construct the BBModel object
  const bbModel: BBModel = {
    meta: {
      format_version: '4.0',
      model_format: 'bedrock',
      box_uv: false,
    },
    name: entity.identifier,
    resolution: { width: textureWidth, height: textureHeight },
    elements: bedrockGeo.bones || [],
    outliner: [], // Simplified for now
    textures,
    animations,
  };

  return bbModel;
}
