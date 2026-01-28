/**
 * GIF encoder for animation previews
 * Uses omggif (pure JavaScript) for cross-platform GIF encoding
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import { PNG } from 'pngjs';
import GifWriter from 'omggif';

// GIF encoding configuration
export const GIF_CONFIG = {
  width: 400,
  height: 300,
  frameRate: 15, // 15 FPS (reduced from 20 for faster encoding)
  frameDelay: 7, // ~67ms in GIF centiseconds (100ths of a second)
  maxDuration: 2, // Max 2 seconds (reduced from 3)
  quality: 10,
  repeat: 0, // 0 = loop forever
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
 * Decode a PNG buffer to RGBA pixel data
 */
function decodePng(buffer: Buffer): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data),
  };
}

/**
 * Simple color quantization - reduces 24-bit colors to 8-bit palette
 * Uses a basic median cut algorithm
 */
function quantizeFrame(
  rgbaData: Uint8Array,
  width: number,
  height: number
): { indexedPixels: Uint8Array; palette: number[] } {
  // Build a color histogram
  const colorCounts = new Map<number, number>();
  const pixels = width * height;
  
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4;
    // Reduce to 15-bit color for histogram (5 bits per channel)
    const r = rgbaData[offset] >> 3;
    const g = rgbaData[offset + 1] >> 3;
    const b = rgbaData[offset + 2] >> 3;
    const color = (r << 10) | (g << 5) | b;
    colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
  }

  // Get most common colors (up to 256)
  const sortedColors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 256);

  // Build palette (RGB values, 3 bytes per color)
  const palette: number[] = [];
  const colorToIndex = new Map<number, number>();
  
  for (let i = 0; i < sortedColors.length; i++) {
    const [color15bit] = sortedColors[i];
    const r = ((color15bit >> 10) & 0x1f) << 3;
    const g = ((color15bit >> 5) & 0x1f) << 3;
    const b = (color15bit & 0x1f) << 3;
    palette.push(r, g, b);
    colorToIndex.set(color15bit, i);
  }

  // Pad palette to 256 colors if needed
  while (palette.length < 256 * 3) {
    palette.push(0, 0, 0);
  }

  // Map pixels to palette indices
  const indexedPixels = new Uint8Array(pixels);
  
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4;
    const r = rgbaData[offset] >> 3;
    const g = rgbaData[offset + 1] >> 3;
    const b = rgbaData[offset + 2] >> 3;
    const color = (r << 10) | (g << 5) | b;
    
    let index = colorToIndex.get(color);
    if (index === undefined) {
      // Find closest color in palette
      index = findClosestColor(r << 3, g << 3, b << 3, palette);
    }
    indexedPixels[i] = index;
  }

  return { indexedPixels, palette };
}

/**
 * Find the closest color in the palette
 */
function findClosestColor(r: number, g: number, b: number, palette: number[]): number {
  let minDist = Infinity;
  let closestIndex = 0;
  
  for (let i = 0; i < 256; i++) {
    const pr = palette[i * 3];
    const pg = palette[i * 3 + 1];
    const pb = palette[i * 3 + 2];
    const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (dist < minDist) {
      minDist = dist;
      closestIndex = i;
    }
  }
  
  return closestIndex;
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

  if (frames.length === 0) {
    core.warning('No frames provided for GIF creation');
    return false;
  }

  try {
    core.info(`Encoding ${frames.length} frames into GIF (${width}x${height})...`);
    
    // Allocate buffer for GIF (estimate max size)
    const maxSize = width * height * frames.length + 1024 * frames.length;
    const gifBuffer = Buffer.alloc(maxSize);
    
    // Create GIF writer
    const gif = new GifWriter(gifBuffer, width, height, { loop: 0 });
    
    // Process each frame
    for (let i = 0; i < frames.length; i++) {
      try {
        // Decode PNG
        const decoded = decodePng(frames[i]);
        
        // Resize if needed (simple nearest-neighbor)
        let pixelData = decoded.data;
        let srcWidth = decoded.width;
        let srcHeight = decoded.height;
        
        if (srcWidth !== width || srcHeight !== height) {
          pixelData = resizeRgba(decoded.data, srcWidth, srcHeight, width, height);
          srcWidth = width;
          srcHeight = height;
        }
        
        // Quantize to 256 colors
        const { indexedPixels, palette } = quantizeFrame(pixelData, width, height);
        
        // Add frame to GIF
        gif.addFrame(0, 0, width, height, indexedPixels, {
          palette: palette,
          delay: delay,
        });
        
        if ((i + 1) % 10 === 0) {
          core.info(`Encoded frame ${i + 1}/${frames.length}`);
        }
      } catch (frameError) {
        core.warning(`Failed to encode frame ${i}: ${frameError}`);
      }
    }
    
    // Get the actual GIF data
    const gifData = gifBuffer.slice(0, gif.end());
    
    // Write to file
    await fs.writeFile(outputPath, gifData);
    
    core.info(`Created GIF at ${outputPath} (${frames.length} frames, ${gifData.length} bytes)`);
    return true;
  } catch (error) {
    core.warning(`Failed to create GIF: ${error}`);
    return false;
  }
}

/**
 * Simple nearest-neighbor resize for RGBA data
 */
function resizeRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  const dst = new Uint8Array(dstWidth * dstHeight * 4);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.floor(x * xRatio);
      const srcY = Math.floor(y * yRatio);
      const srcOffset = (srcY * srcWidth + srcX) * 4;
      const dstOffset = (y * dstWidth + x) * 4;
      
      dst[dstOffset] = src[srcOffset];
      dst[dstOffset + 1] = src[srcOffset + 1];
      dst[dstOffset + 2] = src[srcOffset + 2];
      dst[dstOffset + 3] = src[srcOffset + 3];
    }
  }
  
  return dst;
}
