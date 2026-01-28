/**
 * Animation parser for Bedrock animations
 * Handles Molang expression evaluation and keyframe interpolation
 */

import {
  BedrockAnimation,
  BedrockAnimationValue,
  BedrockKeyframeValue,
  BoneTransform,
  AnimationEvaluation,
} from './types';

/**
 * Molang expression evaluator
 * Supports a subset of Molang needed for animations:
 * - q.anim_time - current animation time
 * - math.sin(), math.cos(), math.abs() - math functions
 * - Basic arithmetic operators
 */
export function evaluateMolang(expression: string, animTime: number): number {
  // Replace Molang variables
  let expr = expression
    .replace(/q\.anim_time/g, String(animTime))
    .replace(/query\.anim_time/g, String(animTime));

  // Replace Molang math functions with JavaScript equivalents
  expr = expr
    .replace(/math\.sin\(/g, 'Math.sin(')
    .replace(/math\.cos\(/g, 'Math.cos(')
    .replace(/math\.abs\(/g, 'Math.abs(')
    .replace(/math\.sqrt\(/g, 'Math.sqrt(')
    .replace(/math\.floor\(/g, 'Math.floor(')
    .replace(/math\.ceil\(/g, 'Math.ceil(')
    .replace(/math\.round\(/g, 'Math.round(')
    .replace(/math\.min\(/g, 'Math.min(')
    .replace(/math\.max\(/g, 'Math.max(')
    .replace(/math\.clamp\(/g, 'clamp(')
    .replace(/math\.lerp\(/g, 'lerp(')
    .replace(/math\.pow\(/g, 'Math.pow(')
    .replace(/math\.pi/g, 'Math.PI');

  // Create a safe evaluation context with helper functions
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  try {
    // Use Function constructor to evaluate the expression safely
    const fn = new Function('Math', 'clamp', 'lerp', `return (${expr});`);
    const result = fn(Math, clamp, lerp);
    return typeof result === 'number' && !isNaN(result) ? result : 0;
  } catch {
    // If evaluation fails, return 0
    return 0;
  }
}

/**
 * Parse a Bedrock animation value at a specific time
 * Handles static values, Molang expressions, and keyframe objects
 */
function parseAnimationValue(
  value: BedrockAnimationValue | undefined,
  animTime: number,
  defaultValue: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  if (value === undefined) return defaultValue;

  // Static array value [x, y, z]
  if (Array.isArray(value) && typeof value[0] === 'number') {
    return value as [number, number, number];
  }

  // Molang string expression (single string for all components - unusual but possible)
  if (typeof value === 'string') {
    const result = evaluateMolang(value, animTime);
    return [result, result, result];
  }

  // Array of Molang strings [x_expr, y_expr, z_expr]
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return [
      evaluateMolang(value[0] as string, animTime),
      evaluateMolang(value[1] as string, animTime),
      evaluateMolang(value[2] as string, animTime),
    ];
  }

  // Keyframe object { "0.0": [...], "0.5": [...], ... }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return interpolateKeyframes(value, animTime, defaultValue);
  }

  return defaultValue;
}

/**
 * Interpolate between keyframes at a specific time
 */
function interpolateKeyframes(
  keyframes: Record<string, BedrockKeyframeValue>,
  animTime: number,
  defaultValue: [number, number, number]
): [number, number, number] {
  const times = Object.keys(keyframes)
    .map(parseFloat)
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);

  if (times.length === 0) return defaultValue;

  // Before first keyframe
  if (animTime <= times[0]) {
    return getKeyframeValue(keyframes[String(times[0])]);
  }

  // After last keyframe
  if (animTime >= times[times.length - 1]) {
    return getKeyframeValue(keyframes[String(times[times.length - 1])]);
  }

  // Find surrounding keyframes
  let prevIndex = 0;
  for (let i = 0; i < times.length - 1; i++) {
    if (animTime >= times[i] && animTime < times[i + 1]) {
      prevIndex = i;
      break;
    }
  }

  const prevTime = times[prevIndex];
  const nextTime = times[prevIndex + 1];
  const prevKey = keyframes[String(prevTime)];
  const nextKey = keyframes[String(nextTime)];

  const prevValue = getKeyframeValue(prevKey);
  const nextValue = getKeyframeValue(nextKey);
  const lerpMode = getKeyframeLerpMode(prevKey);

  // Calculate interpolation factor
  const t = (animTime - prevTime) / (nextTime - prevTime);

  if (lerpMode === 'catmullrom') {
    // For catmullrom, we need 4 control points
    // Use previous and next neighbors if available, otherwise duplicate
    const prevPrevTime = prevIndex > 0 ? times[prevIndex - 1] : prevTime;
    const nextNextTime =
      prevIndex + 2 < times.length ? times[prevIndex + 2] : nextTime;

    const p0 = getKeyframeValue(keyframes[String(prevPrevTime)]);
    const p1 = prevValue;
    const p2 = nextValue;
    const p3 = getKeyframeValue(keyframes[String(nextNextTime)]);

    return catmullRomInterpolate(p0, p1, p2, p3, t);
  }

  // Default to linear interpolation
  return linearInterpolate(prevValue, nextValue, t);
}

/**
 * Extract the value from a keyframe (handles both array and object formats)
 */
function getKeyframeValue(
  keyframe: BedrockKeyframeValue
): [number, number, number] {
  if (Array.isArray(keyframe)) {
    return keyframe as [number, number, number];
  }
  if (keyframe && typeof keyframe === 'object' && 'post' in keyframe) {
    return keyframe.post;
  }
  return [0, 0, 0];
}

/**
 * Get the lerp mode from a keyframe
 */
function getKeyframeLerpMode(
  keyframe: BedrockKeyframeValue
): 'linear' | 'catmullrom' {
  if (
    keyframe &&
    typeof keyframe === 'object' &&
    'lerp_mode' in keyframe &&
    keyframe.lerp_mode === 'catmullrom'
  ) {
    return 'catmullrom';
  }
  return 'linear';
}

/**
 * Linear interpolation between two 3D points
 */
function linearInterpolate(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Catmull-Rom spline interpolation between 4 control points
 */
function catmullRomInterpolate(
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
  t: number
): [number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;

  const result: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    // Catmull-Rom spline formula
    result[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }

  return result;
}

/**
 * Evaluate a Bedrock animation at a specific time
 * Returns bone transforms for all animated bones
 */
export function evaluateAnimation(
  animation: BedrockAnimation,
  time: number
): AnimationEvaluation {
  const result: AnimationEvaluation = { bones: {} };

  // Handle looping
  let animTime = time;
  const length = animation.animation_length || 1;

  if (animation.loop === true && length > 0) {
    animTime = time % length;
  } else if (animation.loop === 'hold_on_last_frame' && time > length) {
    animTime = length;
  }

  if (!animation.bones) return result;

  for (const [boneName, boneAnim] of Object.entries(animation.bones)) {
    const transform: BoneTransform = {
      rotation: parseAnimationValue(boneAnim.rotation, animTime, [0, 0, 0]),
      position: parseAnimationValue(boneAnim.position, animTime, [0, 0, 0]),
      scale: parseAnimationValue(boneAnim.scale, animTime, [1, 1, 1]),
    };

    result.bones[boneName] = transform;
  }

  return result;
}

/**
 * Get the duration of an animation
 */
export function getAnimationDuration(animation: BedrockAnimation): number {
  return animation.animation_length || 1;
}

/**
 * Check if an animation is looping
 */
export function isAnimationLooping(animation: BedrockAnimation): boolean {
  return animation.loop === true;
}
