/**
 * GIF encoder for animation previews
 * Uses gif-encoder-2 for reliable GIF generation
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import { createCanvas, loadImage } from 'canvas';
import GIFEncoder from 'gif-encoder-2';

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

/**
 * Create a GIF from an array of PNG frame buffers
 */
export async function createGifFromFrames(
  frames: Buffer[],
  outputPath: string,
  options: { width?: number; height?: number; delay?: number } = {}
): Promise<boolean> {
  const { 
    width = GIF_CONFIG.width, 
    height = GIF_CONFIG.height, 
    delay = GIF_CONFIG.frameDelay 
  } = options;

  try {
    if (frames.length === 0) {
      core.warning('No frames provided for GIF creation');
      return false;
    }

    // Create encoder
    const encoder = new GIFEncoder(width, height, 'neuquant', true);
    
    // Configure encoder
    encoder.setDelay(delay);
    encoder.setRepeat(GIF_CONFIG.repeat);
    encoder.setQuality(GIF_CONFIG.quality);
    
    // Start encoding
    encoder.start();

    // Create a canvas for drawing frames
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Add each frame
    for (let i = 0; i < frames.length; i++) {
      try {
        // Load the PNG buffer as an image
        const img = await loadImage(frames[i]);
        
        // Clear canvas and draw image
        ctx.fillStyle = '#2d2d2d'; // Match the render background
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        
        // Add frame to GIF
        encoder.addFrame(ctx);
      } catch (frameError) {
        core.warning(`Failed to add frame ${i}: ${frameError}`);
      }
    }

    // Finish encoding
    encoder.finish();

    // Get the GIF buffer and write to file
    const gifBuffer = encoder.out.getData();
    await fs.writeFile(outputPath, gifBuffer);
    
    core.info(`Created GIF at ${outputPath} (${frames.length} frames, ${gifBuffer.length} bytes)`);
    return true;
  } catch (error) {
    core.warning(`Failed to create GIF: ${error}`);
    return false;
  }
}
