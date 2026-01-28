/**
 * Post comment mode - called from workflow_run to post images for fork PRs
 * This runs with write permissions in the base repository context
 */
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ArtifactMetadata } from './image-hosting';
import { postComment, ImageUrlSet, AnimationUrlSet } from './comment';

const IMAGE_BRANCH = 'mc-model-preview-images';

interface PostModeOptions {
  artifactPath: string;
}

/**
 * Run post mode - upload images to branch and post comment
 */
export async function runPostMode(options: PostModeOptions): Promise<void> {
  const { artifactPath } = options;
  
  core.info('Running in post mode - uploading images and posting comment...');
  core.info(`Artifact path: ${artifactPath}`);
  
  // Read metadata.json
  const metadataPath = path.join(artifactPath, 'metadata.json');
  let metadata: ArtifactMetadata;
  
  try {
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    metadata = JSON.parse(metadataContent);
    core.info(`Loaded metadata: PR #${metadata.prNumber} in ${metadata.repo}`);
  } catch (error) {
    core.setFailed(`Failed to read metadata.json: ${error}`);
    return;
  }
  
  // Push images to branch
  const imageUrls = await pushImagesToBranch(artifactPath, metadata);
  
  // Build structured URL sets for the comment
  const { imageUrlSets, animationUrlSets } = buildUrlSets(artifactPath, imageUrls, metadata);
  
  // Post the comment
  await postCommentForPR(imageUrlSets, animationUrlSets, metadata);
  
  core.info('Post mode completed successfully.');
}

/**
 * Push images from artifact to the image branch
 */
async function pushImagesToBranch(
  artifactPath: string,
  metadata: ArtifactMetadata
): Promise<Record<string, string>> {
  core.info('Pushing images to branch...');
  
  const token = core.getInput('github-token');
  const repoUrl = `https://x-access-token:${token}@github.com/${metadata.repo}.git`;
  const commitMsg = `Add images for PR #${metadata.prNumber}`;
  const remoteName = `origin-${IMAGE_BRANCH}`;
  const prFolder = `pr-${metadata.prNumber}`;
  
  // Ensure remote exists
  try {
    await exec.exec('git', ['remote', 'add', remoteName, repoUrl]);
  } catch {
    // Remote might already exist
  }
  await exec.exec('git', ['fetch', remoteName]);
  
  // Check if branch exists
  const lsRemote = await exec.getExecOutput('git', [
    'ls-remote',
    '--heads',
    remoteName,
    IMAGE_BRANCH,
  ]);
  
  if (lsRemote.stdout && lsRemote.stdout.trim().length > 0) {
    await exec.exec('git', ['checkout', '-B', IMAGE_BRANCH, `${remoteName}/${IMAGE_BRANCH}`]);
  } else {
    await exec.exec('git', ['checkout', '--orphan', IMAGE_BRANCH]);
    try {
      await exec.exec('git', ['rm', '-rf', '.']);
    } catch {
      // Might fail if nothing to remove
    }
  }
  
  // Configure git user
  await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
  
  // Copy images to PR folder
  await exec.exec('mkdir', ['-p', prFolder]);
  
  // Copy all image files (not metadata.json)
  const found = await exec.getExecOutput('bash', [
    '-lc',
    `find '${artifactPath}' -type f \\( -name '*.png' -o -name '*.gif' \\) -print0 | xargs -0 -I {} cp {} '${prFolder}/'`,
  ]);
  
  // Stage, commit, and push
  await exec.exec('git', ['add', prFolder]);
  
  // Check if there are changes to commit
  const status = await exec.getExecOutput('git', ['status', '--porcelain']);
  if (!status.stdout.trim()) {
    core.info('No changes to commit - images may already exist');
    // Still build URLs from existing images
  } else {
    await exec.exec('git', ['commit', '-m', commitMsg]);
    await exec.exec('git', ['push', '-u', remoteName, IMAGE_BRANCH]);
  }
  
  // Get the commit SHA for URL building
  const commitSha = await exec.getExecOutput('git', ['rev-parse', 'HEAD']);
  
  // Build URL map
  const imageUrls: Record<string, string> = {};
  const images = await exec.getExecOutput('bash', [
    '-lc',
    `find '${artifactPath}' -type f \\( -name '*.png' -o -name '*.gif' \\) -print | sort`,
  ]);
  
  for (const absPath of images.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
    const filename = path.basename(absPath);
    const publicUrl = `https://raw.githubusercontent.com/${metadata.repo}/${commitSha.stdout.trim()}/${prFolder}/${filename}`;
    imageUrls[absPath] = publicUrl;
    // Also map by filename for easier lookup
    imageUrls[filename] = publicUrl;
  }
  
  core.info(`Built ${Object.keys(imageUrls).length / 2} image URLs`);
  return imageUrls;
}

/**
 * Build structured URL sets from image URLs
 */
function buildUrlSets(
  artifactPath: string,
  imageUrls: Record<string, string>,
  metadata: ArtifactMetadata
): { imageUrlSets: ImageUrlSet[]; animationUrlSets: AnimationUrlSet[] } {
  const imageUrlSets: ImageUrlSet[] = [];
  const animationUrlSets: AnimationUrlSet[] = [];
  
  // Group by entity identifier
  for (const entityId of metadata.affectedEntities) {
    const safeId = entityId.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Look for model images
    const baseUrl = imageUrls[`${safeId}.base.png`] || '';
    const headUrl = imageUrls[`${safeId}.head.png`] || '';
    const baseShinyUrl = imageUrls[`${safeId}.base.shiny.png`] || '';
    const headShinyUrl = imageUrls[`${safeId}.head.shiny.png`] || '';
    
    // Determine if new (no base image)
    const isNew = !baseUrl;
    const hasShiny = !!baseShinyUrl || !!headShinyUrl;
    
    if (headUrl || baseUrl) {
      imageUrlSets.push({
        identifier: entityId,
        base: baseUrl,
        head: headUrl,
        baseShiny: baseShinyUrl,
        headShiny: headShinyUrl,
        isNew,
        hasShiny,
      });
    }
  }
  
  // Look for animation GIFs
  for (const [filename, url] of Object.entries(imageUrls)) {
    if (!filename.endsWith('.gif')) continue;
    
    // Parse animation identifier from filename (e.g., "animation.bewear.ground_idle.gif")
    const match = filename.match(/^(animation\.[^.]+\.[^.]+)\.gif$/);
    if (!match) continue;
    
    const animationId = match[1];
    
    // Find which entity this animation belongs to
    const entityMatch = animationId.match(/^animation\.([^.]+)\./);
    if (!entityMatch) continue;
    
    const entityName = entityMatch[1];
    const entityId = metadata.affectedEntities.find(e => e.endsWith(`:${entityName}`)) || `pokemon:${entityName}`;
    
    animationUrlSets.push({
      entityIdentifier: entityId,
      animationIdentifier: animationId,
      gifUrl: url,
      isNew: false,
    });
  }
  
  core.info(`Built ${imageUrlSets.length} image URL sets and ${animationUrlSets.length} animation URL sets`);
  return { imageUrlSets, animationUrlSets };
}

/**
 * Post the comment to the PR
 */
async function postCommentForPR(
  imageUrlSets: ImageUrlSet[],
  animationUrlSets: AnimationUrlSet[],
  metadata: ArtifactMetadata
): Promise<void> {
  core.info(`Posting comment to PR #${metadata.prNumber}...`);
  
  // We need to override the github context for the comment
  // since we're running in workflow_run context, not PR context
  const token = core.getInput('github-token');
  const octokit = github.getOctokit(token);
  
  // Build the comment body
  let body = `## Minecraft Model Preview\n\n`;
  
  // Model changes section
  body += `### Model Changes\n\n`;
  body += `| Entity | Before | After |\n`;
  body += `|--------|--------|-------|\n`;
  
  if (imageUrlSets.length === 0) {
    body += `| _No renderable model changes detected_ |  |  |\n`;
  }
  
  for (const urlSet of imageUrlSets) {
    const beforeCell = urlSet.isNew || !urlSet.base
      ? '_New model_'
      : `<img src="${urlSet.base}" width="200" />`;
    const afterCell = urlSet.head
      ? `<img src="${urlSet.head}" width="200" />`
      : '_Missing_';
    body += `| \`${urlSet.identifier}\` | ${beforeCell} | ${afterCell} |\n`;
    
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
  if (animationUrlSets.length > 0) {
    body += `\n### Animation Previews\n\n`;
    body += `| Entity | Animation | Preview |\n`;
    body += `|--------|-----------|:-------:|\n`;
    
    for (const animUrl of animationUrlSets) {
      const newBadge = animUrl.isNew ? ' _(new)_' : '';
      body += `| \`${animUrl.entityIdentifier}\` | \`${animUrl.animationIdentifier}\`${newBadge} | <img src="${animUrl.gifUrl}" width="200" /> |\n`;
    }
  }
  
  // Parse repo owner/name from metadata
  const [owner, repo] = metadata.repo.split('/');
  
  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: metadata.prNumber,
      body,
    });
    core.info('PR comment posted successfully.');
  } catch (error) {
    core.warning(`Failed to post PR comment: ${error}`);
    // Write to job summary as fallback
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
