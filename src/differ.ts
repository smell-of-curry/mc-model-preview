import * as core from '@actions/core';
import * as github from '@actions/github';
import { Entity } from './types';

export async function getChangedFiles(): Promise<string[]> {
  // If we are in a local act test, return a mock list of changed files
  if (process.env.ACT) {
    core.info('Act environment detected, returning mock changed files.');
    return ['test-data/creeper_pack/models/entity/creeper.geo.json'];
  }

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
