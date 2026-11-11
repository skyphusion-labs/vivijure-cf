// Types for public/audio-bed.js (cf#1016). Hand-authored: no build step.
export function isUploadedBedKey(key: unknown): boolean;
export function deleteUrl(key: unknown): string | null;
export function deleteOutcome(status: number, body: unknown): { unlink: boolean; message: string };
