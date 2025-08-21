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

  // 1) Models (geometries)
  const modelsGlob = await glob.create(
    `${resourcePackPath}/**/models/**/*.json`
  );
  for await (const file of modelsGlob.globGenerator()) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(content);
      const relativePath = path.relative(resourcePackPath, file);

      // Geometry can be array form under 'minecraft:geometry' OR legacy keyed form
      if (json['minecraft:geometry']) {
        for (const geo of json['minecraft:geometry']) {
          if (geo.description && geo.description.identifier) {
            resourceMap.geometries[geo.description.identifier] = relativePath;
          }
        }
      } else {
        // Legacy: top-level keys like 'geometry.creeper.v1.8'
        for (const key of Object.keys(json)) {
          if (key.startsWith('geometry.')) {
            resourceMap.geometries[key] = relativePath;
          }
        }
      }
    } catch (error) {
      core.warning(`Could not parse model file ${file}: ${error}`);
    }
  }

  // 2) Animations
  const animationsGlob = await glob.create(
    `${resourcePackPath}/**/animations/**/*.json`
  );
  for await (const file of animationsGlob.globGenerator()) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(content);
      const relativePath = path.relative(resourcePackPath, file);
      if (json.animations) {
        for (const animIdentifier in json.animations) {
          resourceMap.animations[animIdentifier] = relativePath;
        }
      }
    } catch (error) {
      core.warning(`Could not parse animation file ${file}: ${error}`);
    }
  }

  // 3) Materials (.material and .json)
  const materialsGlobA = await glob.create(
    `${resourcePackPath}/**/materials/**/*.material`
  );
  const materialsGlobB = await glob.create(
    `${resourcePackPath}/**/materials/**/*.json`
  );
  for await (const file of materialsGlobA.globGenerator()) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(content);
      const relativePath = path.relative(resourcePackPath, file);
      for (const matIdentifier in json) {
        resourceMap.materials[matIdentifier] = relativePath;
      }
    } catch (error) {
      core.warning(`Could not parse material file ${file}: ${error}`);
    }
  }
  for await (const file of materialsGlobB.globGenerator()) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const json = JSON.parse(content);
      const relativePath = path.relative(resourcePackPath, file);
      for (const matIdentifier in json) {
        resourceMap.materials[matIdentifier] = relativePath;
      }
    } catch (error) {
      core.warning(`Could not parse material file ${file}: ${error}`);
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
        materialFiles: [],
      };

      // Map Geometry (value may be 'geometry.creeper' or 'geometry.creeper.v1.8')
      if (description.geometry) {
        for (const key in description.geometry) {
          const geoIdentifier = description.geometry[key];
          if (resourceMap.geometries[geoIdentifier]) {
            entity.geometryFiles.push(resourceMap.geometries[geoIdentifier]);
          }
        }
      }

      // Map Textures (paths may or may not have an extension)
      if (description.textures) {
        for (const key in description.textures) {
          const texturePath = description.textures[key];
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
