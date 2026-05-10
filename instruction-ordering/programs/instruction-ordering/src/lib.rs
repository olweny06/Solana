use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    sysvar::instructions as instructions_sysvar,
};
use bytemuck::{Pod, Zeroable};

declare_id!("EAmDu66bkZMdZiQkDTBzNc8akYT4d7p3yi5z1d7jR6LR");

#[program]
pub mod instruction_ordering {
    use super::*;

    // Part 1 : Instruction Ordering
    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        msg!("Approval granted!");
        Ok(())
    }
    pub fn execute(ctx:Context<Execute>, amount: u64) -> Result<()> {
        // TODO: Check that previous instruction was `approve`
        // - Use `instructions::load_current_index_checked` to get the current index
        // - Ensure there was at least one previous instruction
        // - Use `instructions::load_instruction_at_checked` to fetch the previous ix
        // - Verify:
        //     * previous_ix.program_id == crate::ID
        //     * first 8 bytes of previous_ix.data match the "approve" discriminator
        //       (hint: `hash(b"global:approve").to_bytes()[0..8]`)
        // get account Sysvar instructions
        let ix_acc = &ctx.accounts.instructions.to_account_info();
        let current_index = instructions_sysvar::load_current_index_checked(ix_acc)?;
        msg!("Current instruction index: {}", current_index);
        // Ensure there was at least one previous instruction 
        require!(current_index > 0, ErrorCode::MustApproveFirst);

        // Fetch the previous ix
        let previous_ix = instructions_sysvar::load_instruction_at_checked((current_index-1) as usize, ix_acc)?;

        // previous ix contains many in4 such as program_id, accounts, and data 

        // Check if from a program ID to avoid hacker fake a instruction from another program
        require!(previous_ix.program_id == crate::ID, ErrorCode::MustApproveFirst);
        // Check data has at least 8-bytes for discriminator
        // execute(amount) has [8 byte discriminator, 8 byte amount]
        require!(previous_ix.data.len() >= 8, ErrorCode::MustApproveFirst);
        let approve_hash = hash(b"global:approve").to_bytes();
        let approve_discriminator: [u8; 8] = approve_hash[..8]
            .try_into()
            .unwrap();
        // Check 8 byte previous instruction match with approve
        require!(previous_ix.data[..8] == approve_discriminator, ErrorCode::MustApproveFirst);

        // Main logic
        msg!("Executing with amount: {}", amount);

        Ok(())
    }

    // -------------------PART 2 LARGE DATA -------------------------
    pub fn initialize_large_approval_regular(
        ctx: Context<InitializeLargeApprovalRegular>,
    ) -> Result<()> {
        // TODO:
        // - Initialize a "regular" large account using `Account<LargeApprovalDataRegular>`
        // - Set the authority to `ctx.accounts.authority.key()`
        // - Zero out the approval_history array
        let data  = &mut ctx.accounts.approval_data; 
        data.authority = ctx.accounts.authority.key();
        data.approval_history = [0; REGULAR_HISTORY_LEN];
        Ok(())
    }

    pub fn process_large_approval_regular(ctx: Context<ProcessLargeApprovalRegular>) -> Result<()> {
        // TODO:
        // - Get current timestamp from `Clock::get()?`
        // - Find the first empty slot (value == 0) in approval_history
        // - Write the timestamp there
        let clock = Clock::get()?;
        let data = &mut ctx.accounts.approval_data;

        for slot in data.approval_history.iter_mut() {
            if *slot == 0 {
                *slot = clock.unix_timestamp as u64;
                return Ok(());
            }
        }
        err!(ErrorCode::ApprovalHistoryFull)
    }

    pub fn initialize_large_approval_zero_copy(
        ctx: Context<InitializeLargeApprovalZeroCopy>,
    ) -> Result<()> {
        // TODO:
        // - Use `ctx.accounts.approval_data.load_init()?` to get a zero-copy reference
        // - Set the authority (as bytes) and zero out the 512-element approval_history array
        let data = &mut ctx.accounts.approval_data.load_init()?;
        data.authority = ctx.accounts.authority.key().to_bytes();
        data.approval_history = [0; 512];
        Ok(())
    }

    pub fn process_large_approval_zero_copy(
        ctx: Context<ProcessLargeApprovalZeroCopy>,
    ) -> Result<()> {
        // TODO:
        // - Similar to the regular version, but using zero-copy:
        //   `let mut data = ctx.accounts.approval_data.load_mut()?;`
        // - Use `Clock::get()?` and write the timestamp into the first empty slot
        let clock = Clock::get()?;
        let mut data = ctx.accounts.approval_data.load_mut()?;
        for slot in data.approval_history.iter_mut() {
            if *slot == 0 {
                *slot = clock.unix_timestamp as u64;
                return Ok(());
            }
        }
        err!(ErrorCode::ApprovalHistoryFull)
    }
}


#[derive(Accounts)]
pub struct Approve<'info> {
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct Execute<'info> {
    pub authority: Signer<'info>,
     /// CHECK: Instructions sysvar
    // TODO: Add constraint to verify this is the instructions sysvar
    // Hint: `#[account(address = solana_program::sysvar::instructions::ID)]`
    #[account(address = instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

// ---------------- Part 2: Regular Account<T> ----------------

// TODO: Adjust this length to be "large but still compiles" under BPF stack limits.
// Later, you can experiment with increasing it to see stack usage errors.
pub const REGULAR_HISTORY_LEN: usize = 128;

#[account]
pub struct LargeApprovalDataRegular {
    // TODO: Add fields:
    // - authority: Pubkey
    // - approval_history: [u64; REGULAR_HISTORY_LEN]
    pub authority: Pubkey,
    pub approval_history: [u64; REGULAR_HISTORY_LEN],
}

#[derive(Accounts)]
pub struct InitializeLargeApprovalRegular<'info> {
    #[account(
        init,
        payer = authority,
        // TODO: Set correct space: 8 + size_of::<LargeApprovalDataRegular>()
        space = 8 + std::mem::size_of::<LargeApprovalDataRegular>(),
        // TODO: Choose PDA seeds (e.g. b"approval_regular", authority key)
        seeds = [b"approval_regular", authority.key().as_ref()],
        bump
    )]
    pub approval_data: Account<'info, LargeApprovalDataRegular>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessLargeApprovalRegular<'info> {
    #[account(
        mut,
        // TODO: Use the same seeds as in InitializeLargeApprovalRegular
        seeds = [b"approval_regular", authority.key().as_ref()],
        bump
    )]
    pub approval_data: Account<'info, LargeApprovalDataRegular>,

    pub authority: Signer<'info>,
}


// ---------------- Part 2: Zero-Copy AccountLoader<T> ----------------

// TODO:
// - Make this a zero-copy account: `#[account(zero_copy)]`
// - Add `#[repr(C)]` and derives needed for zero-copy (e.g. Copy, Clone, Default or bytemuck)
// - Add fields:
//     * authority: [u8; 32]
//     * approval_history: [u64; 512]   // full large array
#[account(zero_copy)]
#[repr(C)]
pub struct LargeApprovalData {
    // TODO
    pub authority: [u8; 32],
    pub approval_history: [u64; 512],
}

#[derive(Accounts)]
pub struct InitializeLargeApprovalZeroCopy<'info> {
    #[account(
        init,
        payer = authority,
        // TODO: Set correct space: 8 + size_of::<LargeApprovalData>()
        space = 8 + std::mem::size_of::<LargeApprovalData>(),
        // TODO: Choose PDA seeds (e.g. b"approval_zero_copy", authority key)
        seeds = [b"approval_zero_copy", authority.key().as_ref()],
        bump
    )]
    // TODO: Use AccountLoader<LargeApprovalData> instead of Account<...>
    pub approval_data: AccountLoader<'info, LargeApprovalData>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessLargeApprovalZeroCopy<'info> {
    #[account(
        mut,
        // TODO: Use the same seeds as in InitializeLargeApprovalZeroCopy
        seeds = [b"approval_zero_copy", authority.key().as_ref()],
        bump
    )]
    // TODO: Use AccountLoader<LargeApprovalData>
    pub approval_data: AccountLoader<'info, LargeApprovalData>,

    pub authority: Signer<'info>,
}


// ------------ERRORS-------------
#[error_code]
pub enum ErrorCode{
    #[msg("Must approve before executing")]
    MustApproveFirst,

    #[msg("Approval history is full")]
    ApprovalHistoryFull,
}