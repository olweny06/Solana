use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Transfer};

pub fn token_transfer_from_pda<'info>(
    from: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    to: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    let cpi_accounts = Transfer {
        from,
        authority,
        to,
    };

    let cpi_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );

    token::transfer(cpi_ctx, amount)
}

pub fn token_transfer_from_user<'info>(
    from: AccountInfo<'info>,
    authority: &Signer<'info>,
    to: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        token_program.to_account_info(),
        Transfer {
            from,
            authority: authority.to_account_info(),
            to,
        },
    );

    token::transfer(cpi_ctx, amount)
}
