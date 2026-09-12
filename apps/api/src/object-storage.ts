export type ObjectStorageMetadata = {
  contentType: string;
  checksum: string;
  uploadId: string;
};

export type StoredObjectMetadata = {
  byteSize: number;
  httpContentType: string;
  metadata: ObjectStorageMetadata;
};

export interface ObjectStorage {
  createOnly(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    metadata: ObjectStorageMetadata,
  ): Promise<"created" | "collision">;
  head(key: string): Promise<StoredObjectMetadata | null>;
  getBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  compensationDelete(key: string): Promise<void>;
}
