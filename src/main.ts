import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'path';
import { parseResourcePack } from './parser';
import { getChangedFiles, getChangedFilesSinceCommit, findAffectedEntities } from './differ';
import { checkout, getHeadSha } from './git';
import { renderChanges } from './renderer';
import { runPostMode } from './post-comment';
import { Entity, RenderState } from './types';
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

    // 1. Store HEAD SHA before any operations (needed for PR merge refs)
    const headSha = await getHeadSha();
    core.info(`Stored HEAD SHA: ${headSha}`);

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

    // 5. Determine which entities actually need rendering (incremental)
    const { entitiesToRender, unchangedEntities, isFirstRun } =
      await determineChangedEntities(
        allAffectedEntities,
        previousState,
        resourcePackPath,
        changedFilesSinceLastCommit
      );

    if (entitiesToRender.length === 0) {
      core.info('No entities changed since last render - nothing to do.');
      return;
    }
    core.info(
      `Will render ${entitiesToRender.length} entities: ${entitiesToRender
        .map((e) => e.identifier)
        .join(', ')}`
    );
    if (unchangedEntities.length > 0) {
      core.info(
        `Skipping ${unchangedEntities.length} unchanged entities: ${unchangedEntities
          .map((e) => e.identifier)
          .join(', ')}`
      );
    }

    // 6. Checkout base branch and parse
    core.info(`Checking out base branch: ${baseRef}`);
    await checkout(baseRef);
    const baseEntities = await parseResourcePack(resourcePackPath);

    // Filter base entities to only include those we're rendering
    const entitiesToRenderIds = entitiesToRender.map((e) => e.identifier);
    const affectedBaseEntities = baseEntities.filter((e) =>
      entitiesToRenderIds.includes(e.identifier)
    );

    // 7. Render changes - pass incremental context
    await renderChanges(
      affectedBaseEntities,
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
