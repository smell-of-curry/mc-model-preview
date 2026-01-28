/**
 * GIF encoder for animation previews
 * Uses browser-based GIF encoding via Puppeteer for cross-platform compatibility
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import type { Browser, Page } from 'puppeteer-core';

// GIF encoding configuration
export const GIF_CONFIG = {
  width: 400,
  height: 300,
  frameRate: 20, // 20 FPS
  frameDelay: 50, // 50ms between frames (1000ms / 20 FPS)
  maxDuration: 3, // Max 3 seconds
  quality: 10, // GIF quality (1-30, lower is better)
  repeat: 0, // 0 = loop forever, -1 = no repeat
};

/**
 * Calculate the number of frames needed for an animation
 */
export function calculateFrameCount(duration: number): number {
  const cappedDuration = Math.min(duration, GIF_CONFIG.maxDuration);
  return Math.ceil(cappedDuration * GIF_CONFIG.frameRate);
}

/**
 * Calculate the timestamps for each frame
 */
export function calculateFrameTimestamps(duration: number): number[] {
  const frameCount = calculateFrameCount(duration);
  const cappedDuration = Math.min(duration, GIF_CONFIG.maxDuration);
  const timestamps: number[] = [];

  for (let i = 0; i < frameCount; i++) {
    timestamps.push((i / frameCount) * cappedDuration);
  }

  return timestamps;
}

// HTML page for GIF encoding using gif.js
const GIF_ENCODER_HTML = `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js"></script>
</head>
<body>
  <canvas id="canvas" style="display:none;"></canvas>
  <script>
    window.encodeGIF = function(frameDataUrls, width, height, delay) {
      return new Promise((resolve, reject) => {
        const gif = new GIF({
          workers: 2,
          quality: 10,
          width: width,
          height: height,
          workerScript: 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js'
        });
        
        const canvas = document.getElementById('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        let loadedFrames = 0;
        const images = [];
        
        // Load all images first
        for (let i = 0; i < frameDataUrls.length; i++) {
          const img = new Image();
          img.onload = function() {
            images[i] = img;
            loadedFrames++;
            if (loadedFrames === frameDataUrls.length) {
              // All images loaded, add frames to GIF
              for (let j = 0; j < images.length; j++) {
                ctx.fillStyle = '#2d2d2d';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(images[j], 0, 0, width, height);
                gif.addFrame(ctx, { copy: true, delay: delay });
              }
              gif.render();
            }
          };
          img.onerror = function() {
            reject(new Error('Failed to load frame ' + i));
          };
          img.src = frameDataUrls[i];
        }
        
        gif.on('finished', function(blob) {
          const reader = new FileReader();
          reader.onload = function() {
            const base64 = reader.result.split(',')[1];
            resolve(base64);
          };
          reader.onerror = function() {
            reject(new Error('Failed to read GIF blob'));
          };
          reader.readAsDataURL(blob);
        });
        
        gif.on('error', function(err) {
          reject(err);
        });
      });
    };
    
    window.gifEncoderReady = true;
  </script>
</body>
</html>`;

/**
 * Create a GIF from an array of PNG frame buffers using browser-based encoding
 */
export async function createGifFromFrames(
  frames: Buffer[],
  outputPath: string,
  options: { width?: number; height?: number; delay?: number } = {},
  browser?: Browser
): Promise<boolean> {
  const { 
    width = GIF_CONFIG.width, 
    height = GIF_CONFIG.height, 
    delay = GIF_CONFIG.frameDelay 
  } = options;

  if (frames.length === 0) {
    core.warning('No frames provided for GIF creation');
    return false;
  }

  // If no browser provided, we can't encode
  if (!browser) {
    core.warning('No browser provided for GIF encoding');
    return false;
  }

  let page: Page | null = null;

  try {
    // Convert frame buffers to data URLs
    const frameDataUrls = frames.map(buffer => 
      `data:image/png;base64,${buffer.toString('base64')}`
    );

    // Create a new page for GIF encoding
    page = await browser.newPage();
    await page.setContent(GIF_ENCODER_HTML, { waitUntil: 'networkidle0' });
    
    // Wait for gif.js to load
    await page.waitForFunction(() => (window as any).gifEncoderReady === true, { timeout: 30000 });
    
    core.info(`Encoding ${frames.length} frames into GIF...`);
    
    // Encode the GIF
    const base64Gif = await page.evaluate(
      async (dataUrls: string[], w: number, h: number, d: number) => {
        return await (window as any).encodeGIF(dataUrls, w, h, d);
      },
      frameDataUrls,
      width,
      height,
      delay
    );
    
    if (!base64Gif) {
      core.warning('GIF encoding returned empty result');
      return false;
    }
    
    // Write the GIF to file
    const gifBuffer = Buffer.from(base64Gif, 'base64');
    await fs.writeFile(outputPath, gifBuffer);
    
    core.info(`Created GIF at ${outputPath} (${frames.length} frames, ${gifBuffer.length} bytes)`);
    return true;
  } catch (error) {
    core.warning(`Failed to create GIF: ${error}`);
    return false;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}
