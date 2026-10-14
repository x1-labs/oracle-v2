import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const PROGRAM_ID = new PublicKey(requiredEnv("PROGRAM_ID"));
const RPC = requiredEnv("RPC_URL");

// Load wallet
const walletKey = JSON.parse(fs.readFileSync(requiredEnv("ADMIN_KEYPAIR_PATH")));
const wallet = Keypair.fromSecretKey(Uint8Array.from(walletKey));
console.log("Admin wallet:", wallet.publicKey.toBase58());

// OpenBao Transit public key (base64 decoded)
const transitPubkeyB64 = requiredEnv("TRANSIT_PUBLIC_KEY_BASE64");
const transitPubkey = Buffer.from(transitPubkeyB64, "base64");
console.log("Transit pubkey (hex):", transitPubkey.toString("hex"));
console.log("Transit pubkey length:", transitPubkey.length);

// Derive PDA
const [statePDA, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("oracle_vault_v1")],
  PROGRAM_ID
);
console.log("State PDA:", statePDA.toBase58(), "bump:", bump);

// Build the IDL manually since anchor build didn't generate it
// We'll use raw transaction construction
const connection = new Connection(RPC, "confirmed");

// Check if already initialized
const acct = await connection.getAccountInfo(statePDA);
if (acct) {
  console.log("PDA already exists! Size:", acct.data.length, "Owner:", acct.owner.toBase58());
  process.exit(0);
}

console.log("PDA not yet initialized. Initializing...");

// Build initialize instruction manually using Anchor discriminator
// initialize discriminator = sha256("global:initialize")[0..8]
const crypto = await import("crypto");
const disc = crypto.createHash("sha256").update("global:initialize").digest().slice(0, 8);
console.log("Discriminator:", Buffer.from(disc).toString("hex"));

// Instruction data: discriminator (8) + oracle_pubkey (32)
const data = Buffer.alloc(8 + 32);
disc.copy(data, 0);
transitPubkey.copy(data, 8);

// Build instruction
const ix = new anchor.web3.TransactionInstruction({
  keys: [
    { pubkey: statePDA, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  programId: PROGRAM_ID,
  data: data,
});

const tx = new anchor.web3.Transaction();
tx.add(ix);
tx.feePayer = wallet.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(wallet);

const sig = await connection.sendRawTransaction(tx.serialize());
console.log("Initialize TX:", sig);
await connection.confirmTransaction(sig, "confirmed");
console.log("✅ Oracle Vault initialized!");

// Verify
const state = await connection.getAccountInfo(statePDA);
console.log("State account size:", state.data.length, "bytes");
console.log("Owner:", state.owner.toBase58());
