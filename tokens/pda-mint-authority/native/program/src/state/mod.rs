use {
    borsh::{BorshDeserialize, BorshSerialize},
    solana_program::pubkey::Pubkey,
};

#[derive(BorshDeserialize, BorshSerialize)]
pub struct MintAuthorityPda {
    pub bump: u8,
}

impl MintAuthorityPda {
    pub const SEED_PREFIX: &'static str = "mint_authority";
    pub const SIZE: usize = 8 + 8;
}

// Records who created a given mint, since the mint authority PDA signs
// unconditionally for whoever calls the mint instruction.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct MintConfig {
    pub bump: u8,
    pub admin: Pubkey,
}

impl MintConfig {
    pub const SEED_PREFIX: &'static str = "mint_config";
    pub const SIZE: usize = 1 + 32;
}
