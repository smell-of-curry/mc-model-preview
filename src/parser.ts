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

  core.info(`Resource pack path: ${resourcePackPath}`);

  // 1) Models (geometries)
  const modelsPattern = `${resourcePackPath}/models/**/*.json`;
  core.info(`Models glob pattern: ${modelsPattern}`);
  const modelsGlob = await glob.create(modelsPattern);
  let modelFileCount = 0;
  for await (const file of modelsGlob.globGenerator()) {
    modelFileCount++;
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
  core.info(`Scanned ${modelFileCount} model files, found ${Object.keys(resourceMap.geometries).length} geometry identifiers.`);

  // Debug: if no models found, list the directory to help diagnose
  if (modelFileCount === 0) {
    try {
      const modelsDir = path.join(resourcePackPath, 'models');
      const dirExists = await fs.stat(modelsDir).then(() => true).catch(() => false);
      if (dirExists) {
        const contents = await fs.readdir(modelsDir);
        core.info(`Models directory exists. Contents: ${contents.slice(0, 10).join(', ')}${contents.length > 10 ? '...' : ''}`);
      } else {
        core.warning(`Models directory does not exist at: ${modelsDir}`);
      }
    } catch (e) {
      core.warning(`Could not list models directory: ${e}`);
    }
  }

  // 2) Animations
  const animPattern = `${resourcePackPath}/animations/**/*.json`;
  core.info(`Animations glob pattern: ${animPattern}`);
  const animationsGlob = await glob.create(animPattern);
  let animFileCount = 0;
  for await (const file of animationsGlob.globGenerator()) {
    animFileCount++;
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
  core.info(`Scanned ${animFileCount} animation files, found ${Object.keys(resourceMap.animations).length} animation identifiers.`);

  // 3) Materials (.material and .json)
  const materialsGlobA = await glob.create(
    `${resourcePackPath}/materials/**/*.material`
  );
  const materialsGlobB = await glob.create(
    `${resourcePackPath}/materials/**/*.json`
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
        textureMap: {},
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
          if (typeof texturePath === 'string' && texturePath.length > 0) {
            entity.textureFiles.push(texturePath);
            entity.textureMap[key] = texturePath;
          }
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
