declare module 'omggif' {
  interface GifWriterOptions {
    loop?: number;
    palette?: number[];
    background?: number;
  }

  interface FrameOptions {
    palette?: number[];
    delay?: number;
    disposal?: number;
    transparent?: number;
  }

  export class GifWriter {
    constructor(buffer: Buffer, width: number, height: number, options?: GifWriterOptions);
    addFrame(
      x: number,
      y: number,
      width: number,
      height: number,
      indexedPixels: Uint8Array,
      options?: FrameOptions
    ): void;
    end(): number;
  }

  export class GifReader {
    constructor(buffer: Buffer);
    width: number;
    height: number;
    numFrames(): number;
    frameInfo(frameNum: number): any;
    decodeAndBlitFrameRGBA(frameNum: number, pixels: Uint8Array): void;
  }
}
