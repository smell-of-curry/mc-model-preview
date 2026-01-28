import { Entity, EntityFile, ResourceMap } from '../types';

describe('Types', () => {
  describe('Entity', () => {
    it('should allow creating a valid entity object', () => {
      const entity: Entity = {
        identifier: 'minecraft:creeper',
        entityFilePath: 'entity/creeper.json',
        geometryFiles: ['models/entity/creeper.geo.json'],
        textureFiles: ['textures/entity/creeper.png'],
        textureMap: { default: 'textures/entity/creeper.png' },
        animationFiles: ['animations/creeper.animation.json'],
        materialFiles: ['materials/entity.material'],
      };

      expect(entity.identifier).toBe('minecraft:creeper');
      expect(entity.geometryFiles).toHaveLength(1);
      expect(entity.textureMap.default).toBe('textures/entity/creeper.png');
    });

    it('should allow entities with empty arrays', () => {
      const entity: Entity = {
        identifier: 'minecraft:simple',
        entityFilePath: 'entity/simple.json',
        geometryFiles: [],
        textureFiles: [],
        textureMap: {},
        animationFiles: [],
        materialFiles: [],
      };

      expect(entity.geometryFiles).toHaveLength(0);
      expect(Object.keys(entity.textureMap)).toHaveLength(0);
    });
  });

  describe('EntityFile', () => {
    it('should allow creating a valid entity file object', () => {
      const entityFile: EntityFile = {
        format_version: '1.10.0',
        'minecraft:client_entity': {
          description: {
            identifier: 'minecraft:creeper',
            materials: { default: 'entity' },
            textures: { default: 'textures/entity/creeper' },
            geometry: { default: 'geometry.creeper' },
            animations: { walk: 'animation.creeper.walk' },
          },
        },
      };

      expect(entityFile['minecraft:client_entity'].description.identifier).toBe(
        'minecraft:creeper'
      );
    });

    it('should allow entity file with minimal description', () => {
      const entityFile: EntityFile = {
        format_version: '1.10.0',
        'minecraft:client_entity': {
          description: {
            identifier: 'minecraft:test',
          },
        },
      };

      expect(entityFile['minecraft:client_entity'].description.identifier).toBe(
        'minecraft:test'
      );
      expect(entityFile['minecraft:client_entity'].description.materials).toBeUndefined();
    });
  });

  describe('ResourceMap', () => {
    it('should allow creating a valid resource map', () => {
      const resourceMap: ResourceMap = {
        geometries: {
          'geometry.creeper': 'models/entity/creeper.geo.json',
          'geometry.zombie': 'models/entity/zombie.geo.json',
        },
        animations: {
          'animation.creeper.walk': 'animations/creeper.animation.json',
        },
        materials: {
          default: 'materials/entity.material',
        },
      };

      expect(Object.keys(resourceMap.geometries)).toHaveLength(2);
      expect(resourceMap.geometries['geometry.creeper']).toBe('models/entity/creeper.geo.json');
    });

    it('should allow empty resource map', () => {
      const resourceMap: ResourceMap = {
        geometries: {},
        animations: {},
        materials: {},
      };

      expect(Object.keys(resourceMap.geometries)).toHaveLength(0);
      expect(Object.keys(resourceMap.animations)).toHaveLength(0);
      expect(Object.keys(resourceMap.materials)).toHaveLength(0);
    });
  });
});
