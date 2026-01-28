import * as core from '@actions/core';
import * as github from '@actions/github';

export interface ImageUrlSet {
  base: string;
  head: string;
  baseShiny?: string;
  headShiny?: string;
  identifier: string;
  isNew?: boolean;
  hasShiny?: boolean;
}

export async function postComment(imageUrls: ImageUrlSet[]): Promise<void> {
  core.info('Generating PR comment...');

  let body = `### Minecraft Model Preview\n\n`;
  body += `| Entity | Before | After |\n`;
  body += `|--------|--------|-------|\n`;

  if (imageUrls.length === 0) {
    body += `| _No renderable changes detected or images missing_ |  |  |\n`;
  }

  for (const urlSet of imageUrls) {
    // For new models, show "New" instead of a before image
    const beforeCell = urlSet.isNew || !urlSet.base
      ? '_New model_'
      : `<img src="${urlSet.base}" width="200" />`;
    const afterCell = urlSet.head
      ? `<img src="${urlSet.head}" width="200" />`
      : '_Missing_';
    body += `| \`${urlSet.identifier}\` | ${beforeCell} | ${afterCell} |\n`;
    
    // Add shiny row if the entity has a shiny texture
    if (urlSet.hasShiny && (urlSet.baseShiny || urlSet.headShiny)) {
      const beforeShinyCell = urlSet.isNew || !urlSet.baseShiny
        ? '_New model_'
        : `<img src="${urlSet.baseShiny}" width="200" />`;
      const afterShinyCell = urlSet.headShiny
        ? `<img src="${urlSet.headShiny}" width="200" />`
        : '_Missing_';
      body += `| \`${urlSet.identifier}\` (shiny) | ${beforeShinyCell} | ${afterShinyCell} |\n`;
    }
  }

  const token = core.getInput('github-token');
  const octokit = github.getOctokit(token);

  try {
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: github.context.issue.number,
      body,
    });
    core.info('PR comment posted.');
  } catch (error) {
    core.warning(
      `Failed to post PR comment (likely missing permissions or forked PR). Writing to job summary instead. Error: ${error}`
    );
    try {
      await core.summary
        .addHeading('Minecraft Model Preview')
        .addRaw(body, true)
        .write();
      core.info('Wrote preview to job summary.');
    } catch (summaryError) {
      core.warning(`Failed to write job summary: ${summaryError}`);
    }
  }
}
