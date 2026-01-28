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
