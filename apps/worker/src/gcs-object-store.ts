import type { AttachmentObjectStore } from "./collector-types.js";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STORAGE_API = "https://storage.googleapis.com";
const OBJECT_KEY_PATTERN =
  /^telegram\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createGcsObjectStore(options: {
  readonly bucket: string;
  readonly fetcher?: typeof fetch;
}): AttachmentObjectStore {
  validateBucket(options.bucket);
  const fetcher = options.fetcher ?? fetch;

  return {
    async download(objectKey) {
      validateObjectKey(objectKey);
      const token = await accessToken(fetcher);
      const url = `${STORAGE_API}/storage/v1/b/${options.bucket}/o/${encodeURIComponent(objectKey)}?alt=media`;
      const response = await safeFetch(fetcher, url, {
        headers: { Authorization: `Bearer ${token}` },
        method: "GET",
      }, "gcs_object_download_failed");
      if (!response.ok) throw new Error(`gcs_object_download_failed:${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async upload(objectKey, bytes) {
      validateObjectKey(objectKey);
      const token = await accessToken(fetcher);
      const url = new URL(`${STORAGE_API}/upload/storage/v1/b/${options.bucket}/o`);
      url.searchParams.set("uploadType", "media");
      url.searchParams.set("name", objectKey);
      const response = await safeFetch(fetcher, url, {
        body: toArrayBuffer(bytes),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        method: "POST",
      }, "gcs_object_upload_failed");
      if (!response.ok) throw new Error(`gcs_object_upload_failed:${response.status}`);
    },
  };
}

async function accessToken(fetcher: typeof fetch): Promise<string> {
  const response = await safeFetch(fetcher, METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    method: "GET",
  }, "gcs_access_token_failed");
  if (!response.ok) throw new Error(`gcs_access_token_failed:${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("gcs_access_token_response_invalid");
  }
  if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("gcs_access_token_response_invalid");
  }
  return payload.access_token;
}

async function safeFetch(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
  errorCode: string,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch {
    throw new Error(errorCode);
  }
}

function validateBucket(bucket: string): void {
  if (
    bucket.length < 3
    || bucket.length > 63
    || !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..")
  ) {
    throw new Error("gcs_bucket_invalid");
  }
}

function validateObjectKey(objectKey: string): void {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) throw new Error("gcs_object_key_invalid");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
