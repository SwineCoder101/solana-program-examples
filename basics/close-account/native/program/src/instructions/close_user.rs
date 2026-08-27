use crate::state::user::User;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

pub fn close_user(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let target_account = next_account_info(accounts_iter)?;
    let payer = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    // Only the account's owner may close it.
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify target_account is actually payer's User PDA, not another user's account.
    let (expected_user_pda, _) =
        Pubkey::find_program_address(&[User::SEED_PREFIX.as_bytes(), payer.key.as_ref()], program_id);
    if target_account.key != &expected_user_pda {
        return Err(ProgramError::IncorrectProgramId);
    }

    if system_program.key != &solana_system_interface::program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Send all the lamports back to the payer; a zero-lamport account is
    // deleted by the runtime, so the PDA can be created again later.
    let lamports = target_account.lamports();
    **target_account.lamports.borrow_mut() = 0;
    **payer.lamports.borrow_mut() += lamports;

    // Realloc the account to zero
    target_account.resize(0)?;

    // Assign the account to the System Program
    target_account.assign(&solana_system_interface::program::ID);

    Ok(())
}
