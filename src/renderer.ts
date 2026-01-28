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
import { checkout } from './git';
import { renderBBModelWithThreeJS } from './threejs-renderer';

// Dynamic import for puppeteer-core
async function getPuppeteer() {
  return await import('puppeteer-core');
}

/**
 * Find Chrome/Chromium executable on the system
 */
async function findChromePath(): Promise<string> {
  // Common Chrome paths on different systems
  const possiblePaths = [
    // Linux (GitHub Actions runners have Chrome pre-installed)
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  
  for (const p of possiblePaths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // Try next path
    }
  }
  
  // Try using 'which' command
  try {
    const result = await exec.getExecOutput('which', ['google-chrome'], { ignoreReturnCode: true });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {}
  
  try {
    const result = await exec.getExecOutput('which', ['chromium-browser'], { ignoreReturnCode: true });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {}
  
  throw new Error('Chrome/Chromium not found. Please ensure Google Chrome or Chromium is installed.');
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
  
  // Find Chrome/Chromium
  const chromePath = await findChromePath();
  core.info(`Using Chrome at: ${chromePath}`);
  
  // Launch browser once and reuse for all renders
  const puppeteer = await getPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--headless=new',
    ],
  });
  
  core.info('Browser launched');
  
  const tempDir = path.join(process.cwd(), 'temp-render');
  await io.mkdirP(tempDir);
  core.info(`Created temporary directory for rendering at ${tempDir}`);
  
  try {
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
    
    // Render the models using Three.js
    core.info('Rendering models with Three.js...');
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
        
        const success = await renderBBModelWithThreeJS(modelPath, outputPath, browser);
        
        if (success) {
          core.info(`Successfully rendered ${file}`);
        } else {
          core.warning(`Failed to render ${file}`);
        }
      }
    }
    
    // List files in temp dir for debugging
    const listAfter = await fs.readdir(tempDir);
    core.info(`Temp dir contents after render: ${JSON.stringify(listAfter)}`);
    
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
    
    // Filter out rows where both images are missing
    const nonEmptyRows = structuredUrls.filter(
      (u) => (u.base && u.base.length > 0) || (u.head && u.head.length > 0)
    );
    
    await postComment(nonEmptyRows);
    
    core.info('Rendering process complete.');
  } finally {
    // Close the browser
    await browser.close();
  }
}
