/**
 * GIF encoder for animation previews
 * Combines rendered frames into an animated GIF
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import * as path from 'path';

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
 * GIF encoder script that runs in the browser context
 * Uses gif.js library for encoding
 */
export const GIF_ENCODER_SCRIPT = `
// gif.js worker code will be inlined
const GIF_WORKER_CODE = \`
var GifWriter=function(){function e(e,r,t,n){var i=e.length,o=new a(256);var f;o.add(r),o.add(t);var v=8,d=1<<(v-1),l=d<<1,p=t+1,c=r,u=0,h=0;function s(e){for(u|=e<<h,h+=v;h>=8;)i[f++]=u&255,u>>=8,h-=8;return h>0}f=n,s(v-1);e:for(var g=0;g<i.length;++g){var w=e[g]&255,y=c<<8|w,b=o.get(y);if(b===-1){if(s(c),p===l+1&&v===12){s(r);for(var x=o.g,k=o.c,S=0,m=x.length;S<m;++S)x[S]=0;o.c=k=0;v=9;l=1<<(v-1);p=t+1}else{if(p===l+1){v++;l=1<<(v-1)}}o.add(y);c=w}else{c=b}}s(c);s(t);if(h>0){i[f++]=u}return f}function a(e){var r=this.g=[];var t=this.c=0;this.add=function(e){r[e]=++t};this.get=function(e){return r[e]||(-1)}}return e}();
var frames=null,frame=0,width=0,height=0,delay=0,repeat=0,bgColor=null,quality=10,dither=false,palette=null;
var outputBuffer=[];

self.onmessage=function(e){
  var d=e.data;
  if(d.cmd==='init'){
    width=d.width;height=d.height;delay=d.delay;repeat=d.repeat;
    quality=d.quality||10;dither=d.dither||false;
    palette=d.palette||null;bgColor=d.bgColor||null;
    outputBuffer=[];frame=0;frames=[];
    // Write GIF header
    outputBuffer.push(0x47,0x49,0x46,0x38,0x39,0x61);// GIF89a
    outputBuffer.push(width&255,width>>8,height&255,height>>8);
    outputBuffer.push(0xf7,0,0);// Global color table
    // Write placeholder global color table (256 colors)
    for(var i=0;i<256*3;i++)outputBuffer.push(0);
    // Write NETSCAPE extension for looping
    if(repeat>=0){
      outputBuffer.push(0x21,0xff,0x0b);
      outputBuffer.push(0x4e,0x45,0x54,0x53,0x43,0x41,0x50,0x45,0x32,0x2e,0x30);
      outputBuffer.push(0x03,0x01);
      outputBuffer.push(repeat&255,repeat>>8);
      outputBuffer.push(0x00);
    }
  }else if(d.cmd==='frame'){
    frames.push(d.data);
  }else if(d.cmd==='finish'){
    processFrames();
  }
};

function processFrames(){
  // Build color palette from all frames using median cut
  var colorCounts={};
  for(var f=0;f<frames.length;f++){
    var data=frames[f];
    for(var i=0;i<data.length;i+=4){
      if(data[i+3]<128)continue;// Skip transparent
      var c=(data[i]<<16)|(data[i+1]<<8)|data[i+2];
      colorCounts[c]=(colorCounts[c]||0)+1;
    }
  }
  
  // Get top 255 colors (reserve one for transparent)
  var colors=Object.keys(colorCounts).map(function(c){return parseInt(c)});
  colors.sort(function(a,b){return colorCounts[b]-colorCounts[a]});
  colors=colors.slice(0,255);
  
  // Build palette lookup
  var paletteMap={};
  var paletteData=new Uint8Array(256*3);
  for(var i=0;i<colors.length;i++){
    var c=colors[i];
    paletteMap[c]=i;
    paletteData[i*3]=(c>>16)&255;
    paletteData[i*3+1]=(c>>8)&255;
    paletteData[i*3+2]=c&255;
  }
  var transparentIndex=255;
  
  // Update global color table in header
  for(var i=0;i<256*3;i++){
    outputBuffer[13+i]=paletteData[i];
  }
  
  // Process each frame
  for(var f=0;f<frames.length;f++){
    var data=frames[f];
    var indexedFrame=new Uint8Array(width*height);
    var hasTransparent=false;
    
    for(var i=0;i<width*height;i++){
      var pi=i*4;
      if(data[pi+3]<128){
        indexedFrame[i]=transparentIndex;
        hasTransparent=true;
      }else{
        var c=(data[pi]<<16)|(data[pi+1]<<8)|data[pi+2];
        indexedFrame[i]=paletteMap[c]!==undefined?paletteMap[c]:findClosestColor(c,colors,paletteMap);
      }
    }
    
    // Write Graphic Control Extension
    outputBuffer.push(0x21,0xf9,0x04);
    outputBuffer.push(hasTransparent?0x09:0x08);// Disposal + transparent flag
    outputBuffer.push(delay&255,delay>>8);
    outputBuffer.push(hasTransparent?transparentIndex:0);
    outputBuffer.push(0x00);
    
    // Write Image Descriptor
    outputBuffer.push(0x2c);
    outputBuffer.push(0,0,0,0);// Left, Top
    outputBuffer.push(width&255,width>>8,height&255,height>>8);
    outputBuffer.push(0x00);// No local color table
    
    // LZW encode frame
    var minCodeSize=8;
    outputBuffer.push(minCodeSize);
    
    var encoded=[];
    var clearCode=1<<minCodeSize;
    var endCode=clearCode+1;
    var codeSize=minCodeSize+1;
    var nextCode=endCode+1;
    var codeTable={};
    var maxCode=4096;
    
    encoded.push(clearCode);
    var current=indexedFrame[0];
    
    for(var i=1;i<indexedFrame.length;i++){
      var next=indexedFrame[i];
      var key=(current<<8)|next;
      if(codeTable[key]!==undefined){
        current=codeTable[key];
      }else{
        encoded.push(current);
        if(nextCode<maxCode){
          codeTable[key]=nextCode++;
          if(nextCode>(1<<codeSize)&&codeSize<12){
            codeSize++;
          }
        }else{
          encoded.push(clearCode);
          codeTable={};
          codeSize=minCodeSize+1;
          nextCode=endCode+1;
        }
        current=next;
      }
    }
    encoded.push(current);
    encoded.push(endCode);
    
    // Pack codes into bytes
    var bits=0,buf=0,pos=0;
    var subBlock=[];
    codeSize=minCodeSize+1;
    nextCode=endCode+1;
    
    for(var i=0;i<encoded.length;i++){
      if(encoded[i]===clearCode&&i>0){
        codeSize=minCodeSize+1;
        nextCode=endCode+1;
      }
      buf|=encoded[i]<<bits;
      bits+=codeSize;
      while(bits>=8){
        subBlock.push(buf&255);
        buf>>=8;
        bits-=8;
        if(subBlock.length===255){
          outputBuffer.push(255);
          for(var j=0;j<255;j++)outputBuffer.push(subBlock[j]);
          subBlock=[];
        }
      }
      if(encoded[i]!==clearCode&&encoded[i]!==endCode){
        nextCode++;
        if(nextCode>(1<<codeSize)&&codeSize<12)codeSize++;
      }
    }
    if(bits>0)subBlock.push(buf&255);
    if(subBlock.length>0){
      outputBuffer.push(subBlock.length);
      for(var j=0;j<subBlock.length;j++)outputBuffer.push(subBlock[j]);
    }
    outputBuffer.push(0x00);// Block terminator
  }
  
  // Write GIF trailer
  outputBuffer.push(0x3b);
  
  self.postMessage({done:true,data:new Uint8Array(outputBuffer)});
}

function findClosestColor(c,colors,paletteMap){
  var r1=(c>>16)&255,g1=(c>>8)&255,b1=c&255;
  var best=0,bestDist=Infinity;
  for(var i=0;i<colors.length;i++){
    var c2=colors[i];
    var r2=(c2>>16)&255,g2=(c2>>8)&255,b2=c2&255;
    var dist=(r1-r2)*(r1-r2)+(g1-g2)*(g1-g2)+(b1-b2)*(b1-b2);
    if(dist<bestDist){bestDist=dist;best=i;}
  }
  paletteMap[c]=best;
  return best;
}
\`;

// Create the GIF encoder
class GifEncoder {
  constructor(width, height, options = {}) {
    this.width = width;
    this.height = height;
    this.delay = options.delay || 50;
    this.repeat = options.repeat !== undefined ? options.repeat : 0;
    this.quality = options.quality || 10;
    this.frames = [];
  }
  
  addFrame(imageData) {
    // imageData should be Uint8ClampedArray of RGBA data
    this.frames.push(new Uint8Array(imageData));
  }
  
  async finish() {
    return new Promise((resolve, reject) => {
      const blob = new Blob([GIF_WORKER_CODE], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      
      worker.onmessage = (e) => {
        if (e.data.done) {
          URL.revokeObjectURL(workerUrl);
          worker.terminate();
          resolve(e.data.data);
        }
      };
      
      worker.onerror = (err) => {
        URL.revokeObjectURL(workerUrl);
        worker.terminate();
        reject(err);
      };
      
      // Initialize
      worker.postMessage({
        cmd: 'init',
        width: this.width,
        height: this.height,
        delay: Math.round(this.delay / 10), // GIF delay is in 1/100ths of a second
        repeat: this.repeat,
        quality: this.quality
      });
      
      // Send frames
      for (const frame of this.frames) {
        worker.postMessage({ cmd: 'frame', data: frame });
      }
      
      // Finish encoding
      worker.postMessage({ cmd: 'finish' });
    });
  }
}

window.GifEncoder = GifEncoder;
`;

/**
 * Create a GIF from an array of PNG frame data URLs
 * This function is meant to be called from the Node.js context
 * and uses the browser to do the actual encoding
 */
export async function createGifFromFrames(
  frames: Buffer[],
  outputPath: string,
  options: { width: number; height: number; delay: number } = {
    width: GIF_CONFIG.width,
    height: GIF_CONFIG.height,
    delay: GIF_CONFIG.frameDelay,
  }
): Promise<boolean> {
  try {
    // For now, we'll use a simpler approach: write frames and use an external tool
    // or implement GIF encoding directly in Node.js

    // Since we need this to work in GitHub Actions without additional tools,
    // let's implement a basic GIF encoder in Node.js
    const gifData = await encodeGifNodeJS(frames, options);
    await fs.writeFile(outputPath, gifData);
    core.info(`Created GIF at ${outputPath}`);
    return true;
  } catch (error) {
    core.warning(`Failed to create GIF: ${error}`);
    return false;
  }
}

/**
 * Simple GIF encoder for Node.js
 * Encodes PNG frames into an animated GIF
 */
async function encodeGifNodeJS(
  frames: Buffer[],
  options: { width: number; height: number; delay: number }
): Promise<Buffer> {
  const { width, height, delay } = options;
  const delayCs = Math.round(delay / 10); // Convert ms to centiseconds

  // GIF header
  const header = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0xf7, // Global color table flag, color resolution, sorted, size (256 colors)
    0x00, // Background color index
    0x00, // Pixel aspect ratio
  ]);

  // Collect all unique colors from all frames
  const allPixels: Array<{ r: number; g: number; b: number; a: number }[]> = [];

  for (const frame of frames) {
    const pixels = await decodePngToPixels(frame, width, height);
    allPixels.push(pixels);
  }

  // Build global color palette (256 colors max, reserve one for transparent)
  const colorCounts = new Map<number, number>();
  for (const pixels of allPixels) {
    for (const pixel of pixels) {
      if (pixel.a < 128) continue; // Skip transparent
      const key = (pixel.r << 16) | (pixel.g << 8) | pixel.b;
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }
  }

  // Get top 255 colors
  const sortedColors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 255)
    .map(([color]) => color);

  // Build palette lookup
  const paletteMap = new Map<number, number>();
  const paletteData = Buffer.alloc(256 * 3);

  for (let i = 0; i < sortedColors.length; i++) {
    const color = sortedColors[i];
    paletteMap.set(color, i);
    paletteData[i * 3] = (color >> 16) & 0xff;
    paletteData[i * 3 + 1] = (color >> 8) & 0xff;
    paletteData[i * 3 + 2] = color & 0xff;
  }

  const transparentIndex = 255;

  // NETSCAPE extension for looping
  const netscapeExt = Buffer.from([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, // NETSCAPE2.0
    0x03, 0x01,
    0x00, 0x00, // Loop count (0 = infinite)
    0x00,
  ]);

  // Encode each frame
  const frameBuffers: Buffer[] = [];

  for (const pixels of allPixels) {
    // Index the frame
    const indexed = new Uint8Array(width * height);
    let hasTransparent = false;

    for (let i = 0; i < pixels.length; i++) {
      const pixel = pixels[i];
      if (pixel.a < 128) {
        indexed[i] = transparentIndex;
        hasTransparent = true;
      } else {
        const key = (pixel.r << 16) | (pixel.g << 8) | pixel.b;
        indexed[i] = paletteMap.get(key) ?? findClosestColorIndex(pixel, sortedColors);
      }
    }

    // Graphic Control Extension
    const gce = Buffer.from([
      0x21, 0xf9, 0x04,
      hasTransparent ? 0x09 : 0x08, // Disposal method + transparent flag
      delayCs & 0xff, (delayCs >> 8) & 0xff,
      hasTransparent ? transparentIndex : 0,
      0x00,
    ]);

    // Image Descriptor
    const imageDesc = Buffer.from([
      0x2c,
      0x00, 0x00, 0x00, 0x00, // Left, Top
      width & 0xff, (width >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
      0x00, // No local color table
    ]);

    // LZW encode the indexed data
    const lzwData = lzwEncode(indexed, 8);

    frameBuffers.push(Buffer.concat([gce, imageDesc, lzwData]));
  }

  // GIF trailer
  const trailer = Buffer.from([0x3b]);

  return Buffer.concat([header, paletteData, netscapeExt, ...frameBuffers, trailer]);
}

/**
 * Find the closest color in the palette
 */
function findClosestColorIndex(
  pixel: { r: number; g: number; b: number },
  palette: number[]
): number {
  let bestIndex = 0;
  let bestDist = Infinity;

  for (let i = 0; i < palette.length; i++) {
    const color = palette[i];
    const r2 = (color >> 16) & 0xff;
    const g2 = (color >> 8) & 0xff;
    const b2 = color & 0xff;

    const dist =
      (pixel.r - r2) ** 2 + (pixel.g - g2) ** 2 + (pixel.b - b2) ** 2;

    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/**
 * LZW encode data for GIF
 */
function lzwEncode(data: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const output: number[] = [minCodeSize];
  const codes: number[] = [];

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const maxCode = 4096;
  const codeTable = new Map<string, number>();

  // Initialize code table with single-character codes
  for (let i = 0; i < clearCode; i++) {
    codeTable.set(String(i), i);
  }

  codes.push(clearCode);

  let current = String(data[0]);

  for (let i = 1; i < data.length; i++) {
    const next = String(data[i]);
    const combined = current + ',' + next;

    if (codeTable.has(combined)) {
      current = combined;
    } else {
      codes.push(codeTable.get(current)!);

      if (nextCode < maxCode) {
        codeTable.set(combined, nextCode++);
        if (nextCode > 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
      } else {
        // Reset code table
        codes.push(clearCode);
        codeTable.clear();
        for (let j = 0; j < clearCode; j++) {
          codeTable.set(String(j), j);
        }
        codeSize = minCodeSize + 1;
        nextCode = endCode + 1;
      }

      current = next;
    }
  }

  codes.push(codeTable.get(current)!);
  codes.push(endCode);

  // Pack codes into bytes
  let bits = 0;
  let buf = 0;
  const subBlocks: number[] = [];
  let currentBlock: number[] = [];

  codeSize = minCodeSize + 1;
  nextCode = endCode + 1;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];

    if (code === clearCode && i > 0) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
    }

    buf |= code << bits;
    bits += codeSize;

    while (bits >= 8) {
      currentBlock.push(buf & 0xff);
      buf >>= 8;
      bits -= 8;

      if (currentBlock.length === 255) {
        subBlocks.push(255, ...currentBlock);
        currentBlock = [];
      }
    }

    if (code !== clearCode && code !== endCode) {
      nextCode++;
      if (nextCode > 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    }
  }

  if (bits > 0) {
    currentBlock.push(buf & 0xff);
  }

  if (currentBlock.length > 0) {
    subBlocks.push(currentBlock.length, ...currentBlock);
  }

  subBlocks.push(0); // Block terminator

  output.push(...subBlocks);

  return Buffer.from(output);
}

/**
 * Decode a PNG buffer to raw pixel data
 * Simple PNG decoder for RGBA data
 */
async function decodePngToPixels(
  pngBuffer: Buffer,
  expectedWidth: number,
  expectedHeight: number
): Promise<Array<{ r: number; g: number; b: number; a: number }>> {
  // Check PNG signature
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (pngBuffer[i] !== signature[i]) {
      throw new Error('Invalid PNG signature');
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  // Parse chunks
  while (offset < pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.slice(offset + 4, offset + 8).toString('ascii');
    const data = pngBuffer.slice(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length; // length + type + data + crc
  }

  // Decompress IDAT data
  const compressedData = Buffer.concat(idatChunks);
  const { inflateSync } = await import('zlib');
  const decompressed = inflateSync(compressedData);

  // Parse scanlines
  const pixels: Array<{ r: number; g: number; b: number; a: number }> = [];
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const scanlineLength = width * bytesPerPixel + 1; // +1 for filter byte

  for (let y = 0; y < height; y++) {
    const scanlineStart = y * scanlineLength;
    const filterType = decompressed[scanlineStart];
    const scanline = decompressed.slice(
      scanlineStart + 1,
      scanlineStart + scanlineLength
    );

    // Apply filter (simplified - only supporting None filter for now)
    // In a full implementation, we'd handle Sub, Up, Average, Paeth filters

    for (let x = 0; x < width; x++) {
      const pixelOffset = x * bytesPerPixel;

      if (colorType === 6) {
        // RGBA
        pixels.push({
          r: scanline[pixelOffset],
          g: scanline[pixelOffset + 1],
          b: scanline[pixelOffset + 2],
          a: scanline[pixelOffset + 3],
        });
      } else if (colorType === 2) {
        // RGB
        pixels.push({
          r: scanline[pixelOffset],
          g: scanline[pixelOffset + 1],
          b: scanline[pixelOffset + 2],
          a: 255,
        });
      } else {
        // Grayscale or other
        const gray = scanline[pixelOffset];
        pixels.push({ r: gray, g: gray, b: gray, a: 255 });
      }
    }
  }

  return pixels;
}
