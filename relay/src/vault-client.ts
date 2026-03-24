/**
 * Vault Transit Signing Client
 *
 * Communicates with HashiCorp Vault's Transit secrets engine for Ed25519
 * signing and verification. Keys never leave Vault — only signatures
 * transit the wire.
 */

export interface VaultHealth {
  sealed: boolean;
  initialized: boolean;
  version: string;
}

export interface UnsealResponse {
  sealed: boolean;
  t: number;
  n: number;
  progress: number;
}

export class VaultClient {
  private vaultAddr: string;
  private token: string;

  constructor(vaultAddr: string, token: string) {
    this.vaultAddr = vaultAddr.replace(/\/+$/, "");
    this.token = token.trim();
  }

  // ─── Health ─────────────────────────────────────────────────────────

  async healthCheck(): Promise<VaultHealth> {
    // Vault /sys/health returns 200 if unsealed+initialized,
    // 429 if unsealed+standby, 472 if recovery, 501 if not init, 503 if sealed
    const res = await fetch(`${this.vaultAddr}/v1/sys/health`, {
      method: "GET",
    });

    const body = await res.json();
    return {
      sealed: body.sealed ?? true,
      initialized: body.initialized ?? false,
      version: body.version ?? "unknown",
    };
  }

  // ─── Unseal ─────────────────────────────────────────────────────────

  async unseal(keys: string[]): Promise<boolean> {
    let lastResponse: UnsealResponse | null = null;

    for (const key of keys) {
      const res = await fetch(`${this.vaultAddr}/v1/sys/unseal`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Unseal failed (${res.status}): ${errText}`);
      }

      lastResponse = (await res.json()) as UnsealResponse;

      // If already unsealed after this key, stop early
      if (!lastResponse.sealed) {
        return true;
      }
    }

    return lastResponse ? !lastResponse.sealed : false;
  }

  // ─── Sign ───────────────────────────────────────────────────────────

  /**
   * Sign data using Vault Transit. Returns the full vault signature string
   * (e.g. "vault:v1:base64sig...").
   */
  async sign(keyName: string, data: Buffer): Promise<string> {
    const b64Input = data.toString("base64");

    const res = await fetch(
      `${this.vaultAddr}/v1/transit/sign/${keyName}`,
      {
        method: "POST",
        headers: {
          "X-Vault-Token": this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: b64Input,
          marshaling_algorithm: "jws",
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Vault sign failed (${res.status}): ${errBody}`);
    }

    const body = await res.json();
    return body.data.signature as string;
  }

  // ─── Verify ─────────────────────────────────────────────────────────

  /**
   * Verify a signature against original data.
   */
  async verify(
    keyName: string,
    data: Buffer,
    signature: string
  ): Promise<boolean> {
    const b64Input = data.toString("base64");

    const res = await fetch(
      `${this.vaultAddr}/v1/transit/verify/${keyName}`,
      {
        method: "POST",
        headers: {
          "X-Vault-Token": this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: b64Input,
          signature,
          marshaling_algorithm: "jws",
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Vault verify failed (${res.status}): ${errBody}`);
    }

    const body = await res.json();
    return body.data.valid as boolean;
  }

  // ─── Export Key (should fail — for testing) ─────────────────────────

  /**
   * Attempt to export a transit key. This SHOULD fail with 403 if the
   * policy is configured correctly (sign/verify only).
   */
  async exportKey(keyName: string): Promise<never> {
    const res = await fetch(
      `${this.vaultAddr}/v1/transit/export/signing-key/${keyName}`,
      {
        method: "GET",
        headers: {
          "X-Vault-Token": this.token,
        },
      }
    );

    const body = await res.text();

    if (!res.ok) {
      throw new Error(`Export blocked (${res.status}): ${body}`);
    }

    // If we got here, policy is misconfigured — still throw
    throw new Error(
      "SECURITY VIOLATION: Key export succeeded — policy misconfigured!"
    );
  }

  // ─── Sign with a specific token (for testing bad tokens) ────────────

  async signWithToken(
    keyName: string,
    data: Buffer,
    token: string
  ): Promise<string> {
    const b64Input = data.toString("base64");

    const res = await fetch(
      `${this.vaultAddr}/v1/transit/sign/${keyName}`,
      {
        method: "POST",
        headers: {
          "X-Vault-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: b64Input,
          marshaling_algorithm: "jws",
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Sign failed (${res.status}): ${errBody}`);
    }

    const body = await res.json();
    return body.data.signature as string;
  }
}
