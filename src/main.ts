import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'path';
import { parseResourcePack } from './parser';
import { getChangedFiles, findAffectedEntities } from './differ'; // We'll need to split differ
import { checkout } from './git';
import { renderChanges } from './renderer';
import { Entity } from './types';

async function run(): Promise<void> {
  try {
    core.info('Starting Minecraft Model Preview action...');

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

    // 1. Get changed files & parse head branch
    const changedFiles = await getChangedFiles();
    const headEntities = await parseResourcePack(resourcePackPath);
    const affectedHeadEntities = findAffectedEntities(headEntities, changedFiles);

    if (affectedHeadEntities.length === 0) {
      core.info('No model changes detected in this pull request.');
      return;
    }
    core.info(
      `Found ${
        affectedHeadEntities.length
      } affected entities on HEAD (${headRef}): ${affectedHeadEntities
        .map((e) => e.identifier)
        .join(', ')}`
    );

    // 2. Checkout base branch and parse
    core.info(`Checking out base branch: ${baseRef}`);
    await checkout(baseRef);
    const baseEntities = await parseResourcePack(resourcePackPath);

    // Filter base entities to only include those affected in the PR
    const affectedEntityIds = affectedHeadEntities.map((e) => e.identifier);
    const affectedBaseEntities = baseEntities.filter((e) =>
      affectedEntityIds.includes(e.identifier)
    );

    await renderChanges(
      affectedBaseEntities,
      affectedHeadEntities,
      resourcePackPath
    );

    // 3. Checkout back to head
    core.info(`Checking out head branch: ${headRef}`);
    await checkout(headRef);

    core.info('Action completed successfully.');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

run();
