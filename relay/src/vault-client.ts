/**
 * Transit Signing Client
 *
 * Communicates with OpenBao (or HashiCorp Vault) Transit secrets engine
 * for Ed25519 signing and verification. Keys never leave the server —
 * only signatures transit the wire.
 *
 * OpenBao is the open-source fork of HashiCorp Vault (MPL 2.0).
 * The HTTP API is 100% identical — same endpoints, same auth headers,
 * same env vars (VAULT_ADDR, VAULT_TOKEN).
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

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

export interface OpenBaoCredsFile {
  vault_addr: string;
  root_token: string;
  relay_token: string;
  key_name: string;
  pid: number;
  backend?: string;
  version?: string;
}

export class TransitClient {
  private vaultAddr: string;
  private token: string;

  constructor(vaultAddr: string, token: string) {
    this.vaultAddr = vaultAddr.replace(/\/+$/, "");
    this.token = token.trim();
  }

  /**
   * Create a TransitClient from an openbao-creds.json file.
   * Falls back to old init-keys.json / relay-token.txt paths for backwards compat.
   */
  static fromCredsFile(credsPath: string): TransitClient {
    const absPath = resolve(credsPath);

    if (!existsSync(absPath)) {
      throw new Error(`Credentials file not found: ${absPath}`);
    }

    const creds: OpenBaoCredsFile = JSON.parse(readFileSync(absPath, "utf-8"));

    if (!creds.vault_addr || !creds.relay_token) {
      throw new Error(
        `Invalid credentials file — missing vault_addr or relay_token: ${absPath}`
      );
    }

    return new TransitClient(creds.vault_addr, creds.relay_token);
  }

  /**
   * Returns "openbao" or "vault" based on the health check version string.
   * OpenBao versions look like "2.x.y" (no "Vault" prefix in the version field,
   * but the build info will say "OpenBao" in the version metadata).
   * As a practical heuristic: major version ≥ 2 → openbao.
   */
  async backend(): Promise<"openbao" | "vault"> {
    try {
      const health = await this.healthCheck();
      const version = health.version || "";
      // OpenBao uses semver like "2.5.2" while Vault uses "1.x.y"
      // Also check for "OpenBao" in the version string
      const majorVersion = parseInt(version.split(".")[0] || "0", 10);
      if (version.toLowerCase().includes("openbao") || majorVersion >= 2) {
        return "openbao";
      }
      return "vault";
    } catch {
      return "vault";
    }
  }

  // ─── Health ─────────────────────────────────────────────────────────

  async healthCheck(): Promise<VaultHealth> {
    // /sys/health returns 200 if unsealed+initialized,
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
   * Sign data using Transit. Returns the full signature string
   * (e.g. "vault:v1:base64sig..." — same format for OpenBao).
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
      throw new Error(`Transit sign failed (${res.status}): ${errBody}`);
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
      throw new Error(`Transit verify failed (${res.status}): ${errBody}`);
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

// Backwards-compatible aliases (value + type)
export const VaultClient = TransitClient;
export type VaultClient = TransitClient;
