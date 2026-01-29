import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'path';
import { parseResourcePack } from './parser';
import { getChangedFiles, getChangedFilesSinceCommit, findAffectedEntities } from './differ';
import { checkout, getHeadSha } from './git';
import { renderChanges } from './renderer';
import { runPostMode } from './post-comment';
import { Entity, RenderState, EntityChangeInfo } from './types';
import {
  fetchRenderState,
  determineChangedEntities,
} from './render-state';

type ActionMode = 'render' | 'post';

async function run(): Promise<void> {
  try {
    core.info('Starting Minecraft Model Preview action...');
    
    // Check mode input
    const mode = (core.getInput('mode') || 'render') as ActionMode;
    core.info(`Running in ${mode} mode`);
    
    if (mode === 'post') {
      // Post mode: upload images from artifact and post comment
      const artifactPath = core.getInput('artifact-path');
      if (!artifactPath) {
        core.setFailed('artifact-path input is required for post mode');
        return;
      }
      
      const workspaceDir = process.env['GITHUB_WORKSPACE'] || process.cwd();
      const resolvedArtifactPath = path.isAbsolute(artifactPath)
        ? artifactPath
        : path.resolve(workspaceDir, artifactPath);
      
      await runPostMode({ artifactPath: resolvedArtifactPath });
      core.info('Action completed successfully.');
      process.exit(0);
      return;
    }
    
    // Render mode (default): render models and either post comment or save artifact
    const baseRef = github.context.payload.pull_request?.base.ref;
    const headRef = github.context.payload.pull_request?.head.ref;
    if (!baseRef || !headRef) {
      core.setFailed(
        'Could not get base and head refs from pull request context.'
      );
      return;
    }

    const resourcePackInput = core.getInput('resource-pack-path') || '.';
    const workspaceDir = process.env['GITHUB_WORKSPACE'] || process.cwd();
    let resourcePackPath = path.isAbsolute(resourcePackInput)
      ? resourcePackInput
      : path.resolve(workspaceDir, resourcePackInput);

    const normalizedWorkspace = path.resolve(workspaceDir);
    const isInsideWorkspace =
      resourcePackPath === normalizedWorkspace ||
      (resourcePackPath + path.sep).startsWith(normalizedWorkspace + path.sep);
    if (!isInsideWorkspace) {
      core.warning(
        `Input resource-pack-path resolved outside workspace ("${resourcePackPath}"). Falling back to workspace root ("${normalizedWorkspace}").`
      );
      resourcePackPath = normalizedWorkspace;
    }
    core.info(`Using resource pack path: ${resourcePackPath}`);

    // 1. Get the actual PR head SHA (not the merge commit that Actions creates)
    // The merge commit is ephemeral and doesn't persist between runs
    const prHeadSha = github.context.payload.pull_request?.head?.sha;
    const mergeCommitSha = await getHeadSha();
    const headSha = prHeadSha || mergeCommitSha;
    core.info(`PR head SHA: ${headSha}${prHeadSha ? '' : ' (using merge commit as fallback)'}`);
    core.info(`Merge commit SHA: ${mergeCommitSha}`);

    // 2. Fetch existing render state for incremental rendering
    const prNumber = github.context.issue.number;
    const previousState = await fetchRenderState(prNumber);

    // 3. Get changed files - either since last render or full PR
    let changedFilesSinceLastCommit: string[] = [];
    if (previousState) {
      changedFilesSinceLastCommit = await getChangedFilesSinceCommit(
        previousState.lastProcessedCommit
      );
      core.info(
        `Incremental mode: ${changedFilesSinceLastCommit.length} files changed since last render`
      );
    }

    // 4. Get all changed files in the PR (for initial entity detection)
    const allChangedFiles = await getChangedFiles();
    const headEntities = await parseResourcePack(resourcePackPath);
    const allAffectedEntities = findAffectedEntities(headEntities, allChangedFiles);

    if (allAffectedEntities.length === 0) {
      core.info('No model changes detected in this pull request.');
      return;
    }
    core.info(
      `Found ${allAffectedEntities.length} total affected entities in PR: ${allAffectedEntities
        .map((e) => e.identifier)
        .join(', ')}`
    );

    // 5. Checkout base branch to get base entity list (needed for new entity detection)
    core.info(`Checking out base branch: ${baseRef}`);
    await checkout(baseRef);
    const baseEntities = await parseResourcePack(resourcePackPath);
    const baseEntityIds = new Set(baseEntities.map(e => e.identifier));

    // Checkout back to HEAD to determine changes
    await checkout(headSha);

    // 6. Determine which entities actually need rendering (granular incremental)
    const { entitiesToRender, unchangedEntities, isFirstRun } =
      await determineChangedEntities(
        allAffectedEntities,
        previousState,
        resourcePackPath,
        changedFilesSinceLastCommit,
        baseEntityIds
      );

    if (entitiesToRender.length === 0) {
      core.info('No entities changed since last render - nothing to do.');
      return;
    }
    
    // Log what will be rendered with granular details
    core.info(`Will render ${entitiesToRender.length} entities with the following changes:`);
    for (const changeInfo of entitiesToRender) {
      const parts = [];
      if (changeInfo.renderDefault) parts.push('default model');
      if (changeInfo.renderShiny) parts.push('shiny model');
      if (changeInfo.animationsToRender.length > 0) {
        parts.push(`${changeInfo.animationsToRender.length} animation(s)`);
      }
      core.info(`  ${changeInfo.entity.identifier}: ${parts.join(', ')}`);
    }
    
    if (unchangedEntities.length > 0) {
      core.info(
        `Skipping ${unchangedEntities.length} unchanged entities: ${unchangedEntities
          .map((e) => e.identifier)
          .join(', ')}`
      );
    }

    // 7. Checkout base branch for base model generation
    core.info(`Checking out base branch: ${baseRef}`);
    await checkout(baseRef);

    // 8. Render changes - pass EntityChangeInfo[] with incremental context
    await renderChanges(
      entitiesToRender,
      resourcePackPath,
      baseRef,
      headSha,
      {
        previousState,
        unchangedEntities,
        isFirstRun,
      }
    );

    core.info('Action completed successfully.');
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

run();
