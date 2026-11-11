// D1 access for shot_records (migrations/0022_shot_records.sql).

import type { ShotRecord } from "./shot-step";

export interface ShotDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

interface ShotRow {
  film_id: string;
  shot_id: string;
  still_key: string | null;
  wav_key: string | null;
  clip_key: string | null;
  step: ShotRecord["step"];
  step_error: string | null;
  step_token: string | null;
  updated_at: number;
}

const READ = `SELECT film_id, shot_id, still_key, wav_key, clip_key, step, step_error, step_token, updated_at
  FROM shot_records WHERE film_id = ? AND shot_id = ?`;

const UPSERT = `INSERT INTO shot_records
  (film_id, shot_id, still_key, wav_key, clip_key, step, step_error, step_token, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(film_id, shot_id) DO UPDATE SET
    still_key = excluded.still_key,
    wav_key = excluded.wav_key,
    clip_key = excluded.clip_key,
    step = excluded.step,
    step_error = excluded.step_error,
    step_token = excluded.step_token,
    updated_at = excluded.updated_at`;

export async function readShot(db: ShotDb, filmId: string, shotId: string): Promise<ShotRecord | null> {
  const row = await db.prepare(READ).bind(filmId, shotId).first<ShotRow>();
  if (!row) return null;
  return {
    film_id: row.film_id,
    shot_id: row.shot_id,
    still_key: row.still_key,
    wav_key: row.wav_key,
    clip_key: row.clip_key,
    step: row.step,
    step_error: row.step_error,
    step_token: row.step_token,
    updated_at: row.updated_at,
  };
}

export async function writeShot(db: ShotDb, row: ShotRecord): Promise<void> {
  await db.prepare(UPSERT).bind(
    row.film_id,
    row.shot_id,
    row.still_key,
    row.wav_key,
    row.clip_key,
    row.step,
    row.step_error,
    row.step_token,
    row.updated_at,
  ).run();
}
