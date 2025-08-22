import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as path from 'path';

const IMAGE_BRANCH = 'mc-model-preview-images';

// Returns a map of local file paths to their public URLs
export async function uploadImages(
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
  const files = await exec.getExecOutput('ls', [imageDir]);
  core.info(`Uploader saw files in ${imageDir}: ${files.stdout}`);

  for (const file of files.stdout.split('\n')) {
    if (file.endsWith('.png')) {
      const localPath = path.join(imageDir, file);
      const publicUrl = `https://raw.githubusercontent.com/${repo}/${commitSha.stdout.trim()}/${prFolder}/${file}`;
      imageUrls[localPath] = publicUrl;
    }
  }

  core.info('Image upload complete.');
  return imageUrls;
}
