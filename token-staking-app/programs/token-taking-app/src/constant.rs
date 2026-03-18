use anchor_lang::prelude::*;

pub const STAKING_APR: u64 = 5; //5%
pub const SECONDS_PER_YEAR: u64 = 31_536_000;

pub const USER_INFO_SEED: &[u8] = b"USER_INFO";
pub const VAULT_AUTH_SEED: &[u8] = b"VAULT_AUTH";
