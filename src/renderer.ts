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
  const toSafeFilename = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  };
  core.info('Starting rendering process...');

  await setupBlockbench();
  const tempDir = path.join(process.cwd(), 'temp-render');
  await io.mkdirP(tempDir);
  core.info(`Created temporary directory for rendering at ${tempDir}`);

  // Determine Blockbench executable path (prefer extracted AppRun)
  const appImagePath = path.join(process.cwd(), BB_APP_IMAGE);
  const extractedDir = path.join(process.cwd(), BB_EXTRACTED_DIR);
  const extractedAppRunPath = path.join(extractedDir, 'AppRun');
  let bbExecutable = extractedAppRunPath;
  try {
    await fs.access(extractedAppRunPath);
    // Ensure executable bit
    try { await fs.chmod(extractedAppRunPath, 0o755); } catch {}
    core.info(`Using extracted Blockbench executable at ${extractedAppRunPath}`);
  } catch {
    bbExecutable = appImagePath;
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
      const identifierPart = file.replace(/\.(head|base)\.bbmodel$/, '');
      const variantMatch = file.match(/\.(head|base)\.bbmodel$/);
      const variant = variantMatch ? variantMatch[1] : 'render';
      const safeBaseName = `${toSafeFilename(identifierPart)}.${variant}.png`;
      const outputPath = path.join(tempDir, safeBaseName);
      core.info(`About to render: modelPath=${modelPath} -> outputPath=${outputPath}`);
      try {
        // Run under xvfb if available to satisfy Electron's display requirements
        // Precompute if xvfb-run exists
        const tryXvfb = await exec.getExecOutput('which', ['xvfb-run'], { ignoreReturnCode: true });

        // Build common Blockbench args with extra Electron flags to reduce hangs
        const bbArgs = [
          '--headless',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-dev-shm-usage',
          '--disable-features=VizDisplayCompositor',
          `--project=${modelPath}`,
          `--export=${outputPath}`,
          '--render',
        ];

        // If using extracted AppRun, set APPDIR and cwd to extracted root
        const env = { ...process.env, APPDIR: extractedDir, APPIMAGE: appImagePath };
        const options = { cwd: extractedDir, env } as any;

        // Try in this order:
        // 1) xvfb-run + AppRun (preferred)
        // 2) AppRun directly
        // 3) xvfb-run + AppImage --appimage-extract-and-run
        // 4) AppImage --appimage-extract-and-run directly
        let ran = false;
        const killAfterMs = 120000; // 2 minutes per render
        let timeoutHandle: NodeJS.Timeout | undefined;
        async function execWithTimeout(cmd: string, args: string[], opts?: any) {
          return await new Promise<void>((resolve, reject) => {
            let finished = false;
            timeoutHandle = setTimeout(() => {
              if (!finished) {
                finished = true;
                reject(new Error(`Timeout after ${killAfterMs}ms running ${cmd}`));
              }
            }, killAfterMs);
            exec.exec(cmd, args, opts)
              .then(() => {
                if (!finished) {
                  finished = true;
                  if (timeoutHandle) clearTimeout(timeoutHandle);
                  resolve();
                }
              })
              .catch((e) => {
                if (!finished) {
                  finished = true;
                  if (timeoutHandle) clearTimeout(timeoutHandle);
                  reject(e);
                }
              });
          });
        }

        if (bbExecutable === extractedAppRunPath) {
          if (tryXvfb.exitCode === 0) {
            try {
              await execWithTimeout('xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1280x720x24', extractedAppRunPath, ...bbArgs], options);
              ran = true;
            } catch {}
          }
          if (!ran) {
            try {
              await execWithTimeout(extractedAppRunPath, bbArgs, options);
              ran = true;
            } catch {}
          }
        }

        if (!ran) {
          // Fallback to AppImage extract-and-run
          const appImageArgs = ['--appimage-extract-and-run', ...bbArgs];
          if (tryXvfb.exitCode === 0) {
            try {
              await execWithTimeout('xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1280x720x24', appImagePath, ...appImageArgs]);
              ran = true;
            } catch {}
          }
          if (!ran) {
            await execWithTimeout(appImagePath, appImageArgs);
            ran = true;
          }
        }
        core.info(`Rendered ${file} to ${outputPath}`);
      } catch (error) {
        core.warning(`Failed to render ${file}: ${error}`);
      }
    }
  }

  // List files in temp dir for debugging
  try {
    const listAfter = await fs.readdir(tempDir);
    core.info(`Temp dir contents after render: ${JSON.stringify(listAfter)}`);
  } catch {}

  const publicUrls = await uploadImages(tempDir, github.context.issue.number);
  core.info(`Public URL map keys: ${Object.keys(publicUrls).join(', ')}`);

  const structuredUrls = prEntities.map((entity) => {
    const originalBase = path.join(tempDir, `${entity.identifier}.base.png`);
    const originalHead = path.join(tempDir, `${entity.identifier}.head.png`);
    const safeId = toSafeFilename(entity.identifier);
    const safeBase = path.join(tempDir, `${safeId}.base.png`);
    const safeHead = path.join(tempDir, `${safeId}.head.png`);

    const baseUrl = publicUrls[originalBase] || publicUrls[safeBase] || '';
    const headUrl = publicUrls[originalHead] || publicUrls[safeHead] || '';
    core.info(
      `URL mapping for ${entity.identifier}: base(${originalBase} | ${safeBase}) => ${baseUrl || '[missing]'}, head(${originalHead} | ${safeHead}) => ${headUrl || '[missing]'}`
    );

    return {
      identifier: entity.identifier,
      base: baseUrl,
      head: headUrl,
    };
  });

  // Filter out rows where both images are missing to avoid empty <img src="">
  const nonEmptyRows = structuredUrls.filter(
    (u) => (u.base && u.base.length > 0) || (u.head && u.head.length > 0)
  );

  await postComment(nonEmptyRows);

  core.info('Rendering process complete.');
}
