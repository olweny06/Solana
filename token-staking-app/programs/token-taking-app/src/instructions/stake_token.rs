use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constant::{SECONDS_PER_YEAR, STAKING_APR, USER_INFO_SEED, VAULT_AUTH_SEED},
    error::StakingAppError,
    state::UserInfo,
    transfer_helper::{token_transfer_from_pda, token_transfer_from_user},
};

#[derive(Accounts)]
pub struct StakeToken<'info> {
    /// CHECK: authority for user_token_account; can be wallet or PDA signer via CPI
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [USER_INFO_SEED, user.key().as_ref(), token_mint.key().as_ref()],
        bump,
        space = 8 + UserInfo::INIT_SPACE,
    )]
    pub user_info: Account<'info, UserInfo>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA authority used only as signer
    #[account(
        seeds = [VAULT_AUTH_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = token_mint,
        associated_token::authority = vault_authority,
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> StakeToken<'info> {
    pub fn process(ctx: Context<StakeToken>, amount: u64, is_stake: bool) -> Result<()> {
        require!(amount > 0, StakingAppError::InvalidAmount);
        


        let user_info = &mut ctx.accounts.user_info;
        let now = Clock::get()?.unix_timestamp;

        if user_info.owner == Pubkey::default() {
            user_info.owner = ctx.accounts.user.key();
            user_info.mint = ctx.accounts.token_mint.key();
            user_info.staked_amount = 0;
            user_info.pending_reward = 0;
            user_info.last_update_time = now;
        }
        require_keys_eq!(user_info.owner, ctx.accounts.user.key(), StakingAppError::InvalidOwner);
        require_keys_eq!(user_info.mint, ctx.accounts.token_mint.key(), StakingAppError::InvalidMint);

        Self::accrue_rewards(user_info, now)?;

        if is_stake {
            token_transfer_from_user(
                ctx.accounts.user_token_account.to_account_info(),
                &ctx.accounts.user,
                ctx.accounts.staking_vault.to_account_info(),
                &ctx.accounts.token_program,
                amount,
            )?;

            user_info.staked_amount = user_info
                .staked_amount
                .checked_add(amount)
                .ok_or(StakingAppError::MathOverflow)?;
        } else {
            let total_claimable = user_info
                .staked_amount
                .checked_add(user_info.pending_reward)
                .ok_or(StakingAppError::MathOverflow)?;

            require!(
                total_claimable >= amount,
                StakingAppError::InsufficientStakedBalance
            );

            let mut remaining = amount;

            if user_info.pending_reward >= remaining {
                user_info.pending_reward -= remaining;
            } else {
                remaining = remaining
                    .checked_sub(user_info.pending_reward)
                    .ok_or(StakingAppError::MathOverflow)?;
                user_info.pending_reward = 0;
                user_info.staked_amount = user_info
                    .staked_amount
                    .checked_sub(remaining)
                    .ok_or(StakingAppError::MathOverflow)?;
            }

            let vault_bump = ctx.bumps.vault_authority;
            let token_mint_key = ctx.accounts.token_mint.key();
            let bump_seed = [vault_bump];
            let signer_seeds: &[&[&[u8]]] = &[&[
                VAULT_AUTH_SEED,
                token_mint_key.as_ref(),
                &bump_seed,
            ]];

            token_transfer_from_pda(
                ctx.accounts.staking_vault.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
                ctx.accounts.user_token_account.to_account_info(),
                &ctx.accounts.token_program,
                signer_seeds,
                amount,
            )?;
        }

        user_info.last_update_time = now;
        Ok(())
    }

    fn accrue_rewards(user_info: &mut Account<UserInfo>, now: i64) -> Result<()> {
        if user_info.last_update_time <= 0 || user_info.staked_amount == 0 {
            user_info.last_update_time = now;
            return Ok(());
        }

        let elapsed = now.saturating_sub(user_info.last_update_time) as u64;
        if elapsed == 0 {
            return Ok(());
        }

        let reward_u128 = (user_info.staked_amount as u128)
            .checked_mul(STAKING_APR as u128)
            .ok_or(StakingAppError::MathOverflow)?
            .checked_mul(elapsed as u128)
            .ok_or(StakingAppError::MathOverflow)?
            .checked_div(100)
            .ok_or(StakingAppError::MathOverflow)?
            .checked_div(SECONDS_PER_YEAR as u128)
            .ok_or(StakingAppError::MathOverflow)?;

        let reward = u64::try_from(reward_u128).map_err(|_| StakingAppError::MathOverflow)?;

        user_info.pending_reward = user_info
            .pending_reward
            .checked_add(reward)
            .ok_or(StakingAppError::MathOverflow)?;

        user_info.last_update_time = now;
        Ok(())
    }
}
