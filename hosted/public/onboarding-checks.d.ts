// Types for the pure onboarding helpers in onboarding-checks.js. Hand-authored
// (the project has no build step) so tests/onboarding-checks.test.ts typechecks
// under the CI tsc gate. Runtime stays plain vanilla JS.

export interface OnboardingStep {
  key: string;
  title: string;
}

export interface KeyShapeHint {
  level: "empty" | "warn" | "ok";
  message: string;
}

/**
 * One endpoint in the provisioning plan. This is DATA from the control plane
 * (owned by the provisioner, #54), not a UI constant: the review screen renders
 * whatever rows the plan carries.
 */
export interface PlannedEndpoint {
  key: string;
  label: string;
  purpose: string;
  image: string;
  max_workers: number;
  gpu?: string;
}

export interface QuotaFit {
  fits: boolean;
  known: boolean;
  needed: number;
  available: number | null;
  quota: number | null;
  message: string;
  guidance: string[];
}

export interface OnboardingState {
  rulesAccepted?: boolean;
  keyPresent?: boolean;
  capacity?: QuotaFit | null;
  confirmed?: boolean;
}

export const STEPS: OnboardingStep[];
export const KEY_PREFIX: string;

export function keyShapeHint(raw: string | null | undefined): KeyShapeHint;
export function planWorkerTotal(plan: PlannedEndpoint[] | null | undefined): number;
export function quotaFit(
  quota: number | null | undefined,
  existingWorkerSum: number | null | undefined,
  plan: PlannedEndpoint[] | null | undefined,
): QuotaFit;
export function costCeilingUsd(
  wallClockMs: number | null | undefined,
  hourlyRateUsd: number | null | undefined,
): number | null;
export function formatUsd(amount: number | null | undefined): string | null;
export function stepIndex(key: string): number;
export function canAdvance(key: string, state: OnboardingState | null | undefined): boolean;
