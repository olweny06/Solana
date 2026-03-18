use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer}
};

pub mod constant;
pub mod error;
pub mod instructions;
pub mod state; 
pub mod transfer_helper;

use instructions::*;

declare_id!("CQNVZxCegxwvFy3W5exvojnmZrKSyybPxmxeqTfGfxJo");

#[program]
pub mod token_taking_app {
    use super::*;
    
    pub fn stake_token(ctx: Context<StakeToken>, amount: u64, is_stake: bool) -> Result<()> {
        return StakeToken::process(ctx, amount, is_stake);
    }
}
