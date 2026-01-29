import {
  determineChangedEntities,
  createRenderState,
} from '../render-state';
import { Entity, RenderState, EntityRenderState } from '../types';

// Mock the modules
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  getInput: jest.fn(),
}));

jest.mock('@actions/exec', () => ({
  getExecOutput: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

const exec = require('@actions/exec');
const fs = require('fs/promises');

// Helper to create a complete EntityRenderState with granular hashes
const createEntityRenderState = (
  identifier: string,
  overrides: Partial<EntityRenderState> = {}
): EntityRenderState => ({
  identifier,
  renderedCommit: 'old-commit-sha',
  hasShiny: false,
  entityFileHash: `entity-hash-${identifier}`,
  geometryHashes: { [`models/entity/${identifier}.geo.json`]: `geo-hash-${identifier}` },
  defaultTextureHash: `texture-hash-${identifier}`,
  shinyTextureHash: '',
  animationHashes: {},
  materialHashes: {},
  ...overrides,
});

describe('determineChangedEntities', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: commit is an ancestor
    exec.getExecOutput.mockResolvedValue({ exitCode: 0, stdout: 'commit' });
    // Default: return empty file content for hashing
    fs.readFile.mockResolvedValue(Buffer.from('{}'));
  });

  it('should render all entities on first run (no previous state)', async () => {
    const entities = [createEntity('pikachu'), createEntity('charizard')];
    const baseEntityIds = new Set(['pikachu']); // charizard is new

    const result = await determineChangedEntities(
      entities,
      null, // No previous state
      '/resource-pack',
      [],
      baseEntityIds
    );

    expect(result.isFirstRun).toBe(true);
    expect(result.entitiesToRender).toHaveLength(2);
    expect(result.unchangedEntities).toHaveLength(0);
    // All should have renderDefault and renderShiny flags set based on texture availability
    expect(result.entitiesToRender[0].renderDefault).toBe(true);
    expect(result.entitiesToRender[1].renderDefault).toBe(true);
  });

  it('should render all entities on force push (commit not ancestor)', async () => {
    // Simulate commit not being an ancestor (force push)
    exec.getExecOutput.mockResolvedValue({ exitCode: 1 });

    const entities = [createEntity('pikachu'), createEntity('charizard')];
    const baseEntityIds = new Set(['pikachu', 'charizard']);
    const previousState: RenderState = {
      lastProcessedCommit: 'old-commit-sha',
      lastRenderTimestamp: '2026-01-01T00:00:00Z',
      renderedEntities: {
        pikachu: createEntityRenderState('pikachu'),
      },
    };

    const result = await determineChangedEntities(
      entities,
      previousState,
      '/resource-pack',
      [],
      baseEntityIds
    );

    expect(result.isFirstRun).toBe(false);
    expect(result.entitiesToRender).toHaveLength(2);
    expect(result.unchangedEntities).toHaveLength(0);
  });

  it('should identify new entities that need rendering', async () => {
    const entities = [createEntity('pikachu'), createEntity('charizard')];
    const baseEntityIds = new Set(['pikachu']); // charizard is new to base
    const previousState: RenderState = {
      lastProcessedCommit: 'old-commit-sha',
      lastRenderTimestamp: '2026-01-01T00:00:00Z',
      renderedEntities: {
        pikachu: createEntityRenderState('pikachu'),
        // charizard not in previous state - it's new to render state
      },
    };

    const result = await determineChangedEntities(
      entities,
      previousState,
      '/resource-pack',
      ['entity/charizard.json'], // charizard's files changed
      baseEntityIds
    );

    expect(result.isFirstRun).toBe(false);
    expect(result.entitiesToRender).toHaveLength(1);
    expect(result.entitiesToRender[0].entity.identifier).toBe('charizard');
    expect(result.entitiesToRender[0].isNew).toBe(true); // New to base branch
    expect(result.unchangedEntities).toHaveLength(1);
    expect(result.unchangedEntities[0].identifier).toBe('pikachu');
  });

  it('should skip entities with no changed files', async () => {
    const entities = [createEntity('pikachu'), createEntity('charizard')];
    const baseEntityIds = new Set(['pikachu', 'charizard']);
    const previousState: RenderState = {
      lastProcessedCommit: 'old-commit-sha',
      lastRenderTimestamp: '2026-01-01T00:00:00Z',
      renderedEntities: {
        pikachu: createEntityRenderState('pikachu'),
        charizard: createEntityRenderState('charizard', { hasShiny: true }),
      },
    };

    // No files changed since last commit
    const result = await determineChangedEntities(
      entities,
      previousState,
      '/resource-pack',
      [], // No changed files
      baseEntityIds
    );

    expect(result.isFirstRun).toBe(false);
    expect(result.entitiesToRender).toHaveLength(0);
    expect(result.unchangedEntities).toHaveLength(2);
  });

  it('should detect changed entities based on file changes', async () => {
    // Make hash computation return different values for changed entity
    let callCount = 0;
    fs.readFile.mockImplementation(() => {
      callCount++;
      // Return different content for charizard to simulate change
      return Promise.resolve(Buffer.from(`content-${callCount}`));
    });

    const entities = [createEntity('pikachu'), createEntity('charizard')];
    const baseEntityIds = new Set(['pikachu', 'charizard']);
    const previousState: RenderState = {
      lastProcessedCommit: 'old-commit-sha',
      lastRenderTimestamp: '2026-01-01T00:00:00Z',
      renderedEntities: {
        pikachu: createEntityRenderState('pikachu'),
        charizard: createEntityRenderState('charizard', { hasShiny: true }),
      },
    };

    const result = await determineChangedEntities(
      entities,
      previousState,
      '/resource-pack',
      ['textures/entity/charizard.png'], // charizard's texture changed
      baseEntityIds
    );

    expect(result.isFirstRun).toBe(false);
    // Should detect charizard has changes (granular detection)
    expect(result.entitiesToRender.length).toBeGreaterThanOrEqual(1);
    const charizardChange = result.entitiesToRender.find(e => e.entity.identifier === 'charizard');
    expect(charizardChange).toBeDefined();
  });
});

describe('createRenderState', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFile.mockResolvedValue(Buffer.from('{}'));
  });

  it('should create state for newly rendered entities with granular hashes', async () => {
    const renderedEntities = [createEntity('pikachu')];
    const hasShinyMap = new Map([['pikachu', true]]);

    const state = await createRenderState(
      renderedEntities,
      [],
      null,
      '/resource-pack',
      'new-commit-sha',
      hasShinyMap
    );

    expect(state.lastProcessedCommit).toBe('new-commit-sha');
    expect(state.renderedEntities['pikachu']).toBeDefined();
    expect(state.renderedEntities['pikachu'].identifier).toBe('pikachu');
    expect(state.renderedEntities['pikachu'].hasShiny).toBe(true);
    expect(state.renderedEntities['pikachu'].renderedCommit).toBe('new-commit-sha');
    // Check granular hashes exist
    expect(state.renderedEntities['pikachu'].entityFileHash).toBeDefined();
    expect(state.renderedEntities['pikachu'].geometryHashes).toBeDefined();
    expect(state.renderedEntities['pikachu'].defaultTextureHash).toBeDefined();
    expect(state.renderedEntities['pikachu'].animationHashes).toBeDefined();
    expect(state.renderedEntities['pikachu'].materialHashes).toBeDefined();
  });

  it('should preserve unchanged entities from previous state', async () => {
    const previousState: RenderState = {
      lastProcessedCommit: 'old-commit-sha',
      lastRenderTimestamp: '2026-01-01T00:00:00Z',
      renderedEntities: {
        charizard: createEntityRenderState('charizard', {
          hasShiny: true,
          renderedCommit: 'old-commit-sha',
        }),
      },
    };

    const renderedEntities = [createEntity('pikachu')];
    const unchangedEntities = [createEntity('charizard')];
    const hasShinyMap = new Map([['pikachu', false]]);

    const state = await createRenderState(
      renderedEntities,
      unchangedEntities,
      previousState,
      '/resource-pack',
      'new-commit-sha',
      hasShinyMap
    );

    expect(state.lastProcessedCommit).toBe('new-commit-sha');
    // Newly rendered
    expect(state.renderedEntities['pikachu']).toBeDefined();
    expect(state.renderedEntities['pikachu'].renderedCommit).toBe('new-commit-sha');
    // Preserved from previous
    expect(state.renderedEntities['charizard']).toBeDefined();
    expect(state.renderedEntities['charizard'].renderedCommit).toBe('old-commit-sha');
  });

  it('should include timestamp in state', async () => {
    const state = await createRenderState(
      [],
      [],
      null,
      '/resource-pack',
      'commit-sha',
      new Map()
    );

    expect(state.lastRenderTimestamp).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(state.lastRenderTimestamp).toISOString()).toBe(state.lastRenderTimestamp);
  });
});
