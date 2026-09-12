import type {
  ObjectStorage,
  ObjectStorageMetadata,
  StoredObjectMetadata,
} from "./object-storage.js";

export class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async createOnly(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    metadata: ObjectStorageMetadata,
  ): Promise<"created" | "collision"> {
    const result = await this.bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: metadata,
    });
    return result ? "created" : "collision";
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      byteSize: object.size,
      httpContentType: object.httpMetadata?.contentType ?? "",
      metadata: {
        contentType: object.customMetadata?.contentType ?? "",
        checksum: object.customMetadata?.checksum ?? "",
        uploadId: object.customMetadata?.uploadId ?? "",
      },
    };
  }

  async getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async compensationDelete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
