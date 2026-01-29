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
import { Entity, RenderState, EntityRenderState } from './types';

const IMAGE_BRANCH = 'mc-model-preview-images';
const STATE_FILENAME = 'render-state.json';

/**
 * Fetch the existing render state for a PR from the image branch
 * Returns null if no state exists (first run)
 */
export async function fetchRenderState(prNumber: number): Promise<RenderState | null> {
  const repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const token = core.getInput('github-token');
  const octokit = github.getOctokit(token);
  
  const prFolder = `pr-${prNumber}`;
  const statePath = `${prFolder}/${STATE_FILENAME}`;
  
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
      core.info(`No existing render state found for PR #${prNumber} (first run)`);
      return null;
    }
    core.warning(`Failed to fetch render state: ${error.message}`);
  }
  
  return null;
}

/**
 * Check if a commit is an ancestor of HEAD (used to detect force pushes)
 */
export async function isCommitAncestor(commitSha: string): Promise<boolean> {
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
 * Determine which entities have changed since the last render
 * Returns entities that need to be re-rendered
 */
export async function determineChangedEntities(
  currentEntities: Entity[],
  previousState: RenderState | null,
  resourcePackPath: string,
  changedFilesSinceLastCommit: string[]
): Promise<{
  entitiesToRender: Entity[];
  unchangedEntities: Entity[];
  isFirstRun: boolean;
}> {
  // First run - render everything
  if (!previousState) {
    core.info('First run detected - will render all affected entities');
    return {
      entitiesToRender: currentEntities,
      unchangedEntities: [],
      isFirstRun: true,
    };
  }
  
  // Check if the last processed commit is still an ancestor (detect force push)
  const isAncestor = await isCommitAncestor(previousState.lastProcessedCommit);
  if (!isAncestor) {
    core.info('Force push detected - invalidating previous state, will render all affected entities');
    return {
      entitiesToRender: currentEntities,
      unchangedEntities: [],
      isFirstRun: false,
    };
  }
  
  const entitiesToRender: Entity[] = [];
  const unchangedEntities: Entity[] = [];
  
  // Build a set of changed files for quick lookup
  const changedFilesSet = new Set(changedFilesSinceLastCommit);
  
  for (const entity of currentEntities) {
    const previousEntityState = previousState.renderedEntities[entity.identifier];
    
    // New entity - needs rendering
    if (!previousEntityState) {
      core.info(`Entity ${entity.identifier} is new - will render`);
      entitiesToRender.push(entity);
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
    
    // Files changed - compute hash to see if content actually differs
    const currentHash = await computeEntityHash(entity, resourcePackPath);
    
    if (currentHash === previousEntityState.sourceFilesHash) {
      core.info(`Entity ${entity.identifier} hash unchanged - skipping`);
      unchangedEntities.push(entity);
      continue;
    }
    
    core.info(`Entity ${entity.identifier} has changed (hash differs) - will render`);
    entitiesToRender.push(entity);
  }
  
  core.info(`Incremental render: ${entitiesToRender.length} entities to render, ${unchangedEntities.length} unchanged`);
  
  return {
    entitiesToRender,
    unchangedEntities,
    isFirstRun: false,
  };
}

/**
 * Create a new render state from the current render results
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
  
  // Add newly rendered entities
  for (const entity of renderedEntities) {
    const hash = await computeEntityHash(entity, resourcePackPath);
    state.renderedEntities[entity.identifier] = {
      identifier: entity.identifier,
      sourceFilesHash: hash,
      renderedCommit: currentCommitSha,
      hasShiny: hasShinyMap.get(entity.identifier) ?? false,
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
