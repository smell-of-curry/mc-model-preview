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

  class GifWriter {
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

  export = GifWriter;
}
