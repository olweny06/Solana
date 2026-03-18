//Your code here
use anchor_lang::prelude::*;
use crate::{
    constant::BANK_INFO_SEED,
    state::BankInfo
};
#[derive(Accounts)]
pub struct TogglePause<'info>{
    #[account(
        mut,
        seeds = [BANK_INFO_SEED],
        bump,
    )]
    pub bank_info: Box<Account<'info, BankInfo>>,
    
    #[account(mut, address = bank_info.authority)]
    pub authority: Signer<'info>,
}

impl<'info> TogglePause<'info>{
    pub fn process(ctx: Context<TogglePause>) -> Result<()>{
        let bank = &mut ctx.accounts.bank_info;
        bank.is_paused = !bank.is_paused;
        Ok(())
    }
}