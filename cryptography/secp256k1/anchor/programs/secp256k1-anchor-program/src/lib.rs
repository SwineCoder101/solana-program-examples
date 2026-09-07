use anchor_lang::prelude::*;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use solana_sdk_ids::secp256k1_program::ID as SECP256K1_PROGRAM_ID;

declare_id!("G7SyMsDAgVFFzQoLx6VsG8vaufuYvxmyfvFeHQbKXe1T");

/// Size of the secp256k1 precompile header: a signature count followed by one
/// `SecpSignatureOffsets` record (11 bytes).
const SECP256K1_HEADER_LEN: usize = 1 + 11;

#[program]
pub mod secp256k1_anchor_program {
    use super::*;

    /// Succeeds only if the instruction immediately before this one is a secp256k1 precompile
    /// instruction proving that `eth_address` signed `message`.
    pub fn verify(ctx: Context<Verify>, eth_address: [u8; 20], message: Vec<u8>) -> Result<()> {
        verify_eth_signature(&ctx.accounts.instructions_sysvar, &eth_address, &message)?;
        msg!("secp256k1 signature verified for the expected Ethereum address");
        Ok(())
    }
}

/// Checks that the previous instruction is a secp256k1 precompile instruction proving
/// `expected_eth_address` signed `expected_message`.
///
/// The precompile cannot be called through CPI. Instead the runtime verifies every precompile
/// instruction at the transaction level, so if this code runs at all the signature was valid.
/// Nothing below is cryptographic: it reads the verified address and message back out of the
/// precompile's own instruction data and checks they are the ones the caller expected.
pub fn verify_eth_signature(
    instructions_sysvar: &AccountInfo,
    expected_eth_address: &[u8; 20],
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, Secp256k1Error::MissingSignatureInstruction);
    let secp_index = current_index - 1;

    let secp_ix = load_instruction_at_checked(secp_index as usize, instructions_sysvar)?;
    require_keys_eq!(secp_ix.program_id, SECP256K1_PROGRAM_ID, Secp256k1Error::MissingSignatureInstruction);

    // Layout: count (u8), then per signature:
    //   signature_offset u16 | signature_ix_index u8 | eth_address_offset u16 |
    //   eth_address_ix_index u8 | message_offset u16 | message_size u16 | message_ix_index u8
    let data = &secp_ix.data;
    require!(data.len() >= SECP256K1_HEADER_LEN && data[0] == 1, Secp256k1Error::MalformedSignatureInstruction);
    let signature_ix_index = data[3];
    let eth_address_offset = u16::from_le_bytes([data[4], data[5]]) as usize;
    let eth_address_ix_index = data[6];
    let message_offset = u16::from_le_bytes([data[7], data[8]]) as usize;
    let message_size = u16::from_le_bytes([data[9], data[10]]) as usize;
    let message_ix_index = data[11];

    // The offsets may point at any instruction in the transaction. The runtime verified whatever
    // they point at, so only accept the case where that is the precompile instruction itself;
    // otherwise the bytes read below could differ from the bytes that were verified.
    let secp_index = secp_index as u8;
    require!(
        signature_ix_index == secp_index && eth_address_ix_index == secp_index && message_ix_index == secp_index,
        Secp256k1Error::MalformedSignatureInstruction
    );

    let eth_address =
        data.get(eth_address_offset..eth_address_offset + 20).ok_or(Secp256k1Error::MalformedSignatureInstruction)?;
    let message =
        data.get(message_offset..message_offset + message_size).ok_or(Secp256k1Error::MalformedSignatureInstruction)?;

    require!(eth_address == expected_eth_address, Secp256k1Error::WrongSigner);
    require!(message == expected_message, Secp256k1Error::MessageMismatch);
    Ok(())
}

#[derive(Accounts)]
pub struct Verify<'info> {
    /// CHECK: pinned to the Instructions sysvar by the address constraint.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[error_code]
pub enum Secp256k1Error {
    #[msg("Expected a secp256k1 precompile instruction immediately before this one")]
    MissingSignatureInstruction,
    #[msg("secp256k1 instruction data is malformed or references another instruction")]
    MalformedSignatureInstruction,
    #[msg("Signature was produced by a different Ethereum address")]
    WrongSigner,
    #[msg("Signed message does not match the expected message")]
    MessageMismatch,
}
