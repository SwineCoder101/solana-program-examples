use pinocchio::{error::ProgramError, Address};

/// Persistent record stored in the mint-authority PDA.
///
/// The PDA is derived from `[b"mint_authority"]` and acts as the mint and
/// freeze authority for every token this program creates. Persisting the
/// canonical bump lets later instructions rebuild the signer seeds without
/// re-deriving the address on-chain.
pub struct MintAuthorityPda {
    /// Canonical bump for the mint-authority PDA.
    pub bump: u8,
}

impl MintAuthorityPda {
    /// Seed for the mint-authority PDA: `[SEED_PREFIX]`.
    pub const SEED_PREFIX: &'static [u8] = b"mint_authority";

    /// Bytes allocated for the account. Mirrors the `native` example (8 + 8);
    /// only the first byte (the bump) is meaningful.
    pub const ACCOUNT_SPACE: usize = 16;

    /// Writes the bump into the first byte of `dst`.
    pub fn serialize(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        *dst.first_mut().ok_or(ProgramError::AccountDataTooSmall)? = self.bump;
        Ok(())
    }

    /// Reads the bump from the first byte of `src`.
    pub fn deserialize(src: &[u8]) -> Result<Self, ProgramError> {
        let bump = *src.first().ok_or(ProgramError::InvalidAccountData)?;
        Ok(Self { bump })
    }
}

/// Per-mint record of who created it, stored in the mint-config PDA derived
/// from `[b"mint_config", mint]`.
///
/// The mint-authority PDA signs unconditionally for whoever calls `Mint`, so
/// this account is the only thing gating who may trigger it.
pub struct MintConfig {
    /// Canonical bump for the mint-config PDA.
    pub bump: u8,
    /// The wallet that created the mint and is allowed to mint it.
    pub admin: Address,
}

impl MintConfig {
    /// Seed prefix for the mint-config PDA: `[SEED_PREFIX, mint]`.
    pub const SEED_PREFIX: &'static [u8] = b"mint_config";

    /// Bytes allocated for the account: bump followed by the admin address.
    pub const ACCOUNT_SPACE: usize = 1 + 32;

    /// Writes the bump and admin into `dst`.
    pub fn serialize(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        let dst = dst.get_mut(..Self::ACCOUNT_SPACE).ok_or(ProgramError::AccountDataTooSmall)?;
        dst[0] = self.bump;
        dst[1..].copy_from_slice(self.admin.as_ref());
        Ok(())
    }

    /// Reads the bump and admin from `src`.
    pub fn deserialize(src: &[u8]) -> Result<Self, ProgramError> {
        let src = src.get(..Self::ACCOUNT_SPACE).ok_or(ProgramError::InvalidAccountData)?;
        let admin: [u8; 32] = src[1..].try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        Ok(Self { bump: src[0], admin: Address::new_from_array(admin) })
    }
}
