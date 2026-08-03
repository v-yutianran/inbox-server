const VERSION = 1;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/** D1 仅保存版本化 AES-GCM 密文，主密钥始终由 Worker secret 注入。 */
export async function encryptJson(
  value: unknown,
  encodedKey: string,
  cryptoApi: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  const key = await importKey(encodedKey, cryptoApi);
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const envelope = new Uint8Array(1 + IV_LENGTH + ciphertext.length);
  envelope[0] = VERSION;
  envelope.set(iv, 1);
  envelope.set(ciphertext, 1 + IV_LENGTH);
  return envelope;
}

export async function decryptJson(
  envelope: Uint8Array | ArrayBuffer,
  encodedKey: string,
  cryptoApi: Crypto = globalThis.crypto,
): Promise<unknown> {
  const bytes = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (bytes.length <= 1 + IV_LENGTH || bytes[0] !== VERSION) {
    throw new Error("encrypted credential envelope is invalid");
  }
  const key = await importKey(encodedKey, cryptoApi);
  const plaintext = await cryptoApi.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(1, 1 + IV_LENGTH) },
    key,
    bytes.slice(1 + IV_LENGTH),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

async function importKey(encodedKey: string, cryptoApi: Crypto): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(encodedKey.trim()), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new Error("STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  if (raw.length !== KEY_LENGTH) {
    throw new Error("STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return cryptoApi.subtle.importKey(
    "raw",
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
