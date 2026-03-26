//! # Oracle Vault Program
//!
//! A price oracle for X1/Solana that authenticates price submissions via
//! Ed25519 signatures produced by OpenBao Transit (HSM-style signing).
//!
//! ## Key design decisions
//!
//! - **Any wallet** can submit a price; the submitter only pays tx fees.
//!   Authorization is proved by a valid Ed25519 signature from the configured
//!   OpenBao Transit key — not by checking the submitter's pubkey.
//!
//! - Signature verification is performed by requiring that an
//!   `Ed25519SigVerify` pre-instruction is present in the **same transaction**
//!   and that its fields (pubkey, message, signature) match the expected values.
//!   Solana's runtime enforces the actual crypto; this program just checks the
//!   bookkeeping.
//!
//! - 6 assets, 5 relay slots each (matching 5 Docker relay containers).
//!
//! - Message format:  `"ASSET:PRICE:TIMESTAMP"`
//!   e.g.  `"BTC:71200000000:1711234567890"`
//!   where PRICE is already the 6-decimal integer form.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    sysvar::instructions::{self as ix_sysvar, load_instruction_at_checked},
};

declare_id!("9mPmjK8NxJadYDiHiYAQH4WFCnKJr7ZV8ria63ZkMtv2");

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

/// PDA seed for the single oracle state account.
pub const ORACLE_SEED: &[u8] = b"oracle_vault_v1";

/// Number of price decimals (prices are stored as integer × 10^6).
pub const DECIMALS: u8 = 6;

/// Number of relay slots supported.
pub const NUM_SLOTS: usize = 5;

/// Number of assets tracked.
pub const NUM_ASSETS: usize = 6;

// ─────────────────────────────────────────────────────────────────────────────
//  Data types
// ─────────────────────────────────────────────────────────────────────────────

/// Prices and timestamps for one asset across all relay slots.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PriceSlots {
    /// Price for each relay slot (6-decimal integer).
    pub prices: [i64; NUM_SLOTS],
    /// Unix-ms timestamp of the last update for each slot.
    pub timestamps: [i64; NUM_SLOTS],
}

/// Asset discriminant.  Values 1-6 match the on-chain enum.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Asset {
    Btc = 1,
    Eth = 2,
    Sol = 3,
    Hype = 4,
    Zec = 5,
    Fartcoin = 6,
}

impl Asset {
    /// Human-readable ticker used in the signed message string.
    pub fn ticker(&self) -> &'static str {
        match self {
            Asset::Btc => "BTC",
            Asset::Eth => "ETH",
            Asset::Sol => "SOL",
            Asset::Hype => "HYPE",
            Asset::Zec => "ZEC",
            Asset::Fartcoin => "FARTCOIN",
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Asset::Btc),
            2 => Some(Asset::Eth),
            3 => Some(Asset::Sol),
            4 => Some(Asset::Hype),
            5 => Some(Asset::Zec),
            6 => Some(Asset::Fartcoin),
            _ => None,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  State account
// ─────────────────────────────────────────────────────────────────────────────

/// The single PDA that holds all oracle state.
/// Seeds: [b"oracle_vault_v1"]
#[account]
pub struct OracleState {
    /// Admin pubkey — can update `oracle_pubkey` or close the account.
    pub admin: Pubkey,

    /// Raw 32-byte Ed25519 public key exported from OpenBao Transit.
    /// All price messages must be signed by the corresponding private key.
    pub oracle_pubkey: [u8; 32],

    /// Always DECIMALS (6).  Stored here so consumers don't need the IDL.
    pub decimals: u8,

    /// PDA bump, stored for cheap CPI re-derivation.
    pub bump: u8,

    // ── Price data ──────────────────────────────────────────────────────────
    pub btc: PriceSlots,
    pub eth: PriceSlots,
    pub sol: PriceSlots,
    pub hype: PriceSlots,
    pub zec: PriceSlots,
    pub fartcoin: PriceSlots,
}

impl OracleState {
    /// Mutable reference to the PriceSlots for a given asset.
    pub fn slots_mut(&mut self, asset: &Asset) -> &mut PriceSlots {
        match asset {
            Asset::Btc => &mut self.btc,
            Asset::Eth => &mut self.eth,
            Asset::Sol => &mut self.sol,
            Asset::Hype => &mut self.hype,
            Asset::Zec => &mut self.zec,
            Asset::Fartcoin => &mut self.fartcoin,
        }
    }

    /// Immutable reference to the PriceSlots for a given asset.
    pub fn slots(&self, asset: &Asset) -> &PriceSlots {
        match asset {
            Asset::Btc => &self.btc,
            Asset::Eth => &self.eth,
            Asset::Sol => &self.sol,
            Asset::Hype => &self.hype,
            Asset::Zec => &self.zec,
            Asset::Fartcoin => &self.fartcoin,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Events
// ─────────────────────────────────────────────────────────────────────────────

#[event]
pub struct PriceSubmitted {
    /// Asset discriminant (1–6).
    pub asset: u8,
    /// Relay slot index (1–5).
    pub index: u8,
    /// Price in 6-decimal integer form.
    pub price: i64,
    /// Always 6.
    pub decimals: u8,
    /// Unix-ms timestamp supplied by the relay.
    pub timestamp: i64,
    /// Current Solana slot at time of submission.
    pub slot: u64,
    /// Whether the Ed25519 pre-instruction verified successfully.
    pub verified: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum OracleError {
    #[msg("Caller is not the admin")]
    Unauthorized,
    #[msg("Asset discriminant is out of range (must be 1–6)")]
    InvalidAsset,
    #[msg("Relay index is out of range (must be 1–5)")]
    InvalidIndex,
    #[msg("No Ed25519SigVerify instruction found in this transaction")]
    MissingEd25519Instruction,
    #[msg("Ed25519 instruction pubkey does not match the stored oracle key")]
    PubkeyMismatch,
    #[msg("Ed25519 instruction message does not match the expected message")]
    MessageMismatch,
    #[msg("Ed25519 instruction data is malformed")]
    MalformedEd25519Data,
    #[msg("Batch prices array must contain exactly 6 entries (one per asset)")]
    InvalidBatchLength,
    #[msg("Timestamp must be positive")]
    InvalidTimestamp,
    #[msg("Price must be non-negative")]
    InvalidPrice,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Account contexts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + OracleState::INIT_SPACE,
        seeds = [ORACLE_SEED],
        bump,
    )]
    pub state: Account<'info, OracleState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOracleKey<'info> {
    #[account(
        mut,
        seeds = [ORACLE_SEED],
        bump = state.bump,
    )]
    pub state: Account<'info, OracleState>,

    /// Must be the current admin.
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitPrice<'info> {
    #[account(
        mut,
        seeds = [ORACLE_SEED],
        bump = state.bump,
    )]
    pub state: Account<'info, OracleState>,

    /// The relay wallet — only pays tx fees; no authority check.
    #[account(mut)]
    pub relay: Signer<'info>,

    /// Solana instructions sysvar — used to introspect the Ed25519 pre-ix.
    /// CHECK: this is a read-only sysvar, validated by its address constraint
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: parse the Ed25519SigVerify instruction
// ─────────────────────────────────────────────────────────────────────────────

/// Parsed fields extracted from an Ed25519SigVerify instruction.
struct Ed25519SigEntry {
    pubkey: [u8; 32],
    #[allow(dead_code)] // stored for potential future on-chain re-verification
    signature: [u8; 64],
    message: Vec<u8>,
}

/// Walk the instructions sysvar looking for an Ed25519SigVerify instruction.
/// Returns the first matching entry (most transactions only have one).
///
/// Layout of the Ed25519SigVerify instruction data:
/// ```text
/// [0]     u8  num_signatures
/// [1]     u8  padding
/// Per entry (14 bytes each, starting at offset 2):
///   [0..2]   u16 sig_offset          (into this ix's data)
///   [2..4]   u16 sig_ix_index        (0xFFFF = this ix's data)
///   [4..6]   u16 pubkey_offset
///   [6..8]   u16 pubkey_ix_index
///   [8..10]  u16 msg_offset
///   [10..12] u16 msg_size
///   [12..14] u16 msg_ix_index
/// After all entries: raw pubkey (32) + raw signature (64) + raw message (N)
/// ```
fn find_ed25519_sig_entry(
    instructions_sysvar: &UncheckedAccount,
) -> Result<Ed25519SigEntry> {
    // Scan up to 8 instructions in the transaction.
    for ix_index in 0u8..8 {
        let ix = match load_instruction_at_checked(ix_index as usize, &instructions_sysvar.to_account_info()) {
            Ok(ix) => ix,
            Err(_) => break, // no more instructions
        };

        if ix.program_id != ed25519_program::ID {
            continue;
        }

        let data = ix.data.as_slice();

        // Minimum: 2-byte header + 14-byte entry = 16 total.
        if data.len() < 16 {
            return Err(OracleError::MalformedEd25519Data.into());
        }

        let _num_sigs = data[0];
        // data[1] = padding byte

        // Parse the first signature entry (starts at offset 2, 14 bytes).
        let entry_base = 2usize;
        let sig_offset    = u16::from_le_bytes([data[entry_base],     data[entry_base + 1]]) as usize;
        let sig_ix        = u16::from_le_bytes([data[entry_base + 2], data[entry_base + 3]]);
        let pubkey_offset = u16::from_le_bytes([data[entry_base + 4], data[entry_base + 5]]) as usize;
        let pubkey_ix     = u16::from_le_bytes([data[entry_base + 6], data[entry_base + 7]]);
        let msg_offset    = u16::from_le_bytes([data[entry_base + 8], data[entry_base + 9]]) as usize;
        let msg_size      = u16::from_le_bytes([data[entry_base + 10], data[entry_base + 11]]) as usize;
        let msg_ix        = u16::from_le_bytes([data[entry_base + 12], data[entry_base + 13]]);

        // 0xFFFF means "same instruction's data"; we only handle that case here.
        if sig_ix != 0xFFFF || pubkey_ix != 0xFFFF || msg_ix != 0xFFFF {
            continue;
        }

        // Bounds-check all three fields.
        if sig_offset + 64 > data.len()
            || pubkey_offset + 32 > data.len()
            || msg_offset + msg_size > data.len()
        {
            return Err(OracleError::MalformedEd25519Data.into());
        }

        let mut signature = [0u8; 64];
        signature.copy_from_slice(&data[sig_offset..sig_offset + 64]);

        let mut pubkey = [0u8; 32];
        pubkey.copy_from_slice(&data[pubkey_offset..pubkey_offset + 32]);

        let message = data[msg_offset..msg_offset + msg_size].to_vec();

        return Ok(Ed25519SigEntry { pubkey, signature, message });
    }

    Err(OracleError::MissingEd25519Instruction.into())
}

/// Verify that the Ed25519SigVerify pre-instruction in this transaction used:
/// - the oracle's stored public key
/// - the expected message bytes
///
/// Solana's runtime already verified the actual cryptographic signature before
/// our program even runs, so we only need to check the bookkeeping fields.
fn verify_ed25519_preinstruction(
    instructions_sysvar: &UncheckedAccount,
    oracle_pubkey: &[u8; 32],
    expected_message: &[u8],
) -> Result<()> {
    let entry = find_ed25519_sig_entry(instructions_sysvar)?;

    if &entry.pubkey != oracle_pubkey {
        return Err(OracleError::PubkeyMismatch.into());
    }

    if entry.message != expected_message {
        return Err(OracleError::MessageMismatch.into());
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
//  Program
// ─────────────────────────────────────────────────────────────────────────────

#[program]
pub mod oracle_vault {
    use super::*;

    // ── initialize ───────────────────────────────────────────────────────────

    /// Create the oracle state PDA.
    ///
    /// # Arguments
    /// * `oracle_pubkey` — raw 32-byte Ed25519 public key from OpenBao Transit.
    pub fn initialize(ctx: Context<Initialize>, oracle_pubkey: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.admin = ctx.accounts.admin.key();
        state.oracle_pubkey = oracle_pubkey;
        state.decimals = DECIMALS;
        state.bump = ctx.bumps.state;
        msg!("Oracle Vault initialized. Admin: {}", state.admin);
        Ok(())
    }

    // ── set_oracle_key ────────────────────────────────────────────────────────

    /// Admin-only: rotate the OpenBao Transit Ed25519 public key.
    pub fn set_oracle_key(ctx: Context<SetOracleKey>, new_pubkey: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(
            ctx.accounts.admin.key() == state.admin,
            OracleError::Unauthorized
        );
        state.oracle_pubkey = new_pubkey;
        msg!("Oracle pubkey updated by admin");
        Ok(())
    }

    // ── submit_price ─────────────────────────────────────────────────────────

    /// Submit a single-asset price for one relay slot.
    ///
    /// The transaction **must** include an `Ed25519SigVerify` instruction
    /// (typically at index 0) that signs the message:
    /// `"ASSET:PRICE:TIMESTAMP"` using the oracle's private key.
    ///
    /// # Arguments
    /// * `asset`     — Asset discriminant (1–6).
    /// * `index`     — Relay slot (1–5).
    /// * `price`     — Price in 6-decimal integer form (must be ≥ 0).
    /// * `timestamp` — Unix-ms timestamp (must be > 0).
    /// * `signature` — 64-byte Ed25519 signature (for event logging only;
    ///                 Solana already verified it via the pre-instruction).
    /// * `message`   — The exact bytes that were signed, e.g. `b"BTC:71200000000:1711234567890"`.
    pub fn submit_price(
        ctx: Context<SubmitPrice>,
        asset: u8,
        index: u8,
        price: i64,
        timestamp: i64,
        _signature: [u8; 64],   // logged / forwarded; crypto already verified
        message: Vec<u8>,
    ) -> Result<()> {
        require!(price >= 0, OracleError::InvalidPrice);
        require!(timestamp > 0, OracleError::InvalidTimestamp);

        let asset_enum = Asset::from_u8(asset).ok_or(OracleError::InvalidAsset)?;
        let slot_idx = validate_index(index)?;

        // ── Ed25519 pre-instruction check ───────────────────────────────────
        let state = &ctx.accounts.state;
        verify_ed25519_preinstruction(
            &ctx.accounts.instructions_sysvar,
            &state.oracle_pubkey,
            &message,
        )?;

        // ── Optional: verify message format matches our expectations ────────
        let expected_msg = build_message(&asset_enum, price, timestamp);
        require!(
            message == expected_msg,
            OracleError::MessageMismatch
        );

        // ── Write price ──────────────────────────────────────────────────────
        let state = &mut ctx.accounts.state;
        let slots = state.slots_mut(&asset_enum);
        slots.prices[slot_idx] = price;
        slots.timestamps[slot_idx] = timestamp;

        emit!(PriceSubmitted {
            asset,
            index,
            price,
            decimals: DECIMALS,
            timestamp,
            slot: Clock::get()?.slot,
            verified: true,
        });

        msg!(
            "Price submitted: {} = {} (slot {})",
            asset_enum.ticker(),
            price,
            index
        );
        Ok(())
    }

    // ── batch_submit_prices ──────────────────────────────────────────────────

    /// Submit prices for **all 6 assets** in a single transaction for one slot.
    ///
    /// The Ed25519 pre-instruction must sign the combined message:
    /// `"BATCH:<idx>:<btc_price>:<eth_price>:<sol_price>:<hype_price>:<zec_price>:<fartcoin_price>:<timestamp>"`
    ///
    /// # Arguments
    /// * `index`     — Relay slot (1–5).
    /// * `prices`    — `[btc, eth, sol, hype, zec, fartcoin]` (6-decimal integers).
    /// * `timestamp` — Unix-ms timestamp.
    /// * `_signature` — 64-byte Ed25519 signature (for reference; already verified).
    /// * `message`   — The exact bytes that were signed.
    pub fn batch_submit_prices(
        ctx: Context<SubmitPrice>,
        index: u8,
        prices: Vec<i64>,
        timestamp: i64,
        _signature: [u8; 64],
        message: Vec<u8>,
    ) -> Result<()> {
        require!(prices.len() == NUM_ASSETS, OracleError::InvalidBatchLength);
        require!(timestamp > 0, OracleError::InvalidTimestamp);
        for &p in &prices {
            require!(p >= 0, OracleError::InvalidPrice);
        }

        let slot_idx = validate_index(index)?;

        // ── Ed25519 pre-instruction check ────────────────────────────────────
        let state = &ctx.accounts.state;
        verify_ed25519_preinstruction(
            &ctx.accounts.instructions_sysvar,
            &state.oracle_pubkey,
            &message,
        )?;

        // ── Verify batch message format ──────────────────────────────────────
        let expected_msg = build_batch_message(index, &prices, timestamp);
        require!(
            message == expected_msg,
            OracleError::MessageMismatch
        );

        // ── Write all prices ─────────────────────────────────────────────────
        let state = &mut ctx.accounts.state;
        let asset_order = [
            Asset::Btc,
            Asset::Eth,
            Asset::Sol,
            Asset::Hype,
            Asset::Zec,
            Asset::Fartcoin,
        ];

        let current_slot = Clock::get()?.slot;

        for (i, asset_enum) in asset_order.iter().enumerate() {
            let p = prices[i];
            let slots = state.slots_mut(asset_enum);
            slots.prices[slot_idx] = p;
            slots.timestamps[slot_idx] = timestamp;

            emit!(PriceSubmitted {
                asset: i as u8 + 1,
                index,
                price: p,
                decimals: DECIMALS,
                timestamp,
                slot: current_slot,
                verified: true,
            });
        }

        msg!("Batch prices submitted for relay slot {}", index);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Space calculation for OracleState
// ─────────────────────────────────────────────────────────────────────────────

impl OracleState {
    /// Discriminator (8) + admin (32) + oracle_pubkey (32) + decimals (1) +
    /// bump (1) + 6 × PriceSlots (6 × 80 = 480) = 554 bytes.
    /// Add a 64-byte buffer for future fields.
    pub const INIT_SPACE: usize = 32  // admin
        + 32  // oracle_pubkey
        + 1   // decimals
        + 1   // bump
        + 6 * (8 * NUM_SLOTS + 8 * NUM_SLOTS)  // 6 assets × (prices + timestamps)
        + 64; // future padding
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utility functions
// ─────────────────────────────────────────────────────────────────────────────

/// Convert 1-based relay index to 0-based array index, with bounds check.
fn validate_index(index: u8) -> Result<usize> {
    if index < 1 || index as usize > NUM_SLOTS {
        return Err(OracleError::InvalidIndex.into());
    }
    Ok((index - 1) as usize)
}

/// Build the canonical signed message for a single-asset price submission.
/// Format: `"ASSET:PRICE:TIMESTAMP"`
pub fn build_message(asset: &Asset, price: i64, timestamp: i64) -> Vec<u8> {
    format!("{}:{}:{}", asset.ticker(), price, timestamp)
        .into_bytes()
}

/// Build the canonical signed message for a batch submission.
/// Format: `"BATCH:<index>:<btc>:<eth>:<sol>:<hype>:<zec>:<fartcoin>:<timestamp>"`
pub fn build_batch_message(index: u8, prices: &[i64], timestamp: i64) -> Vec<u8> {
    format!(
        "BATCH:{}:{}:{}:{}:{}:{}:{}:{}",
        index,
        prices[0], prices[1], prices[2],
        prices[3], prices[4], prices[5],
        timestamp
    )
    .into_bytes()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests (unit tests — no runtime needed)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_message() {
        let msg = build_message(&Asset::Btc, 71200000000, 1711234567890);
        assert_eq!(msg, b"BTC:71200000000:1711234567890");
    }

    #[test]
    fn test_build_batch_message() {
        let prices = vec![
            71200000000i64,
            3500000000i64,
            150000000i64,
            25000000i64,
            3000000i64,
            1000000i64,
        ];
        let msg = build_batch_message(3, &prices, 1711234567890);
        assert_eq!(
            msg,
            b"BATCH:3:71200000000:3500000000:150000000:25000000:3000000:1000000:1711234567890"
        );
    }

    #[test]
    fn test_validate_index() {
        assert!(validate_index(0).is_err());
        assert!(validate_index(1).is_ok());
        assert_eq!(validate_index(1).unwrap(), 0);
        assert_eq!(validate_index(5).unwrap(), 4);
        assert!(validate_index(6).is_err());
    }

    #[test]
    fn test_asset_from_u8() {
        assert_eq!(Asset::from_u8(1), Some(Asset::Btc));
        assert_eq!(Asset::from_u8(6), Some(Asset::Fartcoin));
        assert_eq!(Asset::from_u8(0), None);
        assert_eq!(Asset::from_u8(7), None);
    }

    #[test]
    fn test_asset_tickers() {
        assert_eq!(Asset::Btc.ticker(), "BTC");
        assert_eq!(Asset::Fartcoin.ticker(), "FARTCOIN");
    }

    #[test]
    fn test_oracle_state_space() {
        // Confirm the space constant is big enough for the struct.
        // Discriminator handled separately by Anchor.
        let expected_min = 32 + 32 + 1 + 1 + 6 * (5 * 8 + 5 * 8);
        assert!(OracleState::INIT_SPACE >= expected_min);
    }
}
