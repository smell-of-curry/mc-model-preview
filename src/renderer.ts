import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as io from '@actions/io';
import * as fs from 'fs/promises';
import * as github from '@actions/github';
import type { Browser, Page } from 'puppeteer-core';
import { Entity } from './types';
import { createBBFile } from './blockbench';
import { uploadImages } from './image-hosting';
import { postComment } from './comment';
import { checkout } from './git';

// Dynamic import for puppeteer-core
async function getPuppeteer() {
  return await import('puppeteer-core');
}

const BB_VERSION = '4.11.0';
const BB_APP_IMAGE = `Blockbench_${BB_VERSION}.AppImage`;
const BB_EXTRACTED_DIR = 'Blockbench_extracted';
const REMOTE_DEBUG_PORT = 9222;

async function setupBlockbench(): Promise<void> {
  core.info('Setting up BlockBench...');
  const scriptPath = path.resolve(__dirname, '../scripts/setup-blockbench.sh');
  await exec.exec('bash', [scriptPath]);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function renderModelWithPuppeteer(
  bbmodelPath: string,
  outputPath: string,
  extractedDir: string
): Promise<boolean> {
  const appRunPath = path.join(extractedDir, 'AppRun');
  
  // Start Blockbench with remote debugging enabled
  core.info(`Starting Blockbench with remote debugging on port ${REMOTE_DEBUG_PORT}...`);
  
  const env = {
    ...process.env,
    APPDIR: extractedDir,
    LD_LIBRARY_PATH: `${extractedDir}:${extractedDir}/usr/lib:${process.env.LD_LIBRARY_PATH || ''}`,
    DISPLAY: process.env.DISPLAY || ':99',
    ELECTRON_NO_UPDATER: '1',
  };

  // Start xvfb first if not running
  const xvfbCheck = await exec.getExecOutput('pgrep', ['-x', 'Xvfb'], { ignoreReturnCode: true });
  if (xvfbCheck.exitCode !== 0) {
    core.info('Starting Xvfb...');
    exec.exec('Xvfb', [':99', '-screen', '0', '1280x720x24'], { 
      env,
      silent: true,
    }).catch(() => {}); // Run in background
    await sleep(1000);
  }

  // Start Blockbench with remote debugging
  const blockbenchArgs = [
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-component-update',
  ];

  core.info(`Launching Blockbench: ${appRunPath} ${blockbenchArgs.join(' ')}`);
  
  const blockbenchProcess = exec.exec(appRunPath, blockbenchArgs, {
    env,
    cwd: extractedDir,
    silent: true,
  }).catch((e) => {
    core.warning(`Blockbench process error: ${e}`);
  });

  // Wait for Blockbench to start and remote debugging to be available
  core.info('Waiting for Blockbench to start...');
  const puppeteer = await getPuppeteer();
  let browser: Browser | null = null;
  let attempts = 0;
  const maxAttempts = 30;
  
  while (attempts < maxAttempts) {
    try {
      await sleep(2000);
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${REMOTE_DEBUG_PORT}`,
      });
      core.info('Connected to Blockbench via Puppeteer');
      break;
    } catch (e) {
      attempts++;
      if (attempts >= maxAttempts) {
        core.warning(`Failed to connect to Blockbench after ${maxAttempts} attempts`);
        return false;
      }
    }
  }

  if (!browser) {
    return false;
  }

  try {
    // Get the main page (Blockbench window)
    const pages = await browser.pages();
    if (pages.length === 0) {
      core.warning('No pages found in Blockbench');
      return false;
    }
    
    const page = pages[0];
    core.info(`Found ${pages.length} page(s), using first one`);

    // Wait for Blockbench to fully load
    await sleep(3000);

    // Read the bbmodel file content
    const bbmodelContent = await fs.readFile(bbmodelPath, 'utf-8');
    
    // Use Blockbench's API to load the model and render
    core.info('Loading model via Blockbench API...');
    
    // The evaluate callback runs in the browser context where Blockbench globals exist
    const result = await page.evaluate(async (modelJson: string) => {
      try {
        // Access Blockbench globals via window to avoid TypeScript errors
        const win = window as any;
        
        // Wait for Blockbench to be ready
        if (typeof win.Blockbench === 'undefined') {
          return { success: false, error: 'Blockbench not loaded' };
        }

        // Parse and load the model
        const modelData = JSON.parse(modelJson);
        
        // Create a new project
        if (typeof win.newProject === 'function' && win.Formats) {
          win.newProject(win.Formats.bedrock);
        }

        // Try to load the model using Codec
        if (win.Codecs) {
          const codec = win.Codecs.project || win.Codecs.bedrock;
          if (codec && codec.parse) {
            codec.parse(modelData);
          }
        }

        // Wait for render
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Get the preview canvas
        const canvas = document.querySelector('#preview canvas') as HTMLCanvasElement;
        if (!canvas) {
          return { success: false, error: 'Canvas not found' };
        }

        // Get the image data
        const dataUrl = canvas.toDataURL('image/png');
        return { success: true, dataUrl };
      } catch (e: any) {
        return { success: false, error: e.message || String(e) };
      }
    }, bbmodelContent);

    if (!result.success) {
      core.warning(`Blockbench render failed: ${result.error}`);
      return false;
    }

    if (result.dataUrl) {
      // Convert data URL to buffer and save
      const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(outputPath, Buffer.from(base64Data, 'base64'));
      core.info(`Saved render to ${outputPath}`);
      return true;
    }

    return false;
  } catch (e) {
    core.warning(`Puppeteer render error: ${e}`);
    return false;
  } finally {
    // Disconnect (don't close, let the process handle it)
    if (browser) {
      await browser.disconnect();
    }
    // Kill Blockbench
    await exec.exec('pkill', ['-f', 'blockbench'], { ignoreReturnCode: true });
  }
}

export async function renderChanges(
  baseEntities: Entity[],
  prEntities: Entity[],
  resourcePackPath: string,
  baseRef: string,
  headSha: string
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
  const extractedDir = path.join(process.cwd(), BB_EXTRACTED_DIR);
  const extractedAppRunPath = path.join(extractedDir, 'AppRun');
  
  try {
    await fs.access(extractedAppRunPath);
    await fs.chmod(extractedAppRunPath, 0o755);
    core.info(`Using extracted Blockbench executable at ${extractedAppRunPath}`);
  } catch {
    core.warning('Blockbench AppRun not found');
  }

  // Generate "before" models (already on base branch from main.ts)
  core.info(`Generating base models (on ${baseRef})...`);
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

  // Generate "after" models (checkout back to original HEAD SHA)
  core.info(`Checking out HEAD (${headSha}) to generate head models...`);
  await checkout(headSha);
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

  // Render the models using Puppeteer
  core.info('Rendering models with BlockBench via Puppeteer...');
  const filesToRender = await fs.readdir(tempDir);

  for (const file of filesToRender) {
    if (file.endsWith('.bbmodel')) {
      const modelPath = path.join(tempDir, file);
      const identifierPart = file.replace(/\.(head|base)\.bbmodel$/, '');
      const variantMatch = file.match(/\.(head|base)\.bbmodel$/);
      const variant = variantMatch ? variantMatch[1] : 'render';
      const safeBaseName = `${toSafeFilename(identifierPart)}.${variant}.png`;
      const outputPath = path.join(tempDir, safeBaseName);
      
      core.info(`Rendering: ${modelPath} -> ${outputPath}`);
      
      const success = await renderModelWithPuppeteer(modelPath, outputPath, extractedDir);
      
      if (success) {
        core.info(`Successfully rendered ${file}`);
      } else {
        core.warning(`Failed to render ${file}`);
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
