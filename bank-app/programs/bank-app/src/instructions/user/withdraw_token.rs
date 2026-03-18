// WithdrawToken có các thông tin sau: 
// - Token đang nằm trong bank_vault thuộc quyền của PDA BankInfo
// - user rút từ vault về user_token_account


use anchor_lang:: {prelude::*};
use anchor_spl::token::{Mint, TokenAccount, Token};

use crate:: {
    constant::{BANK_INFO_SEED, BANK_VAULT_SEED, USER_RESERVE_SEED},
    error::BankAppError,
    state::{BankInfo, UserReserve},
    transfer_helper::token_transfer_from_pda,
};

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    // kiểm tra trạng thái hệ thống is_paused 
    #[account(
        seeds = [BANK_INFO_SEED],
        bump
    )]
    pub bank_info: Box<Account<'info, BankInfo>>,

    // PDA - Authority of Bank ATA
    /// CHECK: This account is safe because it only acts as a PDA signer for the token transfer, and its seeds are validated.
    #[account(
        mut, 
        seeds = [BANK_VAULT_SEED],
        bump
    )]
    pub bank_vault: UncheckedAccount<'info>,

    // Token sent
    #[account(mut)]
    pub token_mint: Account<'info, Mint>,

    // User token account
    #[account(
        mut, 
        associated_token:: mint = token_mint,
        associated_token:: authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,

    // Bank token account
    #[account(
        mut, 
        associated_token:: mint = token_mint,
        associated_token:: authority = bank_vault // PDA 
    )]
    pub bank_ata: Account<'info, TokenAccount>,

    // User wallet
    #[account(
        mut,
        seeds = [
            USER_RESERVE_SEED,
            user.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump,
    )]
    pub user_reserve: Box<Account<'info, UserReserve>>,

    // Người thực hiện và trả phí
    #[account(mut)]
    pub user: Signer<'info>,

    // Các chương trình hỗ trợ
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

}

impl<'info> WithdrawToken<'info> {
    pub fn process(ctx: Context<WithdrawToken>, withdraw_amount: u64) -> Result<()> {

        let bank_info = &mut ctx.accounts.bank_info;
        // Check bank state
        if bank_info.is_paused{
            return Err(BankAppError:: BankAppPaused.into());
        }

        let user_reserve = &mut ctx.accounts.user_reserve; 

        // Check if enough money to withdraw 
        if user_reserve.deposited_amount < withdraw_amount {
            return Err(BankAppError::InsufficientBalance.into());
        }

        // Prepare Signer Seeds for PDA
        let bump = ctx.bumps.bank_vault;
        let signer_seeds: &[&[&[u8]]] = &[&[
            BANK_VAULT_SEED,
            &[bump],
        ]];

        token_transfer_from_pda(
            ctx.accounts.bank_ata.to_account_info(),
            ctx.accounts.bank_vault.to_account_info(),
            ctx.accounts.user_ata.to_account_info(),
            &ctx.accounts.token_program,
            signer_seeds,
            withdraw_amount
        )?;

        user_reserve.deposited_amount -= withdraw_amount;

        Ok(())
    }

}