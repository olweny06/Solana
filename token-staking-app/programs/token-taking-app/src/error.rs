use anchor_lang::prelude::*;

#[error_code]
pub enum StakingAppError{
    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Insufficient staked balance")]
    InsufficientStakedBalance,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Invalid owner")]
    InvalidOwner,

    #[msg("Invalid mint")]
    InvalidMint,
}