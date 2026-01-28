import { findAffectedEntities } from '../differ';
import { Entity } from '../types';

describe('findAffectedEntities', () => {
  const createEntity = (
    identifier: string,
    overrides: Partial<Entity> = {}
  ): Entity => ({
    identifier,
    entityFilePath: `entity/${identifier}.json`,
    geometryFiles: [`models/entity/${identifier}.geo.json`],
    textureFiles: [`textures/entity/${identifier}.png`],
    textureMap: { default: `textures/entity/${identifier}.png` },
    animationFiles: [`animations/${identifier}.animation.json`],
    materialFiles: [],
    ...overrides,
  });

  it('should return empty array when no files changed', () => {
    const entities = [createEntity('creeper'), createEntity('zombie')];
    const changedFiles: string[] = [];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toEqual([]);
  });

  it('should return empty array when changed files do not affect any entity', () => {
    const entities = [createEntity('creeper'), createEntity('zombie')];
    const changedFiles = ['unrelated/file.json', 'another/path.png'];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toEqual([]);
  });

  it('should find entity affected by geometry file change', () => {
    const entities = [createEntity('creeper'), createEntity('zombie')];
    const changedFiles = ['models/entity/creeper.geo.json'];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('creeper');
  });

  it('should find entity affected by texture file change', () => {
    const entities = [createEntity('creeper'), createEntity('zombie')];
    const changedFiles = ['textures/entity/zombie.png'];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('zombie');
  });

  it('should find entity affected by animation file change', () => {
    const entities = [createEntity('creeper'), createEntity('zombie')];
    const changedFiles = ['animations/creeper.animation.json'];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('creeper');
  });

  it('should find entity affected by entity file change', () => {
    const entities = [createEntity('creeper'), createEntity('zombie')];
    const changedFiles = ['entity/zombie.json'];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('zombie');
  });

  it('should find multiple entities affected by multiple changes', () => {
    const entities = [
      createEntity('creeper'),
      createEntity('zombie'),
      createEntity('skeleton'),
    ];
    const changedFiles = [
      'models/entity/creeper.geo.json',
      'textures/entity/skeleton.png',
    ];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toHaveLength(2);
    const identifiers = result.map((e) => e.identifier);
    expect(identifiers).toContain('creeper');
    expect(identifiers).toContain('skeleton');
  });

  it('should not duplicate entities when multiple files for same entity change', () => {
    const entities = [createEntity('creeper')];
    const changedFiles = [
      'models/entity/creeper.geo.json',
      'textures/entity/creeper.png',
      'animations/creeper.animation.json',
    ];

    const result = findAffectedEntities(entities, changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('creeper');
  });

  it('should handle entities with multiple geometry files', () => {
    const entity = createEntity('multi_geo', {
      geometryFiles: ['models/entity/multi_geo_base.geo.json', 'models/entity/multi_geo_head.geo.json'],
    });
    const changedFiles = ['models/entity/multi_geo_head.geo.json'];

    const result = findAffectedEntities([entity], changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('multi_geo');
  });

  it('should handle entities with multiple texture files', () => {
    const entity = createEntity('multi_tex', {
      textureFiles: ['textures/entity/multi_tex.png', 'textures/entity/multi_tex_shiny.png'],
    });
    const changedFiles = ['textures/entity/multi_tex_shiny.png'];

    const result = findAffectedEntities([entity], changedFiles);

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('multi_tex');
  });
});
