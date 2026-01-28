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

export interface AnimationUrlSet {
  entityIdentifier: string;
  animationIdentifier: string;
  gifUrl: string;
  isNew?: boolean;
}

export interface CommentOptions {
  /** Whether this is a fork PR (images uploaded as artifacts instead of branch) */
  isForkPR?: boolean;
  /** Name of the artifact containing the images */
  artifactName?: string;
  /** List of affected entity identifiers (for fork PR summary) */
  affectedEntities?: string[];
}

export async function postComment(
  imageUrls: ImageUrlSet[],
  animationUrls: AnimationUrlSet[] = [],
  options: CommentOptions = {}
): Promise<void> {
  core.info('Generating PR comment...');

  const { isForkPR, artifactName, affectedEntities } = options;
  
  let body = `## Minecraft Model Preview\n\n`;
  
  // For fork PRs without image URLs, show a helpful message
  if (isForkPR && imageUrls.every(u => !u.base && !u.head)) {
    body += `> **Note:** This pull request is from a fork. Due to GitHub security restrictions, `;
    body += `image previews cannot be automatically posted to this comment.\n\n`;
    
    if (artifactName) {
      body += `📦 **Images are available as a workflow artifact:** \`${artifactName}\`\n\n`;
      body += `You can download the artifact from the [Actions tab](${getWorkflowRunUrl()}) to view the rendered models and animations.\n\n`;
    }
    
    if (affectedEntities && affectedEntities.length > 0) {
      body += `### Affected Entities\n\n`;
      body += `The following entities have model/animation changes in this PR:\n\n`;
      for (const entity of affectedEntities) {
        body += `- \`${entity}\`\n`;
      }
      body += `\n`;
    }
  } else {
    // Normal flow with image URLs
    // Model changes section
    body += `### Model Changes\n\n`;
    body += `| Entity | Before | After |\n`;
    body += `|--------|--------|-------|\n`;

    if (imageUrls.length === 0) {
      body += `| _No renderable model changes detected_ |  |  |\n`;
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

    // Animation previews section
    if (animationUrls.length > 0) {
      body += `\n### Animation Previews\n\n`;
      body += `| Entity | Animation | Preview |\n`;
      body += `|--------|-----------|:-------:|\n`;
      
      for (const animUrl of animationUrls) {
        const newBadge = animUrl.isNew ? ' _(new)_' : '';
        body += `| \`${animUrl.entityIdentifier}\` | \`${animUrl.animationIdentifier}\`${newBadge} | <img src="${animUrl.gifUrl}" width="200" /> |\n`;
      }
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

/**
 * Get the URL to the current workflow run
 */
function getWorkflowRunUrl(): string {
  const { owner, repo } = github.context.repo;
  const runId = github.context.runId;
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
}
