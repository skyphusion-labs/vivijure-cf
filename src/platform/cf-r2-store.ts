import type { ObjectHead, ObjectStore } from "./types.js";

/** R2 bucket -> Platform ObjectStore (orchestrator re-wraps via wrapR2Bucket). */
export class CfR2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<ArrayBuffer | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return obj.arrayBuffer();
  }

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    await this.bucket.put(key, value, opts?.httpMetadata ? { httpMetadata: opts.httpMetadata } : undefined);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return {
      size: obj.size,
      etag: obj.etag,
      uploaded: obj.uploaded,
      httpMetadata: obj.httpMetadata,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

export function cfObjectStoreFromR2(bucket: R2Bucket): CfR2ObjectStore {
  return new CfR2ObjectStore(bucket);
}
