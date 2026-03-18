use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct UserInfo{
    pub owner: Pubkey,  // for validate/debug
    pub mint: Pubkey,
    pub staked_amount: u64, 
    pub pending_reward: u64,
    pub last_update_time: i64,
}

impl UserInfo {
    pub const INIT_SPACE: usize = 32 + 32 + 8 + 8 + 8;
}