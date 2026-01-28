declare module 'gif-encoder-2' {
  import { CanvasRenderingContext2D } from 'canvas';

  type Algorithm = 'neuquant' | 'octree';

  class GIFEncoder {
    constructor(width: number, height: number, algorithm?: Algorithm, useOptimizer?: boolean, totalFrames?: number);
    
    setDelay(delay: number): void;
    setRepeat(repeat: number): void;
    setQuality(quality: number): void;
    setTransparent(color: number | string): void;
    setDispose(code: number): void;
    
    start(): void;
    addFrame(ctx: CanvasRenderingContext2D): void;
    finish(): void;
    
    out: {
      getData(): Buffer;
    };
  }

  export default GIFEncoder;
}
