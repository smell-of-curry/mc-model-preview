import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as io from '@actions/io';
import * as fs from 'fs/promises';
import * as github from '@actions/github';
import { Entity } from './types';
import { createBBFile } from './blockbench';
import { uploadImages } from './image-hosting';
import { postComment } from './comment';

const BB_VERSION = '4.11.0';
const BB_APP_IMAGE = `Blockbench_${BB_VERSION}.AppImage`;
const BB_EXTRACTED_DIR = 'Blockbench_extracted';

async function setupBlockbench(): Promise<void> {
  core.info('Setting up BlockBench...');
  const scriptPath = path.resolve(__dirname, '../scripts/setup-blockbench.sh');
  await exec.exec('bash', [scriptPath]);
}

export async function renderChanges(
  baseEntities: Entity[],
  prEntities: Entity[],
  resourcePackPath: string
): Promise<void> {
  core.info('Starting rendering process...');

  await setupBlockbench();
  const tempDir = path.join(process.cwd(), 'temp-render');
  await io.mkdirP(tempDir);
  core.info(`Created temporary directory for rendering at ${tempDir}`);

  // Determine Blockbench executable path (AppImage or extracted AppRun fallback)
  const appImagePath = path.join(process.cwd(), BB_APP_IMAGE);
  const extractedAppRunPath = path.join(process.cwd(), BB_EXTRACTED_DIR, 'AppRun');
  let bbExecutable = appImagePath;
  try {
    await fs.access(extractedAppRunPath);
    bbExecutable = extractedAppRunPath;
    // Ensure executable bit
    try { await fs.chmod(bbExecutable, 0o755); } catch {}
    core.info(`Using extracted Blockbench executable at ${bbExecutable}`);
  } catch {
    core.info(`Using AppImage at ${appImagePath}`);
  }

  // Generate "after" models
  for (const entity of prEntities) {
    try {
      const bbmodel = await createBBFile(entity, resourcePackPath);
      const modelPath = path.join(tempDir, `${entity.identifier}.head.bbmodel`);
      await fs.writeFile(modelPath, JSON.stringify(bbmodel, null, 2));
      core.info(`Generated head bbmodel for ${entity.identifier} at ${modelPath}`);
    } catch (error) {
      core.warning(
        `Skipping ${entity.identifier} (head) due to error creating bbmodel: ${error}`
      );
    }
  }

  // Generate "before" models
  for (const entity of baseEntities) {
    try {
      const bbmodel = await createBBFile(entity, resourcePackPath);
      const modelPath = path.join(tempDir, `${entity.identifier}.base.bbmodel`);
      await fs.writeFile(modelPath, JSON.stringify(bbmodel, null, 2));
      core.info(`Generated base bbmodel for ${entity.identifier} at ${modelPath}`);
    } catch (error) {
      core.warning(
        `Skipping ${entity.identifier} (base) due to error creating bbmodel: ${error}`
      );
    }
  }

  // Render the models
  core.info('Rendering models with BlockBench...');
  const filesToRender = await fs.readdir(tempDir);

  for (const file of filesToRender) {
    if (file.endsWith('.bbmodel')) {
      const modelPath = path.join(tempDir, file);
      const outputPath = modelPath.replace('.bbmodel', '.png');
      try {
        await exec.exec(bbExecutable, [
          '--headless',
          `--project=${modelPath}`,
          `--export=${outputPath}`,
          '--render',
        ]);
        core.info(`Rendered ${file} to ${outputPath}`);
      } catch (error) {
        core.warning(`Failed to render ${file}: ${error}`);
      }
    }
  }

  const publicUrls = await uploadImages(tempDir, github.context.issue.number);

  const structuredUrls = prEntities.map((entity) => {
    const basePngPath = path.join(
      tempDir,
      `${entity.identifier}.base.png`
    );
    const headPngPath = path.join(
      tempDir,
      `${entity.identifier}.head.png`
    );

    return {
      identifier: entity.identifier,
      base: publicUrls[basePngPath] || '',
      head: publicUrls[headPngPath] || '',
    };
  });

  await postComment(structuredUrls);

  core.info('Rendering process complete.');
}
