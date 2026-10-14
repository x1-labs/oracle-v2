import assert from "node:assert/strict";
import test from "node:test";

import { OpenBaoAuth } from "./openbao-auth.js";

function authResponse(token: string, leaseDuration = 90, renewable = true): Response {
  return new Response(JSON.stringify({
    auth: {
      client_token: token,
      lease_duration: leaseDuration,
      renewable,
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("logs in with AppRole and caches the leased token", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const auth = new OpenBaoAuth({
    address: "https://openbao.example/",
    roleId: "role-id",
    secretIdFile: "/mounted/secret-id",
    readSecretId: () => "secret-id",
    fetchFn: async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return authResponse("leased-token");
    },
  });

  assert.equal(await auth.getToken(), "leased-token");
  assert.equal(await auth.getToken(), "leased-token");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://openbao.example/v1/auth/approle/login");
  assert.deepEqual(JSON.parse(requests[0].body ?? "{}"), {
    role_id: "role-id",
    secret_id: "secret-id",
  });
});

test("renews an AppRole token before its lease expires", async () => {
  let now = 1_000;
  const urls: string[] = [];
  const auth = new OpenBaoAuth({
    address: "https://openbao.example",
    roleId: "role-id",
    secretIdFile: "/mounted/secret-id",
    readSecretId: () => "secret-id",
    now: () => now,
    fetchFn: async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? authResponse("initial-token")
        : authResponse("renewed-token");
    },
  });

  assert.equal(await auth.getToken(), "initial-token");
  now += 61_000;
  assert.equal(await auth.getToken(), "renewed-token");
  assert.deepEqual(urls, [
    "https://openbao.example/v1/auth/approle/login",
    "https://openbao.example/v1/auth/token/renew-self",
  ]);
});

test("re-authenticates when renewal fails", async () => {
  let now = 1_000;
  let request = 0;
  const auth = new OpenBaoAuth({
    address: "https://openbao.example",
    roleId: "role-id",
    secretIdFile: "/mounted/secret-id",
    readSecretId: () => "secret-id",
    now: () => now,
    fetchFn: async () => {
      request++;
      if (request === 1) return authResponse("initial-token");
      if (request === 2) return new Response("unavailable", { status: 503 });
      return authResponse("replacement-token");
    },
  });

  assert.equal(await auth.getToken(), "initial-token");
  now += 61_000;
  assert.equal(await auth.getToken(), "replacement-token");
  assert.equal(request, 3);
});

test("rejects ambiguous or incomplete authentication configuration", () => {
  assert.throws(
    () => new OpenBaoAuth({
      address: "https://openbao.example",
      staticToken: "token",
      roleId: "role-id",
      secretIdFile: "/secret-id",
    }),
    /either VAULT_TOKEN or AppRole credentials/,
  );
  assert.throws(
    () => new OpenBaoAuth({
      address: "https://openbao.example",
      roleId: "role-id",
    }),
    /VAULT_ROLE_ID and VAULT_SECRET_ID_FILE/,
  );
});
