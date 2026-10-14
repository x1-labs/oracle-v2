import * as fs from "fs";

type FetchLike = typeof fetch;

interface OpenBaoAuthOptions {
  address: string;
  staticToken?: string;
  roleId?: string;
  secretIdFile?: string;
  fetchFn?: FetchLike;
  now?: () => number;
  readSecretId?: () => string;
}

interface AuthResponse {
  auth?: {
    client_token?: string;
    lease_duration?: number;
    renewable?: boolean;
  };
}

export class OpenBaoAuth {
  private readonly address: string;
  private readonly staticToken?: string;
  private readonly roleId?: string;
  private readonly secretIdFile?: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly readSecretId: () => string;

  private token?: string;
  private renewable = false;
  private renewAt = 0;

  constructor(options: OpenBaoAuthOptions) {
    this.address = options.address.replace(/\/$/, "");
    this.staticToken = options.staticToken;
    this.roleId = options.roleId;
    this.secretIdFile = options.secretIdFile;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.readSecretId = options.readSecretId ?? (() => {
      if (!this.secretIdFile) throw new Error("VAULT_SECRET_ID_FILE is not configured");
      return fs.readFileSync(this.secretIdFile, "utf8").trim();
    });

    const appRoleConfigured = Boolean(this.roleId || this.secretIdFile);
    if (this.staticToken && appRoleConfigured) {
      throw new Error("Configure either VAULT_TOKEN or AppRole credentials, not both");
    }
    if (!this.staticToken && (!this.roleId || !this.secretIdFile)) {
      throw new Error(
        "Configure VAULT_TOKEN or both VAULT_ROLE_ID and VAULT_SECRET_ID_FILE",
      );
    }
  }

  async getToken(forceLogin = false): Promise<string> {
    if (this.staticToken) return this.staticToken;

    if (forceLogin || !this.token) return this.login();
    if (this.now() < this.renewAt) return this.token;

    if (this.renewable) {
      try {
        return await this.renew();
      } catch {
        // Re-authenticate from the mounted SecretID after a failed renewal.
      }
    }
    return this.login();
  }

  invalidate(): void {
    if (this.staticToken) return;
    this.token = undefined;
    this.renewAt = 0;
  }

  private async login(): Promise<string> {
    const secretId = this.readSecretId();
    if (!secretId) throw new Error("OpenBao SecretID file is empty");

    const response = await this.fetchFn(`${this.address}/v1/auth/approle/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: this.roleId, secret_id: secretId }),
    });
    return this.acceptAuthResponse(response, "AppRole login");
  }

  private async renew(): Promise<string> {
    if (!this.token) return this.login();
    const response = await this.fetchFn(`${this.address}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": this.token,
      },
      body: "{}",
    });
    return this.acceptAuthResponse(response, "token renewal");
  }

  private async acceptAuthResponse(response: Response, operation: string): Promise<string> {
    if (!response.ok) {
      throw new Error(`OpenBao ${operation} failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as AuthResponse;
    const token = body.auth?.client_token;
    const leaseSeconds = body.auth?.lease_duration;
    if (!token || !leaseSeconds || leaseSeconds <= 0) {
      throw new Error(`OpenBao ${operation} returned an invalid auth response`);
    }

    this.token = token;
    this.renewable = body.auth?.renewable === true;
    this.renewAt = this.now() + Math.max(1, leaseSeconds * 2 / 3) * 1000;
    return token;
  }
}
