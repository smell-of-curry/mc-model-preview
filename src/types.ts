export interface EntityFile {
  format_version: string;
  'minecraft:client_entity': {
    description: {
      identifier: string;
      materials?: Record<string, string>;
      textures?: Record<string, string>;
      geometry?: Record<string, string>;
      animations?: Record<string, string>;
      render_controllers?: any[];
      spawn_egg?: any;
      scripts?: any;
      particle_effects?: any;
      sound_effects?: any;
    };
  };
}

export interface Entity {
  identifier: string;
  entityFilePath: string;
  geometryFiles: string[];
  textureFiles: string[];
  textureMap: Record<string, string>; // key -> path mapping for textures
  animationFiles: string[];
  materialFiles: string[];
}

export interface ResourceMap {
  geometries: Record<string, string>; // geometry.creeper -> models/entity/creeper.geo.json
  animations: Record<string, string>; // animation.creeper.walk -> animations/creeper.animation.json
  materials: Record<string, string>; // default -> materials/entity.material
}

// Animation-related types

export interface ChangedAnimation {
  entityIdentifier: string;
  animationIdentifier: string;
  animationFile: string;
  isNew: boolean;
}

export interface AnimationKeyframe {
  time: number;
  value: [number, number, number];
  lerpMode?: 'linear' | 'catmullrom';
}

export interface BoneAnimation {
  rotation?: AnimationKeyframe[] | string | [number, number, number]; // keyframes, molang string, or static value
  position?: AnimationKeyframe[] | string | [number, number, number];
  scale?: AnimationKeyframe[] | string | [number, number, number];
}

export interface BedrockAnimation {
  loop?: boolean | 'hold_on_last_frame';
  animation_length?: number;
  bones?: Record<string, BedrockBoneAnimation>;
}

export interface BedrockBoneAnimation {
  rotation?: BedrockAnimationValue;
  position?: BedrockAnimationValue;
  scale?: BedrockAnimationValue;
}

// Bedrock animation values can be: static array, molang string, or keyframe object
export type BedrockAnimationValue =
  | [number, number, number]
  | string
  | [string, string, string]
  | Record<string, BedrockKeyframeValue>;

export type BedrockKeyframeValue =
  | [number, number, number]
  | { post: [number, number, number]; lerp_mode?: string };

export interface AnimationFile {
  format_version: string;
  animations: Record<string, BedrockAnimation>;
}

export interface BoneTransform {
  rotation: [number, number, number];
  position: [number, number, number];
  scale: [number, number, number];
}

export interface AnimationEvaluation {
  bones: Record<string, BoneTransform>;
}

// Incremental rendering state types

export interface RenderState {
  /** The last commit SHA that was processed */
  lastProcessedCommit: string;
  /** ISO timestamp of when the last render occurred */
  lastRenderTimestamp: string;
  /** Map of entity identifier to its render state */
  renderedEntities: Record<string, EntityRenderState>;
}

export interface EntityRenderState {
  /** The entity identifier (e.g., "pokemon:pikachu") */
  identifier: string;
  /** The commit SHA when this entity was last rendered */
  renderedCommit: string;
  /** Whether the entity has a shiny variant */
  hasShiny: boolean;
  
  // Granular file hashes for fine-grained change detection
  /** Hash of the entity definition file */
  entityFileHash: string;
  /** Hash of geometry files (filepath -> hash) */
  geometryHashes: Record<string, string>;
  /** Hash of the default texture file */
  defaultTextureHash: string;
  /** Hash of the shiny texture file (empty string if no shiny) */
  shinyTextureHash: string;
  /** Hash of animation files (animation identifier -> file hash) */
  animationHashes: Record<string, string>;
  /** Hash of material files (filepath -> hash) */
  materialHashes: Record<string, string>;
  
  // Legacy field for backward compatibility (optional)
  /** @deprecated Use granular hashes instead */
  sourceFilesHash?: string;
}

/**
 * Information about what needs to be rendered for an entity
 * Used for granular incremental rendering
 */
export interface EntityChangeInfo {
  /** The entity to render */
  entity: Entity;
  /** Whether to render the default (non-shiny) model */
  renderDefault: boolean;
  /** Whether to render the shiny model */
  renderShiny: boolean;
  /** List of animation identifiers that need to be rendered */
  animationsToRender: string[];
  /** Whether this is a new entity (not present on base branch) */
  isNew: boolean;
}

/**
 * Granular hashes for an entity's source files
 */
export interface GranularHashes {
  entityFileHash: string;
  geometryHashes: Record<string, string>;
  defaultTextureHash: string;
  shinyTextureHash: string;
  animationHashes: Record<string, string>;
  materialHashes: Record<string, string>;
}
