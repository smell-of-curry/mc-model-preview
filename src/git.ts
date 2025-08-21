import * as exec from '@actions/exec';

export async function checkout(ref: string): Promise<void> {
  await exec.exec('git', ['checkout', ref]);
}
