import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as io from '@actions/io';
import * as fs from 'fs/promises';
import * as github from '@actions/github';
import { Entity, ChangedAnimation, AnimationFile, RenderState } from './types';
import { createBBFile, hasShinyTexture, TextureVariant } from './blockbench';
import { uploadImagesWithForkSupport, ArtifactMetadata } from './image-hosting';
import { postComment, AnimationUrlSet } from './comment';
import { checkout } from './git';
import { renderBBModelWithThreeJS, renderAnimationFrames, loadTextureAsDataURL } from './threejs-renderer';
import { getAnimationDuration } from './animation-parser';
import { createGifFromFrames, GIF_CONFIG, calculateFrameTimestamps } from './gif-encoder';
import { findChangedAnimations } from './differ';
import { createRenderState, saveRenderStateToFile } from './render-state';

/**
 * Context for incremental rendering
 */
export interface IncrementalContext {
  /** Previous render state (null if first run) */
  previousState: RenderState | null;
  /** Entities that haven't changed since last render */
  unchangedEntities: Entity[];
  /** Whether this is the first run for this PR */
  isFirstRun: boolean;
}

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
  headSha: string,
  incrementalContext?: IncrementalContext
): Promise<void> {
  const toSafeFilename = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  };
  
  core.info('Starting rendering process...');
  
  // Find Chrome/Chromium
  const chromePath = await findChromePath();
  core.info(`Using Chrome at: ${chromePath}`);
  
  // Launch browser once and reuse for all renders
  // WebGL requires specific flags to work in headless mode
  const puppeteer = await getPuppeteer();
  
  // Detect if running on Linux (CI environment)
  const isLinux = process.platform === 'linux';
  
  const webglArgs = isLinux
    ? [
        // Linux CI: Use SwiftShader for software WebGL rendering
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ]
    : [
        // macOS/Windows: Use default ANGLE
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--enable-gpu',
        '--use-angle=default',
      ];
  
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--headless=new',
      ...webglArgs,
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
      // Generate normal variant
      try {
        const bbmodel = await createBBFile(entity, resourcePackPath, 'normal');
        const modelPath = path.join(tempDir, `${entity.identifier}.base.bbmodel`);
        await fs.writeFile(modelPath, JSON.stringify(bbmodel, null, 2));
        core.info(`Generated base bbmodel for ${entity.identifier} at ${modelPath}`);
      } catch (error) {
        core.warning(
          `Skipping ${entity.identifier} (base) due to error creating bbmodel: ${error}`
        );
      }
      
      // Generate shiny variant if available
      if (hasShinyTexture(entity)) {
        try {
          const bbmodel = await createBBFile(entity, resourcePackPath, 'shiny');
          const modelPath = path.join(tempDir, `${entity.identifier}.base.shiny.bbmodel`);
          await fs.writeFile(modelPath, JSON.stringify(bbmodel, null, 2));
          core.info(`Generated base shiny bbmodel for ${entity.identifier} at ${modelPath}`);
        } catch (error) {
          core.warning(
            `Skipping ${entity.identifier} (base shiny) due to error creating bbmodel: ${error}`
          );
        }
      }
    }
    
    // Generate "after" models (checkout back to original HEAD SHA)
    core.info(`Checking out HEAD (${headSha}) to generate head models...`);
    await checkout(headSha);
    for (const entity of prEntities) {
      // Generate normal variant
      try {
        const bbmodel = await createBBFile(entity, resourcePackPath, 'normal');
        const modelPath = path.join(tempDir, `${entity.identifier}.head.bbmodel`);
        await fs.writeFile(modelPath, JSON.stringify(bbmodel, null, 2));
        core.info(`Generated head bbmodel for ${entity.identifier} at ${modelPath}`);
      } catch (error) {
        core.warning(
          `Skipping ${entity.identifier} (head) due to error creating bbmodel: ${error}`
        );
      }
      
      // Generate shiny variant if available
      if (hasShinyTexture(entity)) {
        try {
          const bbmodel = await createBBFile(entity, resourcePackPath, 'shiny');
          const modelPath = path.join(tempDir, `${entity.identifier}.head.shiny.bbmodel`);
          await fs.writeFile(modelPath, JSON.stringify(bbmodel, null, 2));
          core.info(`Generated head shiny bbmodel for ${entity.identifier} at ${modelPath}`);
        } catch (error) {
          core.warning(
            `Skipping ${entity.identifier} (head shiny) due to error creating bbmodel: ${error}`
          );
        }
      }
    }
    
    // Render the models using Three.js
    core.info('Rendering models with Three.js...');
    const filesToRender = await fs.readdir(tempDir);
    
    for (const file of filesToRender) {
      if (file.endsWith('.bbmodel')) {
        const modelPath = path.join(tempDir, file);
        // Handle both normal and shiny patterns:
        // - entity.identifier.base.bbmodel -> entity.identifier.base.png
        // - entity.identifier.base.shiny.bbmodel -> entity.identifier.base.shiny.png
        const identifierPart = file.replace(/\.(head|base)(\.shiny)?\.bbmodel$/, '');
        const variantMatch = file.match(/\.(head|base)(\.shiny)?\.bbmodel$/);
        const branchVariant = variantMatch ? variantMatch[1] : 'render';
        const isShiny = variantMatch && variantMatch[2] === '.shiny';
        const shinySuffix = isShiny ? '.shiny' : '';
        const safeBaseName = `${toSafeFilename(identifierPart)}.${branchVariant}${shinySuffix}.png`;
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
    
    // Render animation GIFs for changed animations
    const animationUrls = await renderChangedAnimations(
      prEntities,
      resourcePackPath,
      tempDir,
      browser
    );
    
    // Build hasShiny map for state tracking
    const hasShinyMap = new Map<string, boolean>();
    for (const entity of prEntities) {
      hasShinyMap.set(entity.identifier, hasShinyTexture(entity));
    }
    
    // Create and save render state for incremental rendering
    const unchangedEntities = incrementalContext?.unchangedEntities ?? [];
    const previousState = incrementalContext?.previousState ?? null;
    
    const newRenderState = await createRenderState(
      prEntities,
      unchangedEntities,
      previousState,
      resourcePackPath,
      headSha,
      hasShinyMap
    );
    await saveRenderStateToFile(newRenderState, tempDir);
    core.info(`Saved render state with ${Object.keys(newRenderState.renderedEntities).length} entities`);
    
    // Build metadata for fork PRs (used by workflow_run to post comment)
    const metadata: ArtifactMetadata = {
      prNumber: github.context.issue.number,
      repo: `${github.context.repo.owner}/${github.context.repo.repo}`,
      headSha,
      affectedEntities: prEntities.map(e => e.identifier),
    };
    
    const uploadResult = await uploadImagesWithForkSupport(tempDir, github.context.issue.number, { metadata, renderState: newRenderState });
    const publicUrls = uploadResult.imageUrls;
    core.info(`Public URL map keys: ${Object.keys(publicUrls).join(', ')}`);
    
    if (uploadResult.isFork) {
      core.info('Fork PR detected - images uploaded as artifact');
      core.info(`Artifact contains metadata for workflow_run to post comment`);
    }
    
    // Track which entities are new (not present on base branch)
    const baseEntityIds = new Set(baseEntities.map(e => e.identifier));
    
    const structuredUrls = prEntities.map((entity) => {
      const safeId = toSafeFilename(entity.identifier);
      
      // Normal variant URLs
      const originalBase = path.join(tempDir, `${entity.identifier}.base.png`);
      const originalHead = path.join(tempDir, `${entity.identifier}.head.png`);
      const safeBase = path.join(tempDir, `${safeId}.base.png`);
      const safeHead = path.join(tempDir, `${safeId}.head.png`);
      
      const baseUrl = publicUrls[originalBase] || publicUrls[safeBase] || '';
      const headUrl = publicUrls[originalHead] || publicUrls[safeHead] || '';
      
      // Shiny variant URLs
      const originalBaseShiny = path.join(tempDir, `${entity.identifier}.base.shiny.png`);
      const originalHeadShiny = path.join(tempDir, `${entity.identifier}.head.shiny.png`);
      const safeBaseShiny = path.join(tempDir, `${safeId}.base.shiny.png`);
      const safeHeadShiny = path.join(tempDir, `${safeId}.head.shiny.png`);
      
      const baseShinyUrl = publicUrls[originalBaseShiny] || publicUrls[safeBaseShiny] || '';
      const headShinyUrl = publicUrls[originalHeadShiny] || publicUrls[safeHeadShiny] || '';
      
      const isNew = !baseEntityIds.has(entity.identifier);
      const entityHasShiny = hasShinyTexture(entity);
      
      core.info(
        `URL mapping for ${entity.identifier}: isNew=${isNew}, hasShiny=${entityHasShiny}, ` +
        `base => ${baseUrl || '[missing]'}, head => ${headUrl || '[missing]'}, ` +
        `baseShiny => ${baseShinyUrl || '[missing]'}, headShiny => ${headShinyUrl || '[missing]'}`
      );
      
      return {
        identifier: entity.identifier,
        base: baseUrl,
        head: headUrl,
        baseShiny: baseShinyUrl,
        headShiny: headShinyUrl,
        isNew,
        hasShiny: entityHasShiny,
      };
    });
    
    // Filter out rows where both normal images are missing (unless fork PR)
    const nonEmptyRows = uploadResult.isFork 
      ? structuredUrls  // Keep all for fork PRs to list affected entities
      : structuredUrls.filter(
          (u) => (u.base && u.base.length > 0) || (u.head && u.head.length > 0)
        );
    
    // Build animation URL sets from rendered GIFs
    core.info(`Looking for animation GIF URLs. Available keys: ${Object.keys(publicUrls).join(', ')}`);
    
    const animationUrlSets: AnimationUrlSet[] = animationUrls.map((anim) => {
      const gifPath = path.join(tempDir, anim.gifFilename);
      const gifUrl = publicUrls[gifPath] || '';
      
      core.info(`Animation GIF lookup: ${anim.gifFilename} -> path: ${gifPath} -> url: ${gifUrl || '[NOT FOUND]'}`);
      
      return {
        entityIdentifier: anim.entityIdentifier,
        animationIdentifier: anim.animationIdentifier,
        gifUrl,
        isNew: anim.isNew,
      };
    }).filter((a) => a.gifUrl.length > 0 || uploadResult.isFork);
    
    core.info(`Animation URL sets after filter: ${JSON.stringify(animationUrlSets)}`);
    
    await postComment(nonEmptyRows, animationUrlSets, {
      isForkPR: uploadResult.isFork,
      artifactName: uploadResult.artifactName,
      affectedEntities: prEntities.map(e => e.identifier),
      isIncremental: !incrementalContext?.isFirstRun && !!incrementalContext?.previousState,
      commitSha: headSha,
    });
    
    core.info('Rendering process complete.');
  } finally {
    // Close the browser
    await browser.close();
  }
}

interface RenderedAnimation {
  entityIdentifier: string;
  animationIdentifier: string;
  gifFilename: string;
  isNew: boolean;
}

/**
 * Render GIFs for changed animations
 */
async function renderChangedAnimations(
  entities: Entity[],
  resourcePackPath: string,
  tempDir: string,
  browser: import('puppeteer-core').Browser
): Promise<RenderedAnimation[]> {
  const renderedAnimations: RenderedAnimation[] = [];
  
  // Build a map of animation identifier to entity and animation data
  const animationMap = new Map<string, {
    entity: Entity;
    animationFile: string;
    animationData: import('./types').BedrockAnimation;
  }>();
  
  for (const entity of entities) {
    for (const animFile of entity.animationFiles) {
      try {
        const animPath = path.join(resourcePackPath, animFile);
        const content = await fs.readFile(animPath, 'utf-8');
        const animFileData = JSON.parse(content) as AnimationFile;
        
        if (animFileData.animations) {
          for (const [animId, animData] of Object.entries(animFileData.animations)) {
            animationMap.set(animId, {
              entity,
              animationFile: animFile,
              animationData: animData,
            });
          }
        }
      } catch (error) {
        core.warning(`Failed to parse animation file ${animFile}: ${error}`);
      }
    }
  }
  
  // Render ALL animations for entities with changed animation files
  for (const entity of entities) {
    if (entity.animationFiles.length === 0) continue;
    
    // Extract entity name from identifier (e.g., "pokemon:ferroseed" -> "ferroseed")
    const entityName = entity.identifier.split(':').pop() || entity.identifier;
    
    // Get all animations that belong to this entity (filter by animation ID pattern)
    const entityAnimations: Array<{ animId: string; animData: import('./types').BedrockAnimation }> = [];
    
    for (const [animId, info] of animationMap) {
      // Only include animations that match this entity's name pattern
      // e.g., "animation.ferroseed.ground_idle" matches entity "ferroseed"
      if (info.entity.identifier === entity.identifier && animId.includes(`.${entityName}.`)) {
        entityAnimations.push({ animId, animData: info.animationData });
      }
    }
    
    core.info(`Found ${entityAnimations.length} animations for ${entity.identifier} (entity name: ${entityName})`);
    
    // Render each animation
    for (const { animId, animData } of entityAnimations) {
      core.info(`Rendering animation ${animId} for ${entity.identifier}`);
      
      try {
        const result = await renderAnimationGif(
          entity,
          animId,
          animData,
          resourcePackPath,
          tempDir,
          browser
        );
        
        if (result) {
          renderedAnimations.push(result);
        }
      } catch (error) {
        core.warning(`Failed to render animation ${animId}: ${error}`);
      }
    }
  }
  
  return renderedAnimations;
}

/**
 * Render a single animation as a GIF
 */
async function renderAnimationGif(
  entity: Entity,
  animationId: string,
  animationData: import('./types').BedrockAnimation,
  resourcePackPath: string,
  tempDir: string,
  browser: import('puppeteer-core').Browser
): Promise<RenderedAnimation | null> {
  if (entity.geometryFiles.length === 0) {
    core.warning(`No geometry files for ${entity.identifier}`);
    return null;
  }
  
  const geometryPath = path.join(resourcePackPath, entity.geometryFiles[0]);
  
  // Find the best texture
  let texturePath: string | null = null;
  const textureKeys = Object.keys(entity.textureMap);
  const preferredKey = textureKeys.find((k) => k === 'default') ||
    textureKeys.find((k) => k === 'male_default') ||
    textureKeys.find((k) => !k.startsWith('shiny_') && k !== 'evo_aura');
  
  if (preferredKey && entity.textureMap[preferredKey]) {
    let txPath = entity.textureMap[preferredKey];
    if (!txPath.endsWith('.png') && !txPath.endsWith('.jpg')) {
      txPath = txPath + '.png';
    }
    texturePath = path.join(resourcePackPath, txPath);
  }
  
  // Calculate frame timestamps
  const duration = getAnimationDuration(animationData);
  const frameTimestamps = calculateFrameTimestamps(duration);
  
  core.info(`Rendering ${frameTimestamps.length} frames for ${animationId} (duration: ${duration}s)`);
  
  // Render frames
  const frames = await renderAnimationFrames(
    geometryPath,
    texturePath,
    animationData,
    frameTimestamps,
    browser,
    { width: GIF_CONFIG.width, height: GIF_CONFIG.height }
  );
  
  if (frames.length === 0) {
    core.warning(`No frames rendered for ${animationId}`);
    return null;
  }
  
  // Create GIF
  const safeAnimId = animationId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const gifFilename = `${safeAnimId}.gif`;
  const gifPath = path.join(tempDir, gifFilename);
  
  const success = await createGifFromFrames(frames, gifPath, {
    width: GIF_CONFIG.width,
    height: GIF_CONFIG.height,
    delay: GIF_CONFIG.frameDelay,
  });
  
  if (!success) {
    core.warning(`Failed to create GIF for ${animationId}`);
    return null;
  }
  
  core.info(`Created animation GIF: ${gifPath}`);
  
  return {
    entityIdentifier: entity.identifier,
    animationIdentifier: animationId,
    gifFilename,
    isNew: false, // TODO: Determine if this is a new animation
  };
}
