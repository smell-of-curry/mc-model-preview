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

export type TextureVariant = 'normal' | 'shiny';

/**
 * Check if an entity has a shiny texture variant available
 */
export function hasShinyTexture(entity: Entity): boolean {
  return Object.keys(entity.textureMap).some(key => key.startsWith('shiny_'));
}

/**
 * Get the best texture key for the given variant
 */
function getTextureKeyForVariant(textureMap: Record<string, string>, variant: TextureVariant): string | null {
  const keys = Object.keys(textureMap);
  
  if (variant === 'shiny') {
    // For shiny, look for keys starting with "shiny_"
    // Priority: shiny_default > shiny_male_default > any shiny_*
    if (keys.includes('shiny_default')) return 'shiny_default';
    const shinyMaleDefault = keys.find(k => k === 'shiny_male_default');
    if (shinyMaleDefault) return shinyMaleDefault;
    const anyShiny = keys.find(k => k.startsWith('shiny_'));
    return anyShiny || null;
  }
  
  // For normal, look for non-shiny keys
  // Priority: default > male_default > any non-shiny key
  if (keys.includes('default')) return 'default';
  const maleDefault = keys.find(k => k === 'male_default');
  if (maleDefault) return maleDefault;
  const anyNonShiny = keys.find(k => !k.startsWith('shiny_') && k !== 'evo_aura');
  return anyNonShiny || null;
}

export async function createBBFile(
  entity: Entity,
  resourcePackPath: string,
  variant: TextureVariant = 'normal'
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

  // Load and process textures based on variant
  const textures: BBTexture[] = [];
  
  // Get the best texture key for the requested variant
  const textureKey = getTextureKeyForVariant(entity.textureMap, variant);
  
  if (textureKey && entity.textureMap[textureKey]) {
    const textureFile = entity.textureMap[textureKey];
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
      id: textureKey,
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
