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
  animationFiles: string[];
  materialFiles: string[];
}

export interface ResourceMap {
  geometries: Record<string, string>; // geometry.creeper -> models/entity/creeper.geo.json
  animations: Record<string, string>; // animation.creeper.walk -> animations/creeper.animation.json
  materials: Record<string, string>; // default -> materials/entity.material
}
