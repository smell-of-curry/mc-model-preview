/**
 * Test script for GIF encoding
 * Run with: npx tsc test-gif.ts --esModuleInterop --skipLibCheck && node test-gif.js
 */

import * as fs from 'fs';
import { PNG } from 'pngjs';
import * as omggif from 'omggif';

// Create a simple test PNG buffer
function createTestPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// Test the quantization and GIF encoding
function testGifEncoding() {
  const width = 100;
  const height = 100;
  
  // Create test frames with different colors
  const frames = [
    createTestPng(width, height, 255, 0, 0),   // Red
    createTestPng(width, height, 0, 255, 0),   // Green
    createTestPng(width, height, 0, 0, 255),   // Blue
  ];
  
  console.log('Created test frames');
  
  // Allocate buffer for GIF
  const maxSize = width * height * frames.length * 2 + 10000;
  const gifBuffer = Buffer.alloc(maxSize);
  
  // Create GIF writer without global palette
  const gif = new omggif.GifWriter(gifBuffer, width, height, { loop: 0 });
  
  console.log('Created GIF writer');
  
  // Add each frame with local palette
  for (let i = 0; i < frames.length; i++) {
    const png = PNG.sync.read(frames[i]);
    const indexedPixels = new Uint8Array(width * height);
    
    // Build a simple palette (256 colors as 24-bit integers)
    const palette: number[] = [];
    const colorMap = new Map<number, number>();
    
    // First pass: collect unique colors
    for (let p = 0; p < width * height; p++) {
      const r = png.data[p * 4];
      const g = png.data[p * 4 + 1];
      const b = png.data[p * 4 + 2];
      const rgb = (r << 16) | (g << 8) | b;
      
      if (!colorMap.has(rgb) && palette.length < 256) {
        colorMap.set(rgb, palette.length);
        palette.push(rgb);
      }
    }
    
    // Pad palette to 256 (power of 2)
    while (palette.length < 256) {
      palette.push(0x000000);
    }
    
    console.log(`Frame ${i}: ${colorMap.size} unique colors, palette length: ${palette.length}`);
    
    // Second pass: map pixels to palette indices
    for (let p = 0; p < width * height; p++) {
      const r = png.data[p * 4];
      const g = png.data[p * 4 + 1];
      const b = png.data[p * 4 + 2];
      const rgb = (r << 16) | (g << 8) | b;
      indexedPixels[p] = colorMap.get(rgb) ?? 0;
    }
    
    console.log(`Adding frame ${i}...`);
    
    // Add frame with local palette
    gif.addFrame(0, 0, width, height, indexedPixels, {
      palette: palette,
      delay: 50,
    });
    
    console.log(`Frame ${i} added successfully`);
  }
  
  const gifData = gifBuffer.slice(0, gif.end());
  fs.writeFileSync('test-output.gif', gifData);
  console.log(`GIF created: test-output.gif (${gifData.length} bytes)`);
}

testGifEncoding();
