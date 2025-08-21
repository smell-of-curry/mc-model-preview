import * as core from '@actions/core';
import * as glob from '@actions/glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Entity, EntityFile, ResourceMap } from './types';

async function buildResourceMap(resourcePackPath: string): Promise<ResourceMap> {
  const resourceMap: ResourceMap = {
    geometries: {},
    animations: {},
    materials: {},
  };

  // Find all geometry, animation, and material files
  const globber = await glob.create(
    `${resourcePackPath}/**/{models,animations,materials}/**/*.{json,material}`
  );
  for await (const file of globber.globGenerator()) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(content);
      const relativePath = path.relative(resourcePackPath, file);

      if (relativePath.startsWith('models')) {
        // It's a geometry file
        if (json['minecraft:geometry']) {
          for (const geo of json['minecraft:geometry']) {
            if (geo.description && geo.description.identifier) {
              resourceMap.geometries[geo.description.identifier] = relativePath;
            }
          }
        }
      } else if (relativePath.startsWith('animations')) {
        // It's an animation file
        if (json.animations) {
          for (const animIdentifier in json.animations) {
            resourceMap.animations[animIdentifier] = relativePath;
          }
        }
      } else if (relativePath.startsWith('materials')) {
        // It's a material file
        // The key in the material file is the identifier
        for (const matIdentifier in json) {
          resourceMap.materials[matIdentifier] = relativePath;
        }
      }
    } catch (error) {
      core.warning(`Could not parse ${file}: ${error}`);
    }
  }

  return resourceMap;
}

export async function parseResourcePack(resourcePackPath: string): Promise<Entity[]> {
  core.info('Building resource map...');
  const resourceMap = await buildResourceMap(resourcePackPath);
  core.info(
    `Found ${Object.keys(resourceMap.geometries).length} geometries and ${
      Object.keys(resourceMap.animations).length
    } animations.`
  );

  const entities: Entity[] = [];
  const globber = await glob.create(`${resourcePackPath}/**/entity/**/*.json`);

  core.info('Parsing entity files...');
  for await (const file of globber.globGenerator()) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const entityFile = JSON.parse(content) as EntityFile;
      const description = entityFile['minecraft:client_entity']?.description;

      if (!description) continue;

      const entity: Entity = {
        identifier: description.identifier,
        entityFilePath: path.relative(resourcePackPath, file),
        geometryFiles: [],
        textureFiles: [],
        animationFiles: [],
        materialFiles: [], // Note: Material parsing is not yet implemented
      };

      // Map Geometry
      if (description.geometry) {
        for (const key in description.geometry) {
          const geoIdentifier = description.geometry[key];
          if (resourceMap.geometries[geoIdentifier]) {
            entity.geometryFiles.push(resourceMap.geometries[geoIdentifier]);
          }
        }
      }

      // Map Textures
      if (description.textures) {
        for (const key in description.textures) {
          const texturePath = description.textures[key];
          // The path is relative to the RP root, extension is included
          entity.textureFiles.push(texturePath);
        }
      }

      // Map Animations
      if (description.animations) {
        for (const key in description.animations) {
          const animIdentifier = description.animations[key];
          if (resourceMap.animations[animIdentifier]) {
            entity.animationFiles.push(resourceMap.animations[animIdentifier]);
          }
        }
      }

      // Map Materials
      if (description.materials) {
        for (const key in description.materials) {
          const matIdentifier = description.materials[key];
          if (resourceMap.materials[matIdentifier]) {
            entity.materialFiles.push(resourceMap.materials[matIdentifier]);
          }
        }
      }

      entities.push(entity);
    } catch (error) {
      core.warning(`Could not parse entity file ${file}: ${error}`);
    }
  }
  core.info(`Successfully parsed ${entities.length} entities.`);
  return entities;
}

async function temp() {
  core.info('temp');
}
