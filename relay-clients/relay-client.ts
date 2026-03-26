import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";
import { createHash } from "crypto";

// ── Config ──────────────────────────────────────────────────────────────────
const CLIENT_ID   = process.env.CLIENT_ID   || "relay-0";
const VAULT_ADDR  = process.env.VAULT_ADDR  || "http://127.0.0.1:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";
const KEY_NAME    = process.env.KEY_NAME    || "oracle-price-signer";
const INTERVAL    = parseInt(process.env.INTERVAL || "10", 10) * 1000;
const PRICE_FEED  = process.env.PRICE_FEED  || "http://127.0.0.1:8281";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || "";
const RPC_URL     = process.env.RPC_URL     || "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID  = new PublicKey(process.env.PROGRAM_ID || "9mPmjK8NxJadYDiHiYAQH4WFCnKJr7ZV8ria63ZkMtv2");
const TRANSIT_B64 = process.env.TRANSIT_PUBKEY || "8tJv+C6x1PKBtzapaR2Zx8TM8YqeDGzStfVspLBgw1w=";
const STATE_PDA   = new PublicKey("8XZBqbKhFXHqNGzxV3Tt6gEs9r8ZrNghsRg7zBwLMGJf");
const CU_BUDGET   = parseInt(process.env.CU_BUDGET || "25000", 10);

const ASSETS: string[] = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "FARTCOIN"];
const DECIMALS = 6;

// ── Types ───────────────────────────────────────────────────────────────────
interface PriceFeed {
  update_count: number;
  sources: Record<string, number>;
  prices: Record<string, { price: number; sources: string[] }>;
}

interface VaultSignResponse {
  data: { signature: string };
}

// ── Setup ───────────────────────────────────────────────────────────────────
const transitPubkey = Buffer.from(TRANSIT_B64, "base64");
const connection = new Connection(RPC_URL, "confirmed");
const clientNum = parseInt(CLIENT_ID.split("-").pop() || "1", 10);
const relayIndex = clientNum;

const keypairData: number[] = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));

// ── ANSI helpers ────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m";
const C = "\x1b[36m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

function log(msg: string, color = ""): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${D}[${ts}]${X} ${B}${C}[${CLIENT_ID}]${X} ${color}${msg}${X}`);
}

function fmtPrice(p: number): string {
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  return "$" + p.toFixed(8);
}

// ── Anchor discriminator ────────────────────────────────────────────────────
function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

// ── Vault health check ─────────────────────────────────────────────────────
async function checkVault(): Promise<boolean> {
  try {
    const r = await fetch(`${VAULT_ADDR}/v1/sys/health`);
    const d = await r.json() as { sealed?: boolean };
    return !d.sealed;
  } catch {
    return false;
  }
}

// ── Sign via OpenBao Transit ────────────────────────────────────────────────
async function transitSign(message: Buffer): Promise<Buffer> {
  const resp = await fetch(`${VAULT_ADDR}/v1/transit/sign/${KEY_NAME}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: message.toString("base64"),
      marshaling_algorithm: "jws",
    }),
  });

  const body = (await resp.json()) as VaultSignResponse;
  let sigB64 = body.data.signature.split(":")[2]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (sigB64.length % 4) sigB64 += "=";

  const sig = Buffer.from(sigB64, "base64");
  if (sig.length !== 64) throw new Error(`Bad signature length: ${sig.length}`);
  return sig;
}

// ── Build batch instruction data ────────────────────────────────────────────
function buildBatchData(
  index: number,
  prices: bigint[],
  timestamp: bigint,
  signature: Buffer,
  message: Buffer,
): Buffer {
  const discriminator = disc("batch_submit_prices");
  const buf = Buffer.alloc(
    8 + 1 + 4 + prices.length * 8 + 8 + 64 + 4 + message.length,
  );
  let off = 0;

  discriminator.copy(buf, off); off += 8;
  buf.writeUInt8(index, off); off += 1;
  buf.writeUInt32LE(prices.length, off); off += 4;
  for (const p of prices) { buf.writeBigInt64LE(p, off); off += 8; }
  buf.writeBigInt64LE(timestamp, off); off += 8;
  signature.copy(buf, off); off += 64;
  buf.writeUInt32LE(message.length, off); off += 4;
  message.copy(buf, off); off += message.length;

  return buf.subarray(0, off);
}

// ── Main round ──────────────────────────────────────────────────────────────
let round = 0;
let totalSigned = 0;
let totalSubmitted = 0;
let totalErrors = 0;

async function runRound(): Promise<void> {
  round++;
  log(`── Round ${round} ──`, Y);

  // 1. Fetch prices
  let feed: PriceFeed;
  try {
    const r = await fetch(PRICE_FEED);
    feed = (await r.json()) as PriceFeed;
  } catch {
    log("Price feed unavailable", R);
    totalErrors++;
    return;
  }

  const srcSummary = Object.entries(feed.sources || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  log(`  Feed #${feed.update_count || 0} [${srcSummary}]`, D);

  // 2. Build batch message
  const timestamp = BigInt(Date.now());
  const pricesI64: bigint[] = ASSETS.map((sym) => {
    const p = feed.prices[sym]?.price || 0;
    return BigInt(Math.round(p * 10 ** DECIMALS));
  });

  const batchMsg = `BATCH:${relayIndex}:${pricesI64.join(":")}:${timestamp}`;
  const msgBytes = Buffer.from(batchMsg);

  // 3. Sign via OpenBao Transit
  let sig64: Buffer;
  try {
    sig64 = await transitSign(msgBytes);
    totalSigned++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  Sign error: ${msg}`, R);
    totalErrors++;
    return;
  }

  // 4. Log prices
  ASSETS.forEach((sym, i) => {
    const p = Number(pricesI64[i]) / 10 ** DECIMALS;
    const srcs = (feed.prices[sym]?.sources || [])
      .map((s: string) => s.slice(0, 3).toUpperCase())
      .join("+");
    log(
      `  ${sym.padEnd(10)} ${fmtPrice(p).padStart(14)}  ${G}signed ✅${X}  ${D}[${srcs}]${X}`,
      G,
    );
  });

  // 5. Build and send transaction
  try {
    // Compute budget: set CU limit
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: CU_BUDGET,
    });

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: transitPubkey,
      message: msgBytes,
      signature: sig64,
    });

    const oracleIx = new TransactionInstruction({
      keys: [
        { pubkey: STATE_PDA, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: buildBatchData(relayIndex, pricesI64, timestamp, sig64, msgBytes),
    });

    const tx = new Transaction()
      .add(cuLimitIx)
      .add(ed25519Ix)
      .add(oracleIx);
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(wallet);

    const txSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    totalSubmitted++;
    log(`  ${G}ON-CHAIN ✅${X} TX: ${txSig.slice(0, 30)}...  [${CU_BUDGET} CU]`, G);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message?.slice(0, 120) : String(e);
    log(`  ${R}Submit failed: ${msg}${X}`, R);
    if (e && typeof e === "object" && "logs" in e) {
      (e as { logs: string[] }).logs.forEach((l: string) => log(`    ${l}`, D));
    }
    totalErrors++;
  }

  log(
    `  ${D}Total: ${totalSigned} signed, ${totalSubmitted} submitted, ${totalErrors} errors${X}`,
    D,
  );
}

// ── Boot ────────────────────────────────────────────────────────────────────
log(`Oracle Relay Client v3 (TypeScript) — ${CU_BUDGET} CU budget`, Y);
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Program: ${PROGRAM_ID.toBase58()} | Index: ${relayIndex} | Interval: ${INTERVAL / 1000}s`);

while (!(await checkVault())) {
  log("Waiting for OpenBao...", Y);
  await new Promise((r) => setTimeout(r, 5000));
}
log("OpenBao: OK ✅", G);

// Stagger start
await new Promise((r) => setTimeout(r, clientNum * 2000));

// Main loop
while (true) {
  await runRound();
  const jitter = Math.random() * 2000;
  await new Promise((r) => setTimeout(r, INTERVAL + jitter));
}
