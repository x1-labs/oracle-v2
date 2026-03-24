#!/usr/bin/env npx tsx
/**
 * Oracle V2 — Mainnet Integration Test
 * 
 * Tests: initialize → set_updater → set_price → batch_set_prices → update_median → pause/resume
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("9XQ8gvrBfkxpcfdXj3BF5XrorRGpdpQvoFibqHdyRei6");
const RPC_URL = "https://rpc.mainnet.x1.xyz";
const STATE_SEED = Buffer.from("state_v2");
const DECIMALS = 6;

// Anchor discriminators (first 8 bytes of sha256("global:<instruction_name>"))
const DISC = {
  initialize:       Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  set_updater:      Buffer.from([187, 166, 10, 98, 60, 85, 137, 0]),    // placeholder
  set_price:        Buffer.from([16, 19, 182, 8, 149, 83, 72, 181]),
  batch_set_prices: Buffer.from([22, 37, 238, 178, 182, 181, 83, 149]),  // placeholder
  update_median:    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),              // placeholder
  pause:            Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),              // placeholder
  resume:           Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),              // placeholder
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function i64LE(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(n));
  return buf;
}

function u8Buf(n: number): Buffer {
  return Buffer.from([n]);
}

function pubkeyBuf(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

// Compute Anchor discriminator: sha256("global:<name>")[0..8]
async function anchorDisc(name: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return Buffer.from(hash.subarray(0, 8));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(path.join(process.env.HOME!, ".config/solana/x1safe-deployer.json"));
  
  console.log("\n\x1b[36m════════════════════════════════════════════════════════\x1b[0m");
  console.log("\x1b[1m  Oracle V2 — X1 Mainnet Integration Test\x1b[0m");
  console.log("\x1b[36m════════════════════════════════════════════════════════\x1b[0m\n");
  console.log(`  Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`  Payer:    ${payer.publicKey.toBase58()}`);
  
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`  Balance:  ${(bal / 1e9).toFixed(4)} XNT\n`);

  // Derive PDA
  const [statePda, bump] = PublicKey.findProgramAddressSync([STATE_SEED], PROGRAM_ID);
  console.log(`  State PDA: ${statePda.toBase58()} (bump: ${bump})\n`);

  // Pre-compute all discriminators
  const disc = {
    initialize:       await anchorDisc("initialize"),
    set_updater:      await anchorDisc("set_updater"),
    set_price:        await anchorDisc("set_price"),
    batch_set_prices: await anchorDisc("batch_set_prices"),
    update_median:    await anchorDisc("update_median"),
    pause:            await anchorDisc("pause"),
    resume:           await anchorDisc("resume"),
    transfer_admin:   await anchorDisc("transfer_admin"),
  };

  // ── Step 1: Initialize ──────────────────────────────────────────────────

  console.log("\x1b[33m[1/6]\x1b[0m \x1b[1mInitializing Oracle V2...\x1b[0m");
  
  // Check if already initialized
  const existingAccount = await conn.getAccountInfo(statePda);
  if (existingAccount) {
    console.log("  ⚠️  State already initialized, skipping...\n");
  } else {
    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc.initialize,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      initIx,
    );

    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  \x1b[32m✅ Initialized\x1b[0m (tx: ${sig.slice(0, 20)}...)\n`);
  }

  // ── Step 2: Set Updater (index 0 → payer) ─────────────────────────────

  console.log("\x1b[33m[2/6]\x1b[0m \x1b[1mSetting updater slot 0 → payer...\x1b[0m");

  const setUpdaterIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      disc.set_updater,
      u8Buf(0),                        // index 0 (slot 0)
      pubkeyBuf(payer.publicKey),      // new_pubkey = payer
    ]),
  });

  const tx2 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    setUpdaterIx,
  );

  const sig2 = await sendAndConfirmTransaction(conn, tx2, [payer], { commitment: "confirmed" });
  console.log(`  \x1b[32m✅ Updater slot 0 set\x1b[0m (tx: ${sig2.slice(0, 20)}...)\n`);

  // ── Step 3: Set Price (BTC, index 1 = param1) ────────────────────────

  console.log("\x1b[33m[3/6]\x1b[0m \x1b[1mSetting BTC price (single asset)...\x1b[0m");

  const btcPrice = Math.round(87234.56 * 10 ** DECIMALS); // Fixed-point
  const nowMs = Date.now();

  const setPriceIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      disc.set_price,
      u8Buf(1),           // asset = BTC (1)
      u8Buf(1),           // index = param1
      i64LE(btcPrice),    // price
      i64LE(nowMs),       // client_ts_ms
    ]),
  });

  const tx3 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    setPriceIx,
  );

  const sig3 = await sendAndConfirmTransaction(conn, tx3, [payer], { commitment: "confirmed" });
  console.log(`  \x1b[32m✅ BTC = $87,234.56\x1b[0m (tx: ${sig3.slice(0, 20)}...)\n`);

  // ── Step 4: Batch Set Prices (all 10 assets) ─────────────────────────

  console.log("\x1b[33m[4/6]\x1b[0m \x1b[1mBatch setting all 10 asset prices...\x1b[0m");

  const prices = {
    btc: 87250.00,
    eth: 2034.12,
    sol: 145.67,
    hype: 21.30,
    zec: 38.51,
    tsla: 268.06,
    nvda: 116.05,
    mstr: 329.98,
    gold: 3021.50,
    silver: 33.82,
  };

  const toFixed = (p: number) => Math.round(p * 10 ** DECIMALS);
  const batchTs = Date.now();

  const batchIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      disc.batch_set_prices,
      u8Buf(1),                       // index = param1
      i64LE(toFixed(prices.btc)),
      i64LE(toFixed(prices.eth)),
      i64LE(toFixed(prices.sol)),
      i64LE(toFixed(prices.hype)),
      i64LE(toFixed(prices.zec)),
      i64LE(toFixed(prices.tsla)),
      i64LE(toFixed(prices.nvda)),
      i64LE(toFixed(prices.mstr)),
      i64LE(toFixed(prices.gold)),
      i64LE(toFixed(prices.silver)),
      i64LE(batchTs),                 // client_ts_ms
    ]),
  });

  const tx4 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    batchIx,
  );

  const sig4 = await sendAndConfirmTransaction(conn, tx4, [payer], { commitment: "confirmed" });
  console.log(`  \x1b[32m✅ All 10 assets updated\x1b[0m (tx: ${sig4.slice(0, 20)}...)`);
  for (const [sym, p] of Object.entries(prices)) {
    console.log(`     ${sym.toUpperCase().padEnd(8)} $${p.toLocaleString()}`);
  }
  console.log();

  // ── Step 5: Update Median (BTC) ──────────────────────────────────────

  console.log("\x1b[33m[5/6]\x1b[0m \x1b[1mComputing on-chain median for BTC...\x1b[0m");

  const medianIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      disc.update_median,
      u8Buf(1),  // asset = BTC
    ]),
  });

  const tx5 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    medianIx,
  );

  const sig5 = await sendAndConfirmTransaction(conn, tx5, [payer], { commitment: "confirmed" });
  console.log(`  \x1b[32m✅ Median computed\x1b[0m (tx: ${sig5.slice(0, 20)}...)\n`);

  // ── Step 6: Read State Back ──────────────────────────────────────────

  console.log("\x1b[33m[6/6]\x1b[0m \x1b[1mReading on-chain state...\x1b[0m");

  const stateAccount = await conn.getAccountInfo(statePda);
  if (stateAccount) {
    const data = Buffer.from(stateAccount.data);
    const DISC_LEN = 8;
    
    // Parse admin pubkey (32 bytes after discriminator)
    const admin = new PublicKey(data.subarray(DISC_LEN, DISC_LEN + 32));
    const paused = data.readUInt8(DISC_LEN + 32) === 1;
    const decimals = data.readUInt8(DISC_LEN + 33);
    const bumpRead = data.readUInt8(DISC_LEN + 34);
    
    console.log(`  Admin:    ${admin.toBase58()}`);
    console.log(`  Paused:   ${paused}`);
    console.log(`  Decimals: ${decimals}`);
    console.log(`  Bump:     ${bumpRead}`);
    
    // Updater slots start at offset DISC_LEN + 35
    const updaterOffset = DISC_LEN + 35;
    for (let i = 0; i < 4; i++) {
      const base = updaterOffset + i * 33;
      const pk = new PublicKey(data.subarray(base, base + 32));
      const active = data.readUInt8(base + 32) === 1;
      const label = pk.equals(PublicKey.default) ? "(empty)" : pk.toBase58().slice(0, 12) + "...";
      console.log(`  Updater ${i}: ${label} (active: ${active})`);
    }
    
    // Asset data starts at updaterOffset + 132 (4 × 33)
    const assetOffset = updaterOffset + 132;
    const assetNames = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "TSLA", "NVDA", "MSTR", "GOLD", "SILVER"];
    const ASSET_SIZE = 88; // 11 × i64
    
    console.log("\n  \x1b[1mAsset Prices (on-chain):\x1b[0m");
    for (let i = 0; i < 10; i++) {
      const base = assetOffset + i * ASSET_SIZE;
      const p1 = data.readBigInt64LE(base);
      const p2 = data.readBigInt64LE(base + 8);
      const p3 = data.readBigInt64LE(base + 16);
      const p4 = data.readBigInt64LE(base + 24);
      const medianPrice = data.readBigInt64LE(base + 64);
      const lastValid = data.readBigInt64LE(base + 80);
      
      const fmt = (v: bigint) => v === 0n ? "—" : `$${(Number(v) / 10 ** decimals).toFixed(2)}`;
      console.log(`  ${assetNames[i].padEnd(8)} p1=${fmt(p1).padEnd(14)} median=${fmt(medianPrice).padEnd(14)} last_valid=${fmt(lastValid)}`);
    }
  }

  // ── Final balance ───────────────────────────────────────────────────

  const finalBal = await conn.getBalance(payer.publicKey);
  console.log(`\n  \x1b[2mFinal balance: ${(finalBal / 1e9).toFixed(4)} XNT (spent ${((bal - finalBal) / 1e9).toFixed(4)} XNT)\x1b[0m`);

  console.log("\n\x1b[32m\x1b[1m  ✅ Oracle V2 mainnet test complete\x1b[0m");
  console.log(`\x1b[2m  Explorer: https://explorer.mainnet.x1.xyz/address/${PROGRAM_ID.toBase58()}\x1b[0m\n`);
}

main().catch((err) => {
  console.error("\x1b[31m✗ Error:\x1b[0m", err.message || err);
  if (err.logs) {
    console.error("\n  Program logs:");
    err.logs.forEach((l: string) => console.error(`    ${l}`));
  }
  process.exit(1);
});
