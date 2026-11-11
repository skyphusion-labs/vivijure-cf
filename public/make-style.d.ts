// Types for public/make-style.js (cf#1242), so tests import it under tsc.
export interface Mod {
  name: string;
  hooks?: string[];
  provides?: { id: string; label: string }[];
  usage?: { native_audio?: boolean; driving_audio?: boolean; first_last?: boolean; [k: string]: unknown };
  ui?: { order?: number; cost_usd_per_second?: number[]; [k: string]: unknown };
  config_schema?: Record<string, { type: string; values?: string[]; default?: unknown; min?: number; max?: number; [k: string]: unknown }>;
  trains_loras?: boolean;
  [k: string]: unknown;
}
export interface Registry {
  modules?: Mod[];
  hooks?: Record<string, string[]>;
  render?: { quality_tiers?: { value: string; label?: string }[]; default_tier?: string };
  [k: string]: unknown;
}
export interface Shape { id: string; label: string; hint: string; ratio: string; width: number; height: number }
export interface Quality { id: string; label: string; tier: string; res: string }
export interface Host { wanTrainable?: boolean; wanReady?: boolean; voicesReady?: boolean }
export interface Opts { shape?: string; quality?: string; talks?: boolean | null; host?: Host }
export interface Price { usd: number | null; kind: string; perSecond?: number; exact?: boolean }
export interface Choice {
  door: Mod;
  still: Mod | null;
  shape: Shape;
  grade: number;
  evidence: string;
  needs: string | null;
  line: string;
  motionConfig: Record<string, unknown>;
  stillConfig: { width: number; height: number };
}
export const GRADE: { DRIFT: number; ONE: number; TWO: number; HOLD: number };
export const SHAPES: Shape[];
export const QUALITIES: Quality[];
export const DEFAULT_SHAPE: string;
export const FACE_HOLD: Record<"hold" | "two" | "one" | "drift", number>;
export function faceGrade(mod: Mod | null | undefined): number;
export function canSpeak(mod: Mod | null | undefined): boolean;
export function voiceLock(mod: Mod | null | undefined): number;
export function stillsDoor(reg: Registry): Mod | null;
export function candidates(reg: Registry, opts?: Opts): Mod[];
export function offeredShapes(reg: Registry, opts?: Opts): Shape[];
export function offeredQualities(reg: Registry): Quality[];
export function resolutionFor(mod: Mod, quality?: string): { field: string; value: string; pos: string } | null;
export function clipPrice(mod: Mod, seconds: number | number[], quality?: string): Price;
export function priceText(p: Price): string;
export function lengthNote(issue: { detail?: { index: number; planned_seconds: number; min_seconds: number | null; max_seconds: number | null; steps: number[] | null } } | null | undefined): string;
export function talkingStyleLine(board: unknown, mod: Mod | null | undefined): string;
export function boardSeconds(board: unknown): number;
export function sceneSeconds(board: unknown): number[];
export function doorSeconds(mod: Mod, seconds: number): number;
export function rateLine(mod: Mod | null | undefined): string;
export function hasSpokenLines(board: unknown): boolean;
export function styleLine(mod: Mod | null | undefined): string;
export function chooseStyle(reg: Registry, opts?: Opts): Choice | null;
