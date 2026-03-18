use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constant::{BANK_INFO_SEED, BANK_VAULT_SEED},
    error::BankAppError,
    state::BankInfo,
};

use token_taking_app::{cpi, program::TokenTakingApp};

#[derive(Accounts)]
pub struct InvestToken<'info> {
    #[account(
        seeds = [BANK_INFO_SEED],
        bump
    )]
    pub bank_info: Box<Account<'info, BankInfo>>,

    /// CHECK: PDA signer for bank ATA authority
    #[account(
        mut,
        seeds = [BANK_VAULT_SEED],
        bump
    )]
    pub bank_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = bank_vault
    )]
    pub bank_ata: Account<'info, TokenAccount>,

    /// CHECK: staking program user info PDA, validated by staking program seeds
    #[account(mut)]
    pub staking_user_info: UncheckedAccount<'info>,

    /// CHECK: staking PDA authority, validated by staking program seeds
    pub staking_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = staking_vault_authority
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    pub staking_program: Program<'info, TokenTakingApp>,

    #[account(mut, address = bank_info.authority)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> InvestToken<'info> {
    pub fn process(ctx: Context<InvestToken>, amount: u64, is_stake: bool) -> Result<()> {
        if ctx.accounts.bank_info.is_paused {
            return Err(BankAppError::BankAppPaused.into());
        }

        let bank_vault_bump = ctx.bumps.bank_vault;
        let bank_vault_signer_seeds: &[&[&[u8]]] = &[&[
            BANK_VAULT_SEED,
            &[bank_vault_bump],
        ]];

        cpi::stake_token(
            CpiContext::new_with_signer(
                ctx.accounts.staking_program.to_account_info(),
                cpi::accounts::StakeToken {
                    user: ctx.accounts.bank_vault.to_account_info(),
                    payer: ctx.accounts.authority.to_account_info(),
                    token_mint: ctx.accounts.token_mint.to_account_info(),
                    user_info: ctx.accounts.staking_user_info.to_account_info(),
                    user_token_account: ctx.accounts.bank_ata.to_account_info(),
                    vault_authority: ctx.accounts.staking_vault_authority.to_account_info(),
                    staking_vault: ctx.accounts.staking_vault.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                },
                bank_vault_signer_seeds,
            ),
            amount,
            is_stake,
        )?;

        Ok(())
    }
}
