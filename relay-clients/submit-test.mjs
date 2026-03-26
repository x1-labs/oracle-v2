import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program } from "@solana/web3.js";
import fs from "fs";
import { createHash } from "crypto";

const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("9mPmjK8NxJadYDiHiYAQH4WFCnKJr7ZV8ria63ZkMtv2");
const STATE_PDA = new PublicKey("8XZBqbKhFXHqNGzxV3Tt6gEs9r8ZrNghsRg7zBwLMGJf");

// Load relay-1 keypair
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/relay-1.json"))));
console.log("Relay wallet:", kp.publicKey.toBase58());

// Transit pubkey
const transitPubkey = Buffer.from("8tJv+C6x1PKBtzapaR2Zx8TM8YqeDGzStfVspLBgw1w=", "base64");
console.log("Transit pubkey:", transitPubkey.toString("hex").slice(0, 16) + "...");

// Fetch a price from the feed
const feedResp = await fetch("http://127.0.0.1:8281");
const feed = await feedResp.json();
console.log("Feed update #" + feed.update_count);

// Build batch message
const index = 1;
const assets = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "FARTCOIN"];
const prices_i64 = assets.map(sym => {
  const p = feed.prices[sym]?.price || 0;
  return BigInt(Math.round(p * 1_000_000));
});
const timestamp = BigInt(Date.now());
const batchMsg = `BATCH:${index}:${prices_i64.join(":")}:${timestamp}`;
const msgBytes = Buffer.from(batchMsg);
console.log("Message:", batchMsg.slice(0, 60) + "...");

// Sign via OpenBao Transit
const vaultResp = await fetch("http://127.0.0.1:8200/v1/transit/sign/oracle-price-signer", {
  method: "POST",
  headers: { "X-Vault-Token": fs.readFileSync("/home/jack/openbao-relay-token.txt", "utf8").trim(), "Content-Type": "application/json" },
  body: JSON.stringify({ input: msgBytes.toString("base64"), marshaling_algorithm: "jws" })
});
const vaultData = await vaultResp.json();
const sigParts = vaultData.data.signature.split(":");
let sigB64 = sigParts[2].replace(/-/g, "+").replace(/_/g, "/");
while (sigB64.length % 4) sigB64 += "=";
const sig64 = Buffer.from(sigB64, "base64");
console.log("Signature length:", sig64.length, "bytes");

// Build transaction
const connection = new Connection(RPC, "confirmed");

// ix[0]: Ed25519SigVerify
const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
  publicKey: transitPubkey,
  message: msgBytes,
  signature: sig64,
});

// ix[1]: batch_submit_prices
const disc = createHash("sha256").update("global:batch_submit_prices").digest().slice(0, 8);
const data = Buffer.alloc(8 + 1 + 4 + 6*8 + 8 + 64 + 4 + msgBytes.length);
let off = 0;
disc.copy(data, off); off += 8;
data.writeUInt8(index, off); off += 1;
// Vec<i64> prices
data.writeUInt32LE(6, off); off += 4;
for (const p of prices_i64) { data.writeBigInt64LE(p, off); off += 8; }
// timestamp i64
data.writeBigInt64LE(timestamp, off); off += 8;
// [u8; 64] signature
sig64.copy(data, off); off += 64;
// Vec<u8> message
data.writeUInt32LE(msgBytes.length, off); off += 4;
msgBytes.copy(data, off); off += msgBytes.length;

const oracleIx = new TransactionInstruction({
  keys: [
    { pubkey: STATE_PDA, isSigner: false, isWritable: true },
    { pubkey: kp.publicKey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ],
  programId: PROGRAM_ID,
  data: data.slice(0, off),
});

const tx = new Transaction();
tx.add(ed25519Ix);
tx.add(oracleIx);
tx.feePayer = kp.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(kp);

console.log("TX size:", tx.serialize().length, "bytes");

try {
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("TX sent:", sig);
  console.log("Explorer: https://explorer.mainnet.x1.xyz/tx/" + sig);
  
  const conf = await connection.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    console.log("TX FAILED:", JSON.stringify(conf.value.err));
  } else {
    console.log("✅ TX CONFIRMED on-chain!");
  }
} catch(e) {
  console.log("ERROR:", e.message?.slice(0, 200));
  if (e.logs) {
    console.log("Logs:");
    e.logs.forEach(l => console.log("  " + l));
  }
}
