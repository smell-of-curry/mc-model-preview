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
  // Load the first geometry file
  // Note: We are simplifying by only loading the first geometry file.
  const geoPath = path.join(resourcePackPath, entity.geometryFiles[0]);
  const geoContent = await fs.readFile(geoPath, 'utf-8');
  const geoJson = JSON.parse(geoContent);
  const bedrockGeo = geoJson['minecraft:geometry'][0];

  // Load and process textures
  const textures: BBTexture[] = [];
  for (const textureFile of entity.textureFiles) {
    const txPath = path.join(resourcePackPath, textureFile);
    textures.push({
      path: txPath,
      name: path.basename(textureFile),
      folder: '',
      namespace: '',
      id: path.basename(textureFile, path.extname(textureFile)),
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

  // Construct the BBModel object
  const bbModel: BBModel = {
    meta: {
      format_version: '4.0',
      model_format: 'bedrock',
      box_uv: false,
    },
    name: entity.identifier,
    resolution: { width: 16, height: 16 }, // Default texture size
    elements: bedrockGeo.bones || [],
    outliner: [], // Simplified for now
    textures,
    animations,
  };

  return bbModel;
}
