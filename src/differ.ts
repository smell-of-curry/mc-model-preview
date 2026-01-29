import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Entity, ChangedAnimation, AnimationFile, BedrockAnimation } from './types';

export async function getChangedFiles(): Promise<string[]> {
  const token = core.getInput('github-token');
  const octokit = github.getOctokit(token);

  const { owner, repo } = github.context.repo;
  const pull_number = github.context.issue.number;

  if (!pull_number) {
    core.warning('Could not get pull request number from context, exiting');
    return [];
  }

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number,
  });

  return files.map((file) => file.filename);
}

/**
 * Get files changed since a specific commit
 * Uses git diff to find files changed between the given commit and HEAD
 * This is used for incremental rendering to only re-render what changed
 */
export async function getChangedFilesSinceCommit(
  baseSha: string
): Promise<string[]> {
  try {
    const result = await exec.getExecOutput(
      'git',
      ['diff', '--name-only', `${baseSha}...HEAD`],
      { silent: true }
    );
    
    const files = result.stdout
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);
    
    core.info(`Found ${files.length} files changed since commit ${baseSha.substring(0, 7)}`);
    return files;
  } catch (error) {
    core.warning(`Failed to get changed files since ${baseSha}: ${error}`);
    // Fall back to getting all PR files
    return getChangedFiles();
  }
}

export function findAffectedEntities(
  allEntities: Entity[],
  changedFiles: string[]
): Entity[] {
  const affectedEntities = new Set<Entity>();

  for (const changedFile of changedFiles) {
    for (const entity of allEntities) {
      const entityFiles = [
        entity.entityFilePath,
        ...entity.geometryFiles,
        ...entity.textureFiles,
        ...entity.animationFiles,
        ...entity.materialFiles,
      ];
      if (entityFiles.includes(changedFile)) {
        affectedEntities.add(entity);
      }
    }
  }

  return Array.from(affectedEntities);
}

/**
 * Load and parse an animation file
 */
async function loadAnimationFile(filePath: string): Promise<AnimationFile | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as AnimationFile;
  } catch {
    return null;
  }
}

/**
 * Compare two animations to check if they're different
 */
function areAnimationsDifferent(
  anim1: BedrockAnimation | undefined,
  anim2: BedrockAnimation | undefined
): boolean {
  if (!anim1 && !anim2) return false;
  if (!anim1 || !anim2) return true;

  // Simple comparison using JSON stringify
  // This catches any differences in the animation data
  return JSON.stringify(anim1) !== JSON.stringify(anim2);
}

/**
 * Find which specific animations changed between base and head versions
 * Returns a list of changed animations with their entity associations
 */
export async function findChangedAnimations(
  entities: Entity[],
  changedFiles: string[],
  resourcePackPath: string,
  baseResourcePackPath?: string
): Promise<ChangedAnimation[]> {
  const changedAnimations: ChangedAnimation[] = [];

  // Filter to only animation files that changed
  const changedAnimationFiles = changedFiles.filter(
    (f) => f.includes('/animations/') && f.endsWith('.animation.json')
  );

  if (changedAnimationFiles.length === 0) {
    return [];
  }

  core.info(`Found ${changedAnimationFiles.length} changed animation files`);

  // Build a map of animation identifier -> entity
  const animationToEntity = new Map<string, Entity>();
  for (const entity of entities) {
    for (const animFile of entity.animationFiles) {
      // Load the animation file to get animation identifiers
      const fullPath = path.join(resourcePackPath, animFile);
      const animData = await loadAnimationFile(fullPath);
      if (animData?.animations) {
        for (const animId of Object.keys(animData.animations)) {
          animationToEntity.set(animId, entity);
        }
      }
    }
  }

  // Process each changed animation file
  for (const changedFile of changedAnimationFiles) {
    const headPath = path.join(resourcePackPath, changedFile);
    const basePath = baseResourcePackPath
      ? path.join(baseResourcePackPath, changedFile)
      : null;

    const headAnimations = await loadAnimationFile(headPath);
    const baseAnimations = basePath ? await loadAnimationFile(basePath) : null;

    if (!headAnimations?.animations) continue;

    // Check each animation in the file
    for (const [animId, headAnim] of Object.entries(headAnimations.animations)) {
      const baseAnim = baseAnimations?.animations?.[animId];
      const isNew = !baseAnim;
      const isChanged = areAnimationsDifferent(baseAnim, headAnim);

      if (isNew || isChanged) {
        const entity = animationToEntity.get(animId);
        if (entity) {
          changedAnimations.push({
            entityIdentifier: entity.identifier,
            animationIdentifier: animId,
            animationFile: changedFile,
            isNew,
          });
          core.info(
            `Found ${isNew ? 'new' : 'changed'} animation: ${animId} for entity ${entity.identifier}`
          );
        } else {
          // Animation not associated with a known entity
          core.info(`Found ${isNew ? 'new' : 'changed'} animation: ${animId} (no entity association)`);
        }
      }
    }

    // Check for removed animations (in base but not in head)
    if (baseAnimations?.animations) {
      for (const animId of Object.keys(baseAnimations.animations)) {
        if (!headAnimations.animations[animId]) {
          core.info(`Animation removed: ${animId}`);
        }
      }
    }
  }

  return changedAnimations;
}
