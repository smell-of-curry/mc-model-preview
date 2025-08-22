import * as core from '@actions/core';
import * as github from '@actions/github';

export async function postComment(
  imageUrls: {
    base: string;
    head: string;
    identifier: string;
  }[]
): Promise<void> {
  core.info('Generating PR comment...');

  let body = `### Minecraft Model Preview\n\n`;
  body += `| Entity | Before | After |\n`;
  body += `|--------|--------|-------|\n`;

  if (imageUrls.length === 0) {
    body += `| _No renderable changes detected or images missing_ |  |  |\n`;
  }

  for (const urlSet of imageUrls) {
    body += `| \`${urlSet.identifier}\` | <img src="${urlSet.base}" width="200" /> | <img src="${urlSet.head}" width="200" /> |\n`;
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
