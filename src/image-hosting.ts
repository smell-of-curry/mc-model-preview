import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as artifact from '@actions/artifact';
import * as path from 'path';
import * as fs from 'fs/promises';

const IMAGE_BRANCH = 'mc-model-preview-images';

/**
 * Metadata saved with artifacts for fork PRs
 * Used by the workflow_run workflow to post the comment
 */
export interface ArtifactMetadata {
  prNumber: number;
  repo: string;
  headSha: string;
  affectedEntities: string[];
}

/**
 * Check if the current PR is from a fork
 */
export function isForkPullRequest(): boolean {
  const pr = github.context.payload.pull_request;
  if (!pr) return false;
  
  const baseRepo = pr.base?.repo?.full_name;
  const headRepo = pr.head?.repo?.full_name;
  
  return baseRepo !== headRepo;
}

/**
 * Upload images as GitHub Actions artifact (for fork PRs)
 * Returns the artifact name for reference
 */
async function uploadImagesAsArtifact(
  imageDir: string,
  prNumber: number,
  metadata?: ArtifactMetadata
): Promise<string> {
  core.info('Uploading images as artifact (fork PR detected)...');
  
  const artifactClient = artifact.default;
  const artifactName = `model-preview-pr-${prNumber}`;
  
  // Save metadata.json for the workflow_run workflow to use
  if (metadata) {
    const metadataPath = path.join(imageDir, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    core.info(`Saved metadata to ${metadataPath}`);
  }
  
  // Find all image files and metadata
  const found = await exec.getExecOutput('bash', [
    '-lc',
    `set -o pipefail; find '${imageDir}' -type f \\( -name '*.png' -o -name '*.gif' -o -name '*.bbmodel' -o -name 'metadata.json' \\) -print0 | xargs -0 -I {} echo "{}" | sort | cat`,
  ]);
  
  const files = found.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  
  if (files.length === 0) {
    core.warning('No image files found to upload as artifact');
    return artifactName;
  }
  
  core.info(`Found ${files.length} files to upload as artifact`);
  
  const { id, size } = await artifactClient.uploadArtifact(
    artifactName,
    files,
    imageDir
  );
  
  core.info(`Uploaded artifact '${artifactName}' (ID: ${id}, size: ${size} bytes)`);
  return artifactName;
}

/**
 * Upload images to the orphan branch (for non-fork PRs)
 */
async function uploadImagesToBranch(
  imageDir: string,
  prNumber: number
): Promise<Record<string, string>> {
  core.info('Uploading images to orphan branch...');

  const repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const token = core.getInput('github-token');
  // Use token-authenticated URL for push access
  const repoUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const commitMsg = `Add images for PR #${prNumber}`;
  const remoteName = `origin-${IMAGE_BRANCH}`;

  // Ensure remote exists (ignore if already added)
  try { await exec.exec('git', ['remote', 'add', remoteName, repoUrl]); } catch {}
  await exec.exec('git', ['fetch', remoteName]);

  // Check if branch exists on remote by reading stdout
  const lsRemote = await exec.getExecOutput('git', [
    'ls-remote',
    '--heads',
    remoteName,
    IMAGE_BRANCH,
  ]);

  if (lsRemote.stdout && lsRemote.stdout.trim().length > 0) {
    // Remote branch exists: create local tracking branch
    await exec.exec('git', ['checkout', '-B', IMAGE_BRANCH, `${remoteName}/${IMAGE_BRANCH}`]);
  } else {
    // Create orphan branch for images
    await exec.exec('git', ['checkout', '--orphan', IMAGE_BRANCH]);
    // Remove all files from index/worktree before adding images
    try { await exec.exec('git', ['rm', '-rf', '.']); } catch {}
  }

  // Configure git user
  await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec.exec('git', [
    'config',
    'user.email',
    'github-actions[bot]@users.noreply.github.com',
  ]);

  // Copy images into a dedicated folder per PR to avoid collisions
  const prFolder = `pr-${prNumber}`;
  await exec.exec('mkdir', ['-p', prFolder]);
  await exec.exec('cp', ['-r', `${imageDir}/.`, prFolder]);

  // Only stage the PR folder
  await exec.exec('git', ['add', prFolder]);
  // For debugging, list what we're about to commit
  await exec.exec('bash', ['-lc', `echo 'Files staged for commit:' && git ls-files -s ${prFolder} | cat`]);
  await exec.exec('git', ['commit', '-m', commitMsg]);
  await exec.exec('git', ['push', '-u', remoteName, IMAGE_BRANCH]);

  const commitSha = await exec.getExecOutput('git', ['rev-parse', 'HEAD']);
  
  const imageUrls: Record<string, string> = {};
  // Recursively discover PNGs and GIFs to support nested outputs
  const found = await exec.getExecOutput('bash', [
    '-lc',
    `set -o pipefail; find '${imageDir}' -type f \\( -name '*.png' -o -name '*.gif' \\) -printf '%p\n' | sort | cat`,
  ]);
  core.info(`Uploader discovered images under ${imageDir}:\n${found.stdout}`);

  for (const absPath of found.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const relPath = path.relative(imageDir, absPath).replace(/\\/g, '/');
    const publicUrl = `https://raw.githubusercontent.com/${repo}/${commitSha.stdout.trim()}/${prFolder}/${relPath}`;
    imageUrls[absPath] = publicUrl;
  }

  core.info('Image upload complete.');
  return imageUrls;
}

export interface UploadResult {
  /** Map of local file paths to public URLs (empty for fork PRs) */
  imageUrls: Record<string, string>;
  /** Whether this PR is from a fork */
  isFork: boolean;
  /** Artifact name if uploaded as artifact */
  artifactName?: string;
}

export interface UploadOptions {
  /** Metadata to save with the artifact (for workflow_run to use) */
  metadata?: ArtifactMetadata;
}

// Returns a map of local file paths to their public URLs
export async function uploadImages(
  imageDir: string,
  prNumber: number
): Promise<Record<string, string>> {
  const result = await uploadImagesWithForkSupport(imageDir, prNumber);
  return result.imageUrls;
}

/**
 * Upload images with full fork PR support
 * For non-fork PRs: uploads to branch and returns URLs
 * For fork PRs: uploads as artifact and returns empty URLs
 */
export async function uploadImagesWithForkSupport(
  imageDir: string,
  prNumber: number,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const isFork = isForkPullRequest();
  const { metadata } = options;
  
  if (isFork) {
    core.info('Fork PR detected - image upload to branch will be skipped');
    core.info('Images will be uploaded as workflow artifact instead');
    
    const artifactName = await uploadImagesAsArtifact(imageDir, prNumber, metadata);
    
    return {
      imageUrls: {},
      isFork: true,
      artifactName,
    };
  }
  
  // Non-fork PR: upload to branch as usual
  try {
    const imageUrls = await uploadImagesToBranch(imageDir, prNumber);
    return {
      imageUrls,
      isFork: false,
    };
  } catch (error) {
    // If branch upload fails (e.g., unexpected permissions issue), fall back to artifact
    core.warning(`Failed to upload images to branch: ${error}`);
    core.info('Falling back to artifact upload...');
    
    const artifactName = await uploadImagesAsArtifact(imageDir, prNumber, metadata);
    
    return {
      imageUrls: {},
      isFork: false,
      artifactName,
    };
  }
}
