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

const BLOCKBENCH_WEB_URL = 'https://web.blockbench.net/';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

/**
 * Render a bbmodel file using Blockbench's web version
 */
async function renderModelWithBlockbenchWeb(
  bbmodelPath: string,
  outputPath: string,
  browser: Browser
): Promise<boolean> {
  let page: Page | null = null;
  
  try {
    // Create a new page for this render
    page = await browser.newPage();
    
    // Set viewport to ensure consistent canvas size
    await page.setViewport({ width: 1280, height: 720 });
    
    // Intercept bundle.js to fix Interface.tab_bar.new_tab issue
    // The web version doesn't have tab_bar initialized, causing errors
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = request.url();
      if (url.includes('bundle.js') && url.includes('blockbench')) {
        try {
          const response = await fetch(url);
          let scriptContent = await response.text();
          
                    // Fix Interface.tab_bar.new_tab access where tab_bar is undefined
          scriptContent = scriptContent.replace(
            /Interface\.tab_bar\.new_tab/g,
            '(Interface.tab_bar?.new_tab ?? {visible:false,selected:false,select:()=>{}})'
          );
          
          // Fix color inheritance where parent might be undefined
          // Pattern: inherit_parent_color.value&&(X.color=Y.color)
          // The Y (parent) might be undefined
          scriptContent = scriptContent.replace(
            /inherit_parent_color\.value\s*&&\s*\((\w+)\.color\s*=\s*(\w+)\.color\)/g,
            'inherit_parent_color?.value&&$2&&($1.color=$2.color)'
          );
          
          // Fix direct parent.color access patterns
          scriptContent = scriptContent.replace(
            /(\w+)\.addTo\((\w+)\)\s*,\s*\1\.color\s*=\s*\2\.color/g,
            '$1.addTo($2),$2&&($1.color=$2.color)'
          );
          
          request.respond({
            status: 200,
            contentType: 'application/javascript',
            body: scriptContent
          });
          core.info('Patched Blockbench bundle.js');
          return;
        } catch (e) {
          core.warning(`Failed to patch bundle: ${e}`);
        }
      }
      request.continue();
    });
    
    core.info('Loading Blockbench web...');
    await page.goto(BLOCKBENCH_WEB_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });
    
    // Wait for Blockbench to fully load
    core.info('Waiting for Blockbench to initialize...');
    await page.waitForFunction(
      () => {
        const win = window as any;
        return typeof win.Blockbench !== 'undefined' && 
               typeof win.Codecs !== 'undefined' &&
               typeof win.Formats !== 'undefined' &&
               typeof win.newProject !== 'undefined';
      },
      { timeout: 30000 }
    );
    
    core.info('Blockbench web loaded successfully');
    
    // Read the bbmodel file content
    const bbmodelContent = await fs.readFile(bbmodelPath, 'utf-8');
    
    // Load the model and render
    core.info('Loading model via Blockbench API...');
    
    const result = await page.evaluate(async (modelJson: string) => {
      try {
        const win = window as any;
        
        // Parse our bbmodel JSON (this is a native Blockbench project format)
        const bbmodel = JSON.parse(modelJson);
        
        // Try to load directly as a bbmodel project file
        // This avoids the complex bedrock codec initialization
        if (win.Codecs?.project?.load) {
          try {
            win.Codecs.project.load(bbmodel, { path: 'model.bbmodel' });
          } catch (projectErr: any) {
            console.warn('project.load failed, trying bedrock codec:', projectErr?.message);
            // Fall back to bedrock codec if project codec fails
            const bedrockGeo = {
              format_version: '1.12.0',
              'minecraft:geometry': [{
                description: {
                  identifier: `geometry.${bbmodel.name || 'model'}`,
                  texture_width: bbmodel.resolution?.width || 16,
                  texture_height: bbmodel.resolution?.height || 16,
                },
                bones: bbmodel.elements || []
              }]
            };
            if (win.Codecs?.bedrock?.load) {
              win.Codecs.bedrock.load(bedrockGeo, { name: 'model.geo.json' });
            }
          }
        } else if (win.Codecs?.bedrock?.load) {
          // Fallback: Build proper Bedrock geometry format
          const bedrockGeo = {
            format_version: '1.12.0',
            'minecraft:geometry': [{
              description: {
                identifier: `geometry.${bbmodel.name || 'model'}`,
                texture_width: bbmodel.resolution?.width || 16,
                texture_height: bbmodel.resolution?.height || 16,
              },
              bones: bbmodel.elements || []
            }]
          };
          win.Codecs.bedrock.load(bedrockGeo, { name: 'model.geo.json' });
        } else {
          return { success: false, error: 'No suitable codec available' };
        }
        
        // Wait for model to load and render
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try to center/fit the model in view
        if (win.Canvas?.center) {
          win.Canvas.center();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Get the preview canvas
        const canvas = document.querySelector('#preview canvas') as HTMLCanvasElement;
        if (!canvas) {
          return { success: false, error: 'Preview canvas not found' };
        }
        
        // Get the image data
        const dataUrl = canvas.toDataURL('image/png');
        
        // Verify we got actual image data
        if (dataUrl.length < 1000) {
          return { success: false, error: `Canvas data too small (${dataUrl.length} chars) - model may not have loaded` };
        }
        
        // Report element count for debugging
        const elementCount = win.Outliner?.elements?.length || 0;
        
        return { success: true, dataUrl, elementCount };
      } catch (e: any) {
        return { success: false, error: e.message || String(e) };
      }
    }, bbmodelContent);
    
    if (result.elementCount !== undefined) {
      core.info(`Loaded ${result.elementCount} elements`);
    }
    
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
    core.warning(`Render error: ${e}`);
    return false;
  } finally {
    // Close the page to clean up
    if (page) {
      await page.close().catch(() => {});
    }
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
    
    // Render the models using Blockbench web
    core.info('Rendering models with Blockbench web...');
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
        
        const success = await renderModelWithBlockbenchWeb(modelPath, outputPath, browser);
        
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
