import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as artifact from '@actions/artifact';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RenderState } from './types';

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
  
  // Find all image files, metadata, and render state (exclude .bbmodel - they contain colons which are invalid for artifacts)
  const found = await exec.getExecOutput('bash', [
    '-lc',
    `set -o pipefail; find '${imageDir}' -type f \\( -name '*.png' -o -name '*.gif' -o -name 'metadata.json' -o -name 'render-state.json' \\) -print0 | xargs -0 -I {} echo "{}" | sort | cat`,
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
 * Preserves existing images for incremental rendering
 */
async function uploadImagesToBranch(
  imageDir: string,
  prNumber: number
): Promise<Record<string, string>> {
  core.info('Uploading images to orphan branch (incremental mode)...');

  const repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const token = core.getInput('github-token');
  // Use token-authenticated URL for push access
  const repoUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const commitMsg = `Update images for PR #${prNumber}`;
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

  const prFolder = `pr-${prNumber}`;
  
  if (lsRemote.stdout && lsRemote.stdout.trim().length > 0) {
    // Remote branch exists: create local tracking branch
    await exec.exec('git', ['checkout', '-B', IMAGE_BRANCH, `${remoteName}/${IMAGE_BRANCH}`]);
    core.info(`Checked out existing ${IMAGE_BRANCH} branch - preserving existing images`);
  } else {
    // Create orphan branch for images
    await exec.exec('git', ['checkout', '--orphan', IMAGE_BRANCH]);
    // Remove all files from index/worktree before adding images
    try { await exec.exec('git', ['rm', '-rf', '.']); } catch {}
    core.info(`Created new orphan branch ${IMAGE_BRANCH}`);
  }

  // Configure git user
  await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec.exec('git', [
    'config',
    'user.email',
    'github-actions[bot]@users.noreply.github.com',
  ]);

  // Ensure PR folder exists (preserves existing files)
  await exec.exec('mkdir', ['-p', prFolder]);
  
  // Copy new/updated images into the PR folder (preserves existing files)
  // Using cp without -r on individual files to merge rather than replace
  const newFiles = await exec.getExecOutput('bash', [
    '-c',
    `find "${imageDir}" -type f \\( -name "*.png" -o -name "*.gif" -o -name "render-state.json" \\)`,
  ]);
  
  const filesToCopy = newFiles.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  core.info(`Copying ${filesToCopy.length} new/updated files to ${prFolder}`);
  core.info(`Files to copy: ${filesToCopy.join(', ')}`);
  
  for (const file of filesToCopy) {
    const filename = path.basename(file);
    await exec.exec('cp', [file, `${prFolder}/${filename}`]);
  }

  // Only stage the PR folder
  await exec.exec('git', ['add', prFolder]);
  
  // Check if there are changes to commit
  const status = await exec.getExecOutput('git', ['status', '--porcelain']);
  if (!status.stdout.trim()) {
    core.info('No changes to commit - images may be identical to previous render');
    // Still need to get commit SHA for URL building
  } else {
    // For debugging, list what we're about to commit
    await exec.exec('bash', ['-lc', `echo 'Files staged for commit:' && git diff --cached --name-only | cat`]);
    await exec.exec('git', ['commit', '-m', commitMsg]);
    await exec.exec('git', ['push', '-u', remoteName, IMAGE_BRANCH]);
  }

  const commitSha = await exec.getExecOutput('git', ['rev-parse', 'HEAD']);
  
  // Build URLs for ALL images in the PR folder (including previously uploaded ones)
  const imageUrls: Record<string, string> = {};
  
  // Get all images from the PR folder on the branch (not just newly uploaded)
  const allPrImages = await exec.getExecOutput('bash', [
    '-lc',
    `find '${prFolder}' -type f \\( -name '*.png' -o -name '*.gif' \\) -print | sort`,
  ]);
  
  for (const branchPath of allPrImages.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
    const filename = path.basename(branchPath);
    const localPath = path.join(imageDir, filename);
    const publicUrl = `https://raw.githubusercontent.com/${repo}/${commitSha.stdout.trim()}/${branchPath}`;
    // Map both the local path (for newly rendered) and branch path
    imageUrls[localPath] = publicUrl;
    imageUrls[branchPath] = publicUrl;
  }
  
  core.info(`Built URLs for ${Object.keys(imageUrls).length / 2} images (including existing)`);
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
  /** Render state to save alongside images (for incremental rendering) */
  renderState?: RenderState;
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
