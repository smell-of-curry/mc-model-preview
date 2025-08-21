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
  const repoUrl = `https://github.com/${repo}.git`;
  const commitMsg = `Add images for PR #${prNumber}`;
  const remoteName = `origin-${IMAGE_BRANCH}`;

  await exec.exec('git', ['remote', 'add', remoteName, repoUrl]);
  await exec.exec('git', ['fetch', remoteName]);

  const remoteBranchExists = await exec.exec('git', [
    'ls-remote',
    '--heads',
    remoteName,
    IMAGE_BRANCH,
  ]);
  
  if (remoteBranchExists === 0) {
    await exec.exec('git', ['checkout', '-b', IMAGE_BRANCH, `${remoteName}/${IMAGE_BRANCH}`]);
  } else {
    await exec.exec('git', ['checkout', '--orphan', IMAGE_BRANCH]);
  }

  // Configure git user
  await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec.exec('git', [
    'config',
    'user.email',
    'github-actions[bot]@users.noreply.github.com',
  ]);

  // Copy images to the root of the branch
  await exec.exec('cp', ['-r', `${imageDir}/.`, '.']);
  
  await exec.exec('git', ['add', '.']);
  await exec.exec('git', ['commit', '-m', commitMsg]);
  await exec.exec('git', ['push', '-u', remoteName, IMAGE_BRANCH]);

  const commitSha = await exec.getExecOutput('git', ['rev-parse', 'HEAD']);
  
  const imageUrls: Record<string, string> = {};
  const files = await exec.getExecOutput('ls', [imageDir]);

  for (const file of files.stdout.split('\n')) {
    if (file.endsWith('.png')) {
      const localPath = path.join(imageDir, file);
      const publicUrl = `https://raw.githubusercontent.com/${repo}/${commitSha.stdout.trim()}/${file}`;
      imageUrls[localPath] = publicUrl;
    }
  }

  core.info('Image upload complete.');
  return imageUrls;
}
