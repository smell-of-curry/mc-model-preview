import * as exec from '@actions/exec';

export async function checkout(ref: string): Promise<void> {
  // Try a straightforward checkout first
  const result = await exec.getExecOutput('git', ['checkout', ref], {
    silent: true,
    ignoreReturnCode: true,
  });
  if (result.exitCode === 0) return;

  // If ambiguous (multiple remotes), prefer origin explicitly
  // Attempt: git checkout -B <ref> --track origin/<ref>
  let tracked = await exec.getExecOutput(
    'git',
    ['checkout', '-B', ref, `--track`, `origin/${ref}`],
    { silent: true, ignoreReturnCode: true }
  );
  if (tracked.exitCode === 0) return;

  // Fallback: set default remote to origin and retry plain checkout
  await exec.exec('git', ['config', 'checkout.defaultRemote', 'origin']);
  await exec.exec('git', ['fetch', 'origin']);
  await exec.exec('git', ['checkout', ref]);
}
