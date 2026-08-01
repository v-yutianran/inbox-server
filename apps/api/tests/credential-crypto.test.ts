import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "../src/credential-crypto";

const key = "O+hpQJ3bK9wZy+q3Y2c5fG9V8a4m2h6K3p7n1s5u9xE=";

describe("credential crypto", () => {
  it("使用 AES-GCM 往返 JSON，且密文不包含原始凭据", async () => {
    const payload = { sessdata: "sensitive-cookie", nested: { token: "secret" } };

    const encrypted = await encryptJson(payload, key);

    expect(new TextDecoder().decode(encrypted)).not.toContain("sensitive-cookie");
    await expect(decryptJson(encrypted, key)).resolves.toEqual(payload);
  });

  it("拒绝被篡改的密文", async () => {
    const encrypted = await encryptJson({ z_c0: "cookie" }, key);
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;

    await expect(decryptJson(encrypted, key)).rejects.toThrow();
  });

  it("拒绝长度错误的主密钥", async () => {
    await expect(encryptJson({ token: "secret" }, "bad-key")).rejects.toThrow(
      "STATE_ENCRYPTION_KEY",
    );
  });
});
