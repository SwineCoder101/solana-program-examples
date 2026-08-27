use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::state::RentVault;

pub fn create_new_account(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let new_account = next_account_info(accounts_iter)?;
    let rent_vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !new_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (rent_vault_pda, rent_vault_bump) =
        Pubkey::find_program_address(&[RentVault::SEED_PREFIX.as_bytes()], program_id);
    assert!(rent_vault.key.eq(&rent_vault_pda));

    // Assuming this account has no inner data (size 0)
    //
    let lamports_required_for_rent = (Rent::get()?).minimum_balance(0);

    // Create the new account, transferring lamports from the rent vault to the new account
    invoke_signed(
        &solana_system_interface::instruction::create_account(
            rent_vault.key,
            new_account.key,
            lamports_required_for_rent,
            0,
            &solana_system_interface::program::ID,
        ),
        &[rent_vault.clone(), new_account.clone(), system_program.clone()],
        &[&[RentVault::SEED_PREFIX.as_bytes(), &[rent_vault_bump]]],
    )?;

    Ok(())
}
