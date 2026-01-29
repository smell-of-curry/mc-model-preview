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
  
  // Check if the last processed commit is still an ancestor (detect force push or missing commit)
  const isAncestor = await isCommitAncestor(previousState.lastProcessedCommit);
  if (!isAncestor) {
    core.info('Previous commit is not an ancestor of current HEAD (force push or commit not found)');
    core.info('Invalidating previous state - will render all affected entities');
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
