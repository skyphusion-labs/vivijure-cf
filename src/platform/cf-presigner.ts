import type { ObjectPresigner } from "./types.js";
import type { Env } from "../env.js";
import { presignR2Get, presignR2Put } from "../r2-presign.js";

/** SigV4 R2 presigner (CPU containers + RunPod fetches). */
export function cfPresignerFromEnv(env: Env): ObjectPresigner {
  return {
    presignGet(key, expiresSec) {
      return presignR2Get(env, key, expiresSec);
    },
    presignPut(key, contentType, expiresSec) {
      void contentType;
      return presignR2Put(env, key, expiresSec);
    },
  };
}
