use anchor_lang::prelude::*;

declare_id!("9XQ8gvrBfkxpcfdXj3BF5XrorRGpdpQvoFibqHdyRei6");

/// Maximum price deviation allowed (20% = 2000 basis points)
const MAX_DEVIATION_BPS: u64 = 2000;

/// Maximum staleness for median calculation (30 seconds in milliseconds)
const MAX_STALENESS_MS: i64 = 30_000;

// ─── Asset Enum ─────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Asset {
    Btc = 1,
    Eth = 2,
    Sol = 3,
    Hype = 4,
    Zec = 5,
    Tsla = 6,
    Nvda = 7,
    Mstr = 8,
    Gold = 9,
    Silver = 10,
}

// ─── Program ────────────────────────────────────────────────────────────────

#[program]
pub mod oracle_v2 {
    use super::*;

    /// Initialize the oracle state PDA. Caller becomes admin.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.admin = ctx.accounts.payer.key();
        s.paused = false;
        s.decimals = 6;
        s.bump = ctx.bumps.state;

        // Zero-initialize all updater slots
        s.updaters = [UpdaterSlot {
            pubkey: Pubkey::default(),
            active: false,
        }; 4];

        // Zero-initialize all asset data
        s.btc = AssetData::default();
        s.eth = AssetData::default();
        s.sol = AssetData::default();
        s.hype = AssetData::default();
        s.zec = AssetData::default();
        s.tsla = AssetData::default();
        s.nvda = AssetData::default();
        s.mstr = AssetData::default();
        s.gold = AssetData::default();
        s.silver = AssetData::default();

        emit!(OracleInitialized {
            admin: s.admin,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    // ─── Admin: Dynamic Key Management ──────────────────────────────────

    /// Set an updater pubkey at the given slot index (0..3). Admin only.
    pub fn set_updater(ctx: Context<AdminOnly>, index: u8, new_pubkey: Pubkey) -> Result<()> {
        require!(index < 4, OracleError::BadIndex);
        let s = &mut ctx.accounts.state;

        s.updaters[index as usize] = UpdaterSlot {
            pubkey: new_pubkey,
            active: true,
        };

        emit!(UpdaterChanged {
            index,
            pubkey: new_pubkey,
            active: true,
        });

        Ok(())
    }

    /// Remove (deactivate) an updater at the given slot index. Admin only.
    pub fn remove_updater(ctx: Context<AdminOnly>, index: u8) -> Result<()> {
        require!(index < 4, OracleError::BadIndex);
        let s = &mut ctx.accounts.state;

        let old_pubkey = s.updaters[index as usize].pubkey;
        s.updaters[index as usize].active = false;

        emit!(UpdaterChanged {
            index,
            pubkey: old_pubkey,
            active: false,
        });

        Ok(())
    }

    // ─── Admin: Circuit Breaker ─────────────────────────────────────────

    /// Pause the oracle — blocks set_price and batch_set_prices. Admin only.
    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.paused = true;

        emit!(CircuitBreaker {
            paused: true,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    /// Resume the oracle. Admin only.
    pub fn resume(ctx: Context<AdminOnly>) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.paused = false;

        emit!(CircuitBreaker {
            paused: false,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    // ─── Price Updates ──────────────────────────────────────────────────

    /// Update a single asset price for a given parameter index (1..4).
    /// Enforces: circuit breaker, signer authorization, and ±20% price bounds.
    pub fn set_price(
        ctx: Context<SetPrice>,
        asset: u8,
        index: u8,
        price: i64,
        client_ts_ms: i64,
    ) -> Result<()> {
        let s = &mut ctx.accounts.state;

        // Circuit breaker check
        require!(!s.paused, OracleError::OraclePaused);

        // Validate index (1-based: param1..param4)
        require!(index >= 1 && index <= 4, OracleError::BadIndex);

        // Authorize signer against dynamic updater slots
        let slot_idx = (index - 1) as usize;
        let updater = &s.updaters[slot_idx];
        require!(updater.active, OracleError::UpdaterNotActive);
        require_keys_eq!(
            ctx.accounts.signer.key(),
            updater.pubkey,
            OracleError::UnauthorizedForIndex
        );

        // Resolve the asset data reference
        let asset_data = get_asset_mut(s, asset)?;

        // Price bounds check: reject if deviation > 20% from last_valid_price
        // Skip if last_valid_price is 0 (first update)
        if asset_data.last_valid_price != 0 {
            check_price_bounds(price, asset_data.last_valid_price)?;
        }

        // Write the price + timestamp to the correct param slot
        match index {
            1 => {
                asset_data.param1 = price;
                asset_data.ts1 = client_ts_ms;
            }
            2 => {
                asset_data.param2 = price;
                asset_data.ts2 = client_ts_ms;
            }
            3 => {
                asset_data.param3 = price;
                asset_data.ts3 = client_ts_ms;
            }
            4 => {
                asset_data.param4 = price;
                asset_data.ts4 = client_ts_ms;
            }
            _ => unreachable!(),
        }

        // Update last_valid_price on successful write
        asset_data.last_valid_price = price;

        emit!(PriceUpdated {
            asset,
            index,
            price,
            decimals: s.decimals,
            client_ts_ms,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    /// Batch-update all 10 assets for a single parameter index.
    /// Same guards as set_price (circuit breaker, auth, bounds per asset).
    pub fn batch_set_prices(
        ctx: Context<SetPrice>,
        index: u8,
        btc_price: i64,
        eth_price: i64,
        sol_price: i64,
        hype_price: i64,
        zec_price: i64,
        tsla_price: i64,
        nvda_price: i64,
        mstr_price: i64,
        gold_price: i64,
        silver_price: i64,
        client_ts_ms: i64,
    ) -> Result<()> {
        let s = &mut ctx.accounts.state;

        // Circuit breaker
        require!(!s.paused, OracleError::OraclePaused);

        // Validate index
        require!(index >= 1 && index <= 4, OracleError::BadIndex);

        // Auth check
        let slot_idx = (index - 1) as usize;
        let updater = &s.updaters[slot_idx];
        require!(updater.active, OracleError::UpdaterNotActive);
        require_keys_eq!(
            ctx.accounts.signer.key(),
            updater.pubkey,
            OracleError::UnauthorizedForIndex
        );

        let slot = Clock::get()?.slot;
        let decimals = s.decimals;

        // Helper macro: bounds-check, write, emit — per asset
        macro_rules! update_asset {
            ($field:ident, $price:expr, $asset_id:expr) => {
                // Bounds check (skip if first update)
                if s.$field.last_valid_price != 0 {
                    check_price_bounds($price, s.$field.last_valid_price)?;
                }
                // Write param + timestamp
                match index {
                    1 => {
                        s.$field.param1 = $price;
                        s.$field.ts1 = client_ts_ms;
                    }
                    2 => {
                        s.$field.param2 = $price;
                        s.$field.ts2 = client_ts_ms;
                    }
                    3 => {
                        s.$field.param3 = $price;
                        s.$field.ts3 = client_ts_ms;
                    }
                    4 => {
                        s.$field.param4 = $price;
                        s.$field.ts4 = client_ts_ms;
                    }
                    _ => unreachable!(),
                }
                // Update last valid
                s.$field.last_valid_price = $price;
                // Emit event
                emit!(PriceUpdated {
                    asset: $asset_id,
                    index,
                    price: $price,
                    decimals,
                    client_ts_ms,
                    slot,
                });
            };
        }

        update_asset!(btc, btc_price, Asset::Btc as u8);
        update_asset!(eth, eth_price, Asset::Eth as u8);
        update_asset!(sol, sol_price, Asset::Sol as u8);
        update_asset!(hype, hype_price, Asset::Hype as u8);
        update_asset!(zec, zec_price, Asset::Zec as u8);
        update_asset!(tsla, tsla_price, Asset::Tsla as u8);
        update_asset!(nvda, nvda_price, Asset::Nvda as u8);
        update_asset!(mstr, mstr_price, Asset::Mstr as u8);
        update_asset!(gold, gold_price, Asset::Gold as u8);
        update_asset!(silver, silver_price, Asset::Silver as u8);

        Ok(())
    }

    // ─── Permissionless: On-Chain Median ────────────────────────────────

    /// Compute the median price for a given asset from up to 4 params.
    /// Skips params whose timestamp is >30s stale (using Clock sysvar).
    /// Anyone can call this — it's permissionless.
    pub fn update_median(ctx: Context<UpdateMedian>, asset: u8) -> Result<()> {
        let s = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        let now_ms = clock.unix_timestamp * 1000; // Convert seconds → ms

        let asset_data = get_asset_mut(s, asset)?;

        // Collect non-stale prices
        let mut fresh_prices: Vec<i64> = Vec::with_capacity(4);

        let params = [
            (asset_data.param1, asset_data.ts1),
            (asset_data.param2, asset_data.ts2),
            (asset_data.param3, asset_data.ts3),
            (asset_data.param4, asset_data.ts4),
        ];

        for (price, ts) in params.iter() {
            // Skip zero prices (uninitialized) and stale data
            if *price != 0 && *ts != 0 && (now_ms - *ts) <= MAX_STALENESS_MS {
                fresh_prices.push(*price);
            }
        }

        // Need at least 1 fresh price to compute median
        require!(!fresh_prices.is_empty(), OracleError::NoFreshPrices);

        // Sort for median
        fresh_prices.sort();
        let len = fresh_prices.len();
        let median = if len % 2 == 0 {
            // Average of two middle values
            (fresh_prices[len / 2 - 1] + fresh_prices[len / 2]) / 2
        } else {
            fresh_prices[len / 2]
        };

        asset_data.median_price = median;
        asset_data.median_ts = now_ms;

        emit!(MedianUpdated {
            asset,
            median_price: median,
            sources_used: len as u8,
            slot: clock.slot,
        });

        Ok(())
    }

    // ─── Admin: Transfer Admin ──────────────────────────────────────────

    /// Transfer admin role to a new pubkey. Admin only.
    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        let s = &mut ctx.accounts.state;
        let old = s.admin;
        s.admin = new_admin;

        emit!(AdminTransferred {
            old_admin: old,
            new_admin,
        });

        Ok(())
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Returns a mutable reference to the AssetData for the given asset ID.
fn get_asset_mut(state: &mut OracleState, asset: u8) -> Result<&mut AssetData> {
    match asset {
        x if x == Asset::Btc as u8 => Ok(&mut state.btc),
        x if x == Asset::Eth as u8 => Ok(&mut state.eth),
        x if x == Asset::Sol as u8 => Ok(&mut state.sol),
        x if x == Asset::Hype as u8 => Ok(&mut state.hype),
        x if x == Asset::Zec as u8 => Ok(&mut state.zec),
        x if x == Asset::Tsla as u8 => Ok(&mut state.tsla),
        x if x == Asset::Nvda as u8 => Ok(&mut state.nvda),
        x if x == Asset::Mstr as u8 => Ok(&mut state.mstr),
        x if x == Asset::Gold as u8 => Ok(&mut state.gold),
        x if x == Asset::Silver as u8 => Ok(&mut state.silver),
        _ => err!(OracleError::BadAsset),
    }
}

/// Check that a new price is within ±20% of the last valid price.
fn check_price_bounds(new_price: i64, last_valid: i64) -> Result<()> {
    let abs_last = (last_valid as i128).unsigned_abs();
    let abs_diff = ((new_price as i128) - (last_valid as i128)).unsigned_abs();

    // deviation_bps = abs_diff * 10000 / abs_last
    let deviation_bps = abs_diff
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(abs_last))
        .unwrap_or(u128::MAX);

    require!(
        deviation_bps <= MAX_DEVIATION_BPS as u128,
        OracleError::PriceDeviationTooLarge
    );

    Ok(())
}

// ─── State Accounts ─────────────────────────────────────────────────────────

#[account]
pub struct OracleState {
    pub admin: Pubkey,              // 32
    pub paused: bool,               // 1
    pub decimals: u8,               // 1
    pub bump: u8,                   // 1
    pub updaters: [UpdaterSlot; 4], // 4 × 33 = 132
    pub btc: AssetData,             // 88
    pub eth: AssetData,             // 88
    pub sol: AssetData,             // 88
    pub hype: AssetData,            // 88
    pub zec: AssetData,             // 88
    pub tsla: AssetData,            // 88
    pub nvda: AssetData,            // 88
    pub mstr: AssetData,            // 88
    pub gold: AssetData,            // 88
    pub silver: AssetData,          // 88
}

impl OracleState {
    // 8 (discriminator) + 32 + 1 + 1 + 1 + 132 + (88 × 10) = 8 + 167 + 880 = 1055
    pub const SIZE: usize = 8 + 32 + 1 + 1 + 1 + (UpdaterSlot::SIZE * 4) + (AssetData::SIZE * 10);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct UpdaterSlot {
    pub pubkey: Pubkey, // 32
    pub active: bool,   // 1
}

impl UpdaterSlot {
    pub const SIZE: usize = 32 + 1; // 33
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct AssetData {
    pub param1: i64,           // 8  — price from updater 1
    pub param2: i64,           // 8  — price from updater 2
    pub param3: i64,           // 8  — price from updater 3
    pub param4: i64,           // 8  — price from updater 4
    pub ts1: i64,              // 8  — timestamp for param1
    pub ts2: i64,              // 8  — timestamp for param2
    pub ts3: i64,              // 8  — timestamp for param3
    pub ts4: i64,              // 8  — timestamp for param4
    pub median_price: i64,     // 8  — computed on-chain median
    pub median_ts: i64,        // 8  — when median was last updated
    pub last_valid_price: i64, // 8  — last accepted price (for bounds)
}

impl AssetData {
    pub const SIZE: usize = 8 * 11; // 88 bytes
}

// ─── Account Constraints ────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = OracleState::SIZE,
        seeds = [b"state_v2"],
        bump,
    )]
    pub state: Account<'info, OracleState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Admin-only instructions: pause, resume, set_updater, remove_updater, transfer_admin
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"state_v2"],
        bump = state.bump,
        has_one = admin @ OracleError::Unauthorized,
    )]
    pub state: Account<'info, OracleState>,
    pub admin: Signer<'info>,
}

/// Price update instructions (set_price, batch_set_prices)
#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(
        mut,
        seeds = [b"state_v2"],
        bump = state.bump,
    )]
    pub state: Account<'info, OracleState>,
    pub signer: Signer<'info>,
}

/// Permissionless median update — anyone can crank this
#[derive(Accounts)]
pub struct UpdateMedian<'info> {
    #[account(
        mut,
        seeds = [b"state_v2"],
        bump = state.bump,
    )]
    pub state: Account<'info, OracleState>,
}

// ─── Events ─────────────────────────────────────────────────────────────────

#[event]
pub struct OracleInitialized {
    pub admin: Pubkey,
    pub slot: u64,
}

#[event]
pub struct PriceUpdated {
    pub asset: u8,
    pub index: u8,
    pub price: i64,
    pub decimals: u8,
    pub client_ts_ms: i64,
    pub slot: u64,
}

#[event]
pub struct MedianUpdated {
    pub asset: u8,
    pub median_price: i64,
    pub sources_used: u8,
    pub slot: u64,
}

#[event]
pub struct UpdaterChanged {
    pub index: u8,
    pub pubkey: Pubkey,
    pub active: bool,
}

#[event]
pub struct CircuitBreaker {
    pub paused: bool,
    pub slot: u64,
}

#[event]
pub struct AdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum OracleError {
    #[msg("Unauthorized — caller is not admin")]
    Unauthorized,

    #[msg("Invalid asset ID (must be 1-10: BTC/ETH/SOL/HYPE/ZEC/TSLA/NVDA/MSTR/GOLD/SILVER)")]
    BadAsset,

    #[msg("Invalid index (param index must be 1-4, updater slot 0-3)")]
    BadIndex,

    #[msg("Signer is not the authorized updater for this index")]
    UnauthorizedForIndex,

    #[msg("Updater slot is not active")]
    UpdaterNotActive,

    #[msg("Oracle is paused — price updates blocked")]
    OraclePaused,

    #[msg("Price deviation exceeds ±20% of last valid price")]
    PriceDeviationTooLarge,

    #[msg("No fresh prices available for median (all stale or zero)")]
    NoFreshPrices,
}
