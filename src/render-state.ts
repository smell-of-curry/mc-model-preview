/**
 * Render state management for incremental rendering
 * Tracks which entities have been rendered and their source file hashes
 */
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Entity, RenderState, EntityRenderState, GranularHashes, EntityChangeInfo } from './types';

const IMAGE_BRANCH = 'mc-model-preview-images';
const STATE_FILENAME = 'render-state.json';

/**
 * Fetch render state from a previous workflow artifact (for fork PRs)
 * GitHub stores artifacts from workflow runs, which we can download and extract
 */
async function fetchRenderStateFromArtifact(prNumber: number): Promise<RenderState | null> {
  const token = core.getInput('github-token');
  const octokit = github.getOctokit(token);
  const artifactName = `model-preview-pr-${prNumber}`;
  
  try {
    // List artifacts for this repo matching our naming pattern
    const { data: { artifacts } } = await octokit.rest.actions.listArtifactsForRepo({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      name: artifactName,
      per_page: 10, // Get recent artifacts
    });
    
    if (artifacts.length === 0) {
      core.info(`No previous artifact found for PR #${prNumber}`);
      return null;
    }
    
    // Find the most recent non-expired artifact
    const latestArtifact = artifacts.find(a => !a.expired);
    if (!latestArtifact) {
      core.info(`All artifacts for PR #${prNumber} have expired`);
      return null;
    }
    
    core.info(`Found artifact: ${latestArtifact.name} (ID: ${latestArtifact.id}, created: ${latestArtifact.created_at})`);
    
    // Download the artifact (returns ArrayBuffer)
    const { data } = await octokit.rest.actions.downloadArtifact({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      artifact_id: latestArtifact.id,
      archive_format: 'zip',
    });
    
    // Save the zip to a temp directory
    const tempDir = path.join(process.cwd(), 'temp-artifact-download');
    await fs.mkdir(tempDir, { recursive: true });
    const zipPath = path.join(tempDir, 'artifact.zip');
    await fs.writeFile(zipPath, Buffer.from(data as ArrayBuffer));
    
    // Extract render-state.json from the zip
    const extractResult = await exec.getExecOutput('unzip', ['-o', zipPath, STATE_FILENAME, '-d', tempDir], {
      ignoreReturnCode: true,
      silent: true,
    });
    
    if (extractResult.exitCode !== 0) {
      core.info(`Artifact does not contain ${STATE_FILENAME} (older format)`);
      await fs.rm(tempDir, { recursive: true, force: true });
      return null;
    }
    
    // Read the extracted file
    const statePath = path.join(tempDir, STATE_FILENAME);
    const content = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(content) as RenderState;
    
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
    
    core.info(`Fetched render state from artifact ${artifactName}`);
    core.info(`Last processed commit: ${state.lastProcessedCommit}`);
    core.info(`Previously rendered entities: ${Object.keys(state.renderedEntities).length}`);
    
    return state;
  } catch (error: any) {
    core.warning(`Failed to fetch render state from artifact: ${error.message}`);
    return null;
  }
}

/**
 * Fetch the existing render state for a PR
 * Tries multiple sources in order:
 * 1. Git branch (for non-fork PRs)
 * 2. Workflow artifacts (for fork PRs)
 * Returns null if no state exists (first run)
 */
export async function fetchRenderState(prNumber: number): Promise<RenderState | null> {
  const token = core.getInput('github-token');
  const octokit = github.getOctokit(token);
  
  const prFolder = `pr-${prNumber}`;
  const statePath = `${prFolder}/${STATE_FILENAME}`;
  
  // First, try to fetch from Git branch (works for non-fork PRs)
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: statePath,
      ref: IMAGE_BRANCH,
    });
    
    if ('content' in data && data.type === 'file') {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const state = JSON.parse(content) as RenderState;
      core.info(`Fetched existing render state from ${IMAGE_BRANCH}/${statePath}`);
      core.info(`Last processed commit: ${state.lastProcessedCommit}`);
      core.info(`Previously rendered entities: ${Object.keys(state.renderedEntities).length}`);
      return state;
    }
  } catch (error: any) {
    if (error.status === 404) {
      core.info(`No render state on branch for PR #${prNumber}, checking artifacts...`);
    } else {
      core.warning(`Failed to fetch render state from branch: ${error.message}`);
    }
  }
  
  // If branch fetch fails, try fetching from artifact (for fork PRs)
  const artifactState = await fetchRenderStateFromArtifact(prNumber);
  if (artifactState) {
    return artifactState;
  }
  
  core.info(`No existing render state found for PR #${prNumber} (first run)`);
  return null;
}

/**
 * Check if a commit exists in the repository
 */
async function commitExists(commitSha: string): Promise<boolean> {
  try {
    const result = await exec.getExecOutput(
      'git',
      ['cat-file', '-t', commitSha],
      { ignoreReturnCode: true, silent: true }
    );
    return result.exitCode === 0 && result.stdout.trim() === 'commit';
  } catch {
    return false;
  }
}

/**
 * Check if a commit is an ancestor of HEAD (used to detect force pushes)
 * Also handles the case where the commit doesn't exist (returns false)
 */
export async function isCommitAncestor(commitSha: string): Promise<boolean> {
  // First check if the commit even exists
  const exists = await commitExists(commitSha);
  if (!exists) {
    core.info(`Commit ${commitSha.substring(0, 7)} not found in repository (may be an ephemeral merge commit)`);
    return false;
  }
  
  try {
    const result = await exec.getExecOutput(
      'git',
      ['merge-base', '--is-ancestor', commitSha, 'HEAD'],
      { ignoreReturnCode: true, silent: true }
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Compute a hash of all source files for an entity
 * This includes: entity file, geometry files, texture files, animation files, material files
 * @deprecated Use computeGranularHashes for fine-grained change detection
 */
export async function computeEntityHash(
  entity: Entity,
  resourcePackPath: string
): Promise<string> {
  const hash = crypto.createHash('sha256');
  
  // Collect all source files
  const sourceFiles = [
    entity.entityFilePath,
    ...entity.geometryFiles,
    ...entity.textureFiles,
    ...entity.animationFiles,
    ...entity.materialFiles,
  ];
  
  // Sort for deterministic ordering
  sourceFiles.sort();
  
  for (const file of sourceFiles) {
    try {
      const fullPath = path.join(resourcePackPath, file);
      const content = await fs.readFile(fullPath);
      // Include the filename in the hash to detect renames
      hash.update(file);
      hash.update(content);
    } catch (error) {
      // File might not exist (e.g., deleted), include that fact in hash
      hash.update(`MISSING:${file}`);
    }
  }
  
  return hash.digest('hex');
}

/**
 * Compute a hash for a single file
 */
async function computeFileHash(filePath: string, resourcePackPath: string): Promise<string> {
  try {
    let fullPath = path.join(resourcePackPath, filePath);
    // Handle paths without extension
    if (!filePath.endsWith('.png') && !filePath.endsWith('.jpg') && filePath.includes('textures/')) {
      fullPath = path.join(resourcePackPath, filePath + '.png');
    }
    const content = await fs.readFile(fullPath);
    const hash = crypto.createHash('sha256');
    hash.update(filePath);
    hash.update(content);
    return hash.digest('hex');
  } catch (error) {
    return `MISSING:${filePath}`;
  }
}

/**
 * Get the best texture key for the default (non-shiny) variant
 */
function getDefaultTextureKey(textureMap: Record<string, string>): string | null {
  const keys = Object.keys(textureMap);
  if (keys.includes('default')) return 'default';
  const maleDefault = keys.find(k => k === 'male_default');
  if (maleDefault) return maleDefault;
  const anyNonShiny = keys.find(k => !k.startsWith('shiny_') && k !== 'evo_aura');
  return anyNonShiny || null;
}

/**
 * Get the best texture key for the shiny variant
 */
function getShinyTextureKey(textureMap: Record<string, string>): string | null {
  const keys = Object.keys(textureMap);
  if (keys.includes('shiny_default')) return 'shiny_default';
  const shinyMaleDefault = keys.find(k => k === 'shiny_male_default');
  if (shinyMaleDefault) return shinyMaleDefault;
  const anyShiny = keys.find(k => k.startsWith('shiny_'));
  return anyShiny || null;
}

/**
 * Compute granular hashes for an entity's source files
 * This allows fine-grained change detection to determine exactly what needs to be re-rendered
 */
export async function computeGranularHashes(
  entity: Entity,
  resourcePackPath: string
): Promise<GranularHashes> {
  // Hash the entity definition file
  const entityFileHash = await computeFileHash(entity.entityFilePath, resourcePackPath);
  
  // Hash each geometry file
  const geometryHashes: Record<string, string> = {};
  for (const geoFile of entity.geometryFiles) {
    geometryHashes[geoFile] = await computeFileHash(geoFile, resourcePackPath);
  }
  
  // Hash the default texture
  const defaultTextureKey = getDefaultTextureKey(entity.textureMap);
  let defaultTextureHash = '';
  if (defaultTextureKey && entity.textureMap[defaultTextureKey]) {
    defaultTextureHash = await computeFileHash(entity.textureMap[defaultTextureKey], resourcePackPath);
  }
  
  // Hash the shiny texture
  const shinyTextureKey = getShinyTextureKey(entity.textureMap);
  let shinyTextureHash = '';
  if (shinyTextureKey && entity.textureMap[shinyTextureKey]) {
    shinyTextureHash = await computeFileHash(entity.textureMap[shinyTextureKey], resourcePackPath);
  }
  
  // Hash each animation file, keyed by animation identifier
  // We need to read animation files to get the animation identifiers inside them
  const animationHashes: Record<string, string> = {};
  for (const animFile of entity.animationFiles) {
    try {
      const fullPath = path.join(resourcePackPath, animFile);
      const content = await fs.readFile(fullPath, 'utf-8');
      const animJson = JSON.parse(content);
      
      if (animJson.animations) {
        // Compute a hash for each animation identifier in this file
        const fileHash = crypto.createHash('sha256');
        fileHash.update(animFile);
        fileHash.update(content);
        const hash = fileHash.digest('hex');
        
        for (const animId of Object.keys(animJson.animations)) {
          // All animations in the same file share the same hash
          // (since we need to re-render if any part of the file changes)
          animationHashes[animId] = hash;
        }
      }
    } catch (error) {
      // If we can't read the file, mark all known animations as missing
      core.warning(`Could not read animation file ${animFile}: ${error}`);
    }
  }
  
  // Hash each material file
  const materialHashes: Record<string, string> = {};
  for (const matFile of entity.materialFiles) {
    materialHashes[matFile] = await computeFileHash(matFile, resourcePackPath);
  }
  
  return {
    entityFileHash,
    geometryHashes,
    defaultTextureHash,
    shinyTextureHash,
    animationHashes,
    materialHashes,
  };
}

/**
 * Check if the entity render state uses the legacy format (single hash)
 */
function isLegacyState(state: EntityRenderState): boolean {
  return !state.entityFileHash || state.entityFileHash === undefined;
}

/**
 * Get all animation identifiers for an entity
 */
export async function getAllAnimationIds(
  entity: Entity,
  resourcePackPath: string
): Promise<string[]> {
  const animIds: string[] = [];
  const entityName = entity.identifier.split(':').pop() || entity.identifier;
  
  for (const animFile of entity.animationFiles) {
    try {
      const fullPath = path.join(resourcePackPath, animFile);
      const content = await fs.readFile(fullPath, 'utf-8');
      const animJson = JSON.parse(content);
      
      if (animJson.animations) {
        for (const animId of Object.keys(animJson.animations)) {
          // Only include animations that match this entity's name pattern
          if (animId.includes(`.${entityName}.`)) {
            animIds.push(animId);
          }
        }
      }
    } catch (error) {
      core.warning(`Could not read animation file ${animFile}: ${error}`);
    }
  }
  
  return animIds;
}

/**
 * Determine what needs to be rendered for an entity based on granular change detection
 */
async function determineEntityRenderNeeds(
  entity: Entity,
  previousState: EntityRenderState,
  currentHashes: GranularHashes,
  resourcePackPath: string
): Promise<EntityChangeInfo> {
  const hasShiny = !!currentHashes.shinyTextureHash && currentHashes.shinyTextureHash !== '';
  
  // Entity file changed -> render everything (references may have changed)
  if (currentHashes.entityFileHash !== previousState.entityFileHash) {
    core.info(`  Entity file changed - will render all`);
    const allAnimIds = await getAllAnimationIds(entity, resourcePackPath);
    return {
      entity,
      renderDefault: true,
      renderShiny: hasShiny,
      animationsToRender: allAnimIds,
      isNew: false,
    };
  }
  
  // Check if geometry changed
  const geometryChanged = Object.keys(currentHashes.geometryHashes).some(file => {
    const prevHash = previousState.geometryHashes?.[file];
    return prevHash !== currentHashes.geometryHashes[file];
  }) || Object.keys(previousState.geometryHashes || {}).some(file => {
    return !currentHashes.geometryHashes[file];
  });
  
  if (geometryChanged) {
    core.info(`  Geometry changed - will render models and all animations`);
    const allAnimIds = await getAllAnimationIds(entity, resourcePackPath);
    return {
      entity,
      renderDefault: true,
      renderShiny: hasShiny,
      animationsToRender: allAnimIds,
      isNew: false,
    };
  }
  
  // Start with nothing to render
  const info: EntityChangeInfo = {
    entity,
    renderDefault: false,
    renderShiny: false,
    animationsToRender: [],
    isNew: false,
  };
  
  // Default texture changed -> only render default model
  if (currentHashes.defaultTextureHash !== previousState.defaultTextureHash) {
    core.info(`  Default texture changed - will render default model`);
    info.renderDefault = true;
  }
  
  // Shiny texture changed -> only render shiny model
  if (hasShiny && currentHashes.shinyTextureHash !== previousState.shinyTextureHash) {
    core.info(`  Shiny texture changed - will render shiny model`);
    info.renderShiny = true;
  }
  
  // Check individual animations
  const currentAnimIds = new Set(Object.keys(currentHashes.animationHashes));
  const prevAnimIds = new Set(Object.keys(previousState.animationHashes || {}));
  
  // Find changed animations
  for (const animId of currentAnimIds) {
    const prevHash = previousState.animationHashes?.[animId];
    if (prevHash !== currentHashes.animationHashes[animId]) {
      core.info(`  Animation ${animId} changed - will render`);
      info.animationsToRender.push(animId);
    }
  }
  
  // Find new animations (in current but not in previous)
  for (const animId of currentAnimIds) {
    if (!prevAnimIds.has(animId) && !info.animationsToRender.includes(animId)) {
      core.info(`  Animation ${animId} is new - will render`);
      info.animationsToRender.push(animId);
    }
  }
  
  // Check if materials changed -> render models (not animations)
  const materialChanged = Object.keys(currentHashes.materialHashes).some(file => {
    const prevHash = previousState.materialHashes?.[file];
    return prevHash !== currentHashes.materialHashes[file];
  }) || Object.keys(previousState.materialHashes || {}).some(file => {
    return !currentHashes.materialHashes[file];
  });
  
  if (materialChanged) {
    core.info(`  Material changed - will render models`);
    info.renderDefault = true;
    info.renderShiny = hasShiny;
  }
  
  return info;
}

/**
 * Determine which entities have changed since the last render
 * Returns detailed info about what needs to be re-rendered for each entity
 */
export async function determineChangedEntities(
  currentEntities: Entity[],
  previousState: RenderState | null,
  resourcePackPath: string,
  changedFilesSinceLastCommit: string[],
  baseEntityIds: Set<string>
): Promise<{
  entitiesToRender: EntityChangeInfo[];
  unchangedEntities: Entity[];
  isFirstRun: boolean;
}> {
  // First run - render everything for all entities
  if (!previousState) {
    core.info('First run detected - will render all affected entities');
    const entitiesToRender: EntityChangeInfo[] = [];
    
    for (const entity of currentEntities) {
      const hasShiny = !!getShinyTextureKey(entity.textureMap);
      const allAnimIds = await getAllAnimationIds(entity, resourcePackPath);
      const isNew = !baseEntityIds.has(entity.identifier);
      
      entitiesToRender.push({
        entity,
        renderDefault: true,
        renderShiny: hasShiny,
        animationsToRender: allAnimIds,
        isNew,
      });
    }
    
    return {
      entitiesToRender,
      unchangedEntities: [],
      isFirstRun: true,
    };
  }
  
  // Check if the last processed commit is still an ancestor (detect force push or missing commit)
  const isAncestor = await isCommitAncestor(previousState.lastProcessedCommit);
  if (!isAncestor) {
    core.info('Previous commit is not an ancestor of current HEAD (force push or commit not found)');
    core.info('Invalidating previous state - will render all affected entities');
    
    const entitiesToRender: EntityChangeInfo[] = [];
    for (const entity of currentEntities) {
      const hasShiny = !!getShinyTextureKey(entity.textureMap);
      const allAnimIds = await getAllAnimationIds(entity, resourcePackPath);
      const isNew = !baseEntityIds.has(entity.identifier);
      
      entitiesToRender.push({
        entity,
        renderDefault: true,
        renderShiny: hasShiny,
        animationsToRender: allAnimIds,
        isNew,
      });
    }
    
    return {
      entitiesToRender,
      unchangedEntities: [],
      isFirstRun: false,
    };
  }
  
  const entitiesToRender: EntityChangeInfo[] = [];
  const unchangedEntities: Entity[] = [];
  
  // Build a set of changed files for quick lookup
  const changedFilesSet = new Set(changedFilesSinceLastCommit);
  
  for (const entity of currentEntities) {
    const previousEntityState = previousState.renderedEntities[entity.identifier];
    const isNew = !baseEntityIds.has(entity.identifier);
    
    // New entity in the render state - needs full rendering
    if (!previousEntityState) {
      core.info(`Entity ${entity.identifier} is new to render state - will render all`);
      const hasShiny = !!getShinyTextureKey(entity.textureMap);
      const allAnimIds = await getAllAnimationIds(entity, resourcePackPath);
      
      entitiesToRender.push({
        entity,
        renderDefault: true,
        renderShiny: hasShiny,
        animationsToRender: allAnimIds,
        isNew,
      });
      continue;
    }
    
    // Check if any of this entity's source files changed
    const entityFiles = [
      entity.entityFilePath,
      ...entity.geometryFiles,
      ...entity.textureFiles,
      ...entity.animationFiles,
      ...entity.materialFiles,
    ];
    
    const hasChangedFile = entityFiles.some(file => changedFilesSet.has(file));
    
    if (!hasChangedFile) {
      core.info(`Entity ${entity.identifier} has no changed files since last commit - skipping`);
      unchangedEntities.push(entity);
      continue;
    }
    
    // Compute granular hashes for detailed change detection
    const currentHashes = await computeGranularHashes(entity, resourcePackPath);
    
    // Check if this is a legacy state (only has sourceFilesHash)
    if (isLegacyState(previousEntityState)) {
      core.info(`Entity ${entity.identifier} has legacy state - will render all (one-time migration)`);
      const hasShiny = !!getShinyTextureKey(entity.textureMap);
      const allAnimIds = await getAllAnimationIds(entity, resourcePackPath);
      
      entitiesToRender.push({
        entity,
        renderDefault: true,
        renderShiny: hasShiny,
        animationsToRender: allAnimIds,
        isNew,
      });
      continue;
    }
    
    // Determine what specifically needs to be rendered
    core.info(`Entity ${entity.identifier} has changed files - determining render needs:`);
    const changeInfo = await determineEntityRenderNeeds(
      entity,
      previousEntityState,
      currentHashes,
      resourcePackPath
    );
    changeInfo.isNew = isNew;
    
    // Check if anything actually needs rendering
    if (!changeInfo.renderDefault && !changeInfo.renderShiny && changeInfo.animationsToRender.length === 0) {
      core.info(`Entity ${entity.identifier} - no actual changes detected, skipping`);
      unchangedEntities.push(entity);
      continue;
    }
    
    const renderSummary = [];
    if (changeInfo.renderDefault) renderSummary.push('default');
    if (changeInfo.renderShiny) renderSummary.push('shiny');
    if (changeInfo.animationsToRender.length > 0) {
      renderSummary.push(`${changeInfo.animationsToRender.length} animation(s)`);
    }
    core.info(`Entity ${entity.identifier} will render: ${renderSummary.join(', ')}`);
    
    entitiesToRender.push(changeInfo);
  }
  
  core.info(`Granular incremental render: ${entitiesToRender.length} entities need rendering, ${unchangedEntities.length} unchanged`);
  
  return {
    entitiesToRender,
    unchangedEntities,
    isFirstRun: false,
  };
}

/**
 * Create a new render state from the current render results
 * Uses granular hashes for fine-grained change detection
 */
export async function createRenderState(
  renderedEntities: Entity[],
  unchangedEntities: Entity[],
  previousState: RenderState | null,
  resourcePackPath: string,
  currentCommitSha: string,
  hasShinyMap: Map<string, boolean>
): Promise<RenderState> {
  const state: RenderState = {
    lastProcessedCommit: currentCommitSha,
    lastRenderTimestamp: new Date().toISOString(),
    renderedEntities: {},
  };
  
  // Copy over unchanged entities from previous state
  if (previousState) {
    for (const entity of unchangedEntities) {
      const prevEntityState = previousState.renderedEntities[entity.identifier];
      if (prevEntityState) {
        state.renderedEntities[entity.identifier] = prevEntityState;
      }
    }
  }
  
  // Add newly rendered entities with granular hashes
  for (const entity of renderedEntities) {
    const granularHashes = await computeGranularHashes(entity, resourcePackPath);
    const hasShiny = hasShinyMap.get(entity.identifier) ?? false;
    
    state.renderedEntities[entity.identifier] = {
      identifier: entity.identifier,
      renderedCommit: currentCommitSha,
      hasShiny,
      // Granular hashes for fine-grained change detection
      entityFileHash: granularHashes.entityFileHash,
      geometryHashes: granularHashes.geometryHashes,
      defaultTextureHash: granularHashes.defaultTextureHash,
      shinyTextureHash: granularHashes.shinyTextureHash,
      animationHashes: granularHashes.animationHashes,
      materialHashes: granularHashes.materialHashes,
    };
  }
  
  return state;
}

/**
 * Save render state to a local file (to be committed with images)
 */
export async function saveRenderStateToFile(
  state: RenderState,
  outputDir: string
): Promise<string> {
  const statePath = path.join(outputDir, STATE_FILENAME);
  const content = JSON.stringify(state, null, 2);
  await fs.writeFile(statePath, content);
  
  // Verify the file was written
  try {
    const stat = await fs.stat(statePath);
    core.info(`Saved render state to ${statePath} (${stat.size} bytes)`);
  } catch (error) {
    core.warning(`Failed to verify render state file: ${error}`);
  }
  
  return statePath;
}
