use anchor_lang::prelude::*;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use solana_sdk_ids::secp256k1_program::ID as SECP256K1_PROGRAM_ID;

declare_id!("HbXqot4uVZsMozVm7Bp5pJsRsxmiMf4bzGEYQCSHv1VU");

/// Longest note content, in bytes.
pub const MAX_CONTENT_LEN: usize = 200;

/// Prefix MetaMask's `personal_sign` puts in front of every message (EIP-191).
const EIP191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n";

/// Size of the secp256k1 precompile header: a signature count followed by one
/// `SecpSignatureOffsets` record (11 bytes).
const SECP256K1_HEADER_LEN: usize = 1 + 11;

#[program]
pub mod ethereum_notes {
    use super::*;

    pub fn create(ctx: Context<Create>, eth_address: [u8; 20], content: String) -> Result<()> {
        require!(content.len() <= MAX_CONTENT_LEN, NoteError::ContentTooLong);

        let note_key = ctx.accounts.note.key();
        let message = note_message("create", &note_key, 0, Some(&content));
        verify_eth_signature(&ctx.accounts.instructions_sysvar, &eth_address, &message)?;

        let note = &mut ctx.accounts.note;
        note.eth_address = eth_address;
        note.rent_payer = ctx.accounts.payer.key();
        note.nonce = 1;
        note.content = content;
        Ok(())
    }

    pub fn edit(ctx: Context<Edit>, content: String) -> Result<()> {
        require!(content.len() <= MAX_CONTENT_LEN, NoteError::ContentTooLong);

        let note = &mut ctx.accounts.note;
        let message = note_message("edit", &note.key(), note.nonce, Some(&content));
        verify_eth_signature(&ctx.accounts.instructions_sysvar, &note.eth_address, &message)?;

        note.nonce += 1;
        note.content = content;
        Ok(())
    }

    pub fn delete(ctx: Context<Delete>) -> Result<()> {
        let note = &ctx.accounts.note;
        let message = note_message("delete", &note.key(), note.nonce, None);
        verify_eth_signature(&ctx.accounts.instructions_sysvar, &note.eth_address, &message)
        // The `close` constraint on `note` returns the lamports to `rent_payer`.
    }
}

/// Builds the exact bytes the Ethereum wallet must have signed for this action.
///
/// The text is human readable so a MetaMask user can see what they authorise. Binding the
/// program id, the note address and the nonce means a signature is only valid for one action
/// on one note, once.
fn note_message(action: &str, note: &Pubkey, nonce: u64, content: Option<&str>) -> Vec<u8> {
    let mut text = format!("Solana note\nprogram: {}\nnote: {}\naction: {}\nnonce: {}", crate::ID, note, action, nonce);
    if let Some(content) = content {
        text.push_str("\ncontent: ");
        text.push_str(content);
    }

    let mut message = Vec::with_capacity(EIP191_PREFIX.len() + 3 + text.len());
    message.extend_from_slice(EIP191_PREFIX);
    message.extend_from_slice(text.len().to_string().as_bytes());
    message.extend_from_slice(text.as_bytes());
    message
}

/// Checks that the instruction immediately before this one is a secp256k1 precompile
/// instruction proving `expected_eth_address` signed `expected_message`.
///
/// The precompile cannot be called through CPI, so the runtime verifies the signature at the
/// transaction level and this program only needs to read the verified inputs back out of the
/// instructions sysvar. Nothing below is a cryptographic check: it is bookkeeping that ties
/// the runtime's verification to this note and this action.
fn verify_eth_signature(
    instructions_sysvar: &AccountInfo,
    expected_eth_address: &[u8; 20],
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, NoteError::MissingSignatureInstruction);
    let secp_index = current_index - 1;

    let secp_ix = load_instruction_at_checked(secp_index as usize, instructions_sysvar)?;
    require_keys_eq!(secp_ix.program_id, SECP256K1_PROGRAM_ID, NoteError::MissingSignatureInstruction);

    // Layout: count (u8), then per signature:
    //   signature_offset u16 | signature_ix_index u8 | eth_address_offset u16 |
    //   eth_address_ix_index u8 | message_offset u16 | message_size u16 | message_ix_index u8
    let data = &secp_ix.data;
    require!(data.len() >= SECP256K1_HEADER_LEN && data[0] == 1, NoteError::MalformedSignatureInstruction);
    let signature_ix_index = data[3];
    let eth_address_offset = u16::from_le_bytes([data[4], data[5]]) as usize;
    let eth_address_ix_index = data[6];
    let message_offset = u16::from_le_bytes([data[7], data[8]]) as usize;
    let message_size = u16::from_le_bytes([data[9], data[10]]) as usize;
    let message_ix_index = data[11];

    // Every referenced byte range must live inside the precompile instruction itself, so the
    // address and message we read are the ones the runtime actually verified.
    let secp_index = secp_index as u8;
    require!(
        signature_ix_index == secp_index && eth_address_ix_index == secp_index && message_ix_index == secp_index,
        NoteError::MalformedSignatureInstruction
    );

    let eth_address =
        data.get(eth_address_offset..eth_address_offset + 20).ok_or(NoteError::MalformedSignatureInstruction)?;
    let message =
        data.get(message_offset..message_offset + message_size).ok_or(NoteError::MalformedSignatureInstruction)?;

    require!(eth_address == expected_eth_address, NoteError::WrongSigner);
    require!(message == expected_message, NoteError::MessageMismatch);
    Ok(())
}

#[derive(Accounts)]
#[instruction(eth_address: [u8; 20])]
pub struct Create<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Note::INIT_SPACE,
        seeds = [b"note", eth_address.as_ref()],
        bump
    )]
    pub note: Account<'info, Note>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: pinned to the Instructions sysvar by the address constraint.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Edit<'info> {
    #[account(mut)]
    pub note: Account<'info, Note>,
    /// CHECK: pinned to the Instructions sysvar by the address constraint.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Delete<'info> {
    #[account(mut, has_one = rent_payer, close = rent_payer)]
    pub note: Account<'info, Note>,
    /// CHECK: `has_one` pins this to the account that paid for the note.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    /// CHECK: pinned to the Instructions sysvar by the address constraint.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// One note per Ethereum address, authorised purely by that address's signatures.
#[account]
#[derive(InitSpace)]
pub struct Note {
    pub eth_address: [u8; 20],
    /// Solana account that funded the note and gets the rent back on delete.
    pub rent_payer: Pubkey,
    /// Incremented on every accepted action so a signature can't be replayed.
    pub nonce: u64,
    #[max_len(MAX_CONTENT_LEN)]
    pub content: String,
}

#[error_code]
pub enum NoteError {
    #[msg("Expected a secp256k1 precompile instruction immediately before this one")]
    MissingSignatureInstruction,
    #[msg("secp256k1 instruction data is malformed")]
    MalformedSignatureInstruction,
    #[msg("Signature was produced by a different Ethereum address")]
    WrongSigner,
    #[msg("Signed message does not match this action")]
    MessageMismatch,
    #[msg("Note content is too long")]
    ContentTooLong,
}
