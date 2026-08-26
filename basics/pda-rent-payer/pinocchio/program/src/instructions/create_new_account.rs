use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::state::RentVault;

pub fn create_new_account(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let [new_account, rent_vault, _] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !new_account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let bump = *instruction_data.first().ok_or(ProgramError::InvalidInstructionData)?;

    // Only the canonical bump is accepted, so a client cannot point at an alternate vault PDA.
    let (rent_vault_pda, canonical_bump) =
        Address::find_program_address(&[RentVault::SEED_PREFIX.as_bytes()], program_id);
    if bump != canonical_bump || rent_vault.address() != &rent_vault_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Assuming this account has no inner data (size 0)
    //
    let lamports_required_for_rent = (Rent::get()?).try_minimum_balance(0)?;

    let bump_bytes = bump.to_le_bytes();

    let seeds = [Seed::from(RentVault::SEED_PREFIX.as_bytes()), Seed::from(&bump_bytes)];

    let signer_seed = Signer::from(&seeds);

    // Create the new account, transferring lamports from the rent vault to the new account
    CreateAccount {
        from: rent_vault,
        to: new_account,
        lamports: lamports_required_for_rent,
        space: 0,
        owner: &pinocchio_system::ID,
    }
    .invoke_signed(&[signer_seed])?;

    Ok(())
}
