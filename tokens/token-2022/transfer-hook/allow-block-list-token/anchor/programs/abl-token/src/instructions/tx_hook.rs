use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            immutable_owner::ImmutableOwner, permanent_delegate::PermanentDelegate, BaseStateWithExtensions,
            StateWithExtensions,
        },
        state::{Account as TokenAccount, Mint},
    },
    token_interface::spl_token_metadata_interface::state::TokenMetadata,
};

use crate::{ABListError, ABWallet, Mode};

#[derive(Accounts)]
pub struct TxHook<'info> {
    /// CHECK:
    pub source_token_account: UncheckedAccount<'info>,
    /// CHECK:
    pub mint: UncheckedAccount<'info>,
    /// CHECK:
    pub destination_token_account: UncheckedAccount<'info>,
    /// CHECK:
    pub owner_delegate: UncheckedAccount<'info>,
    /// CHECK:
    pub meta_list: UncheckedAccount<'info>,
    /// CHECK:
    pub source_ab_wallet: UncheckedAccount<'info>,
    /// CHECK:
    pub destination_ab_wallet: UncheckedAccount<'info>,
}

impl TxHook<'_> {
    pub fn tx_hook(&self, amount: u64) -> Result<()> {
        let mint_info = self.mint.to_account_info();
        let mint_data = mint_info.data.borrow();
        let mint = StateWithExtensions::<Mint>::unpack(&mint_data)?;

        // The lists are keyed on the token-account owner, which can be
        // changed without invoking the hook unless the owner is immutable.
        Self::require_immutable_owner(&self.source_token_account)?;
        Self::require_immutable_owner(&self.destination_token_account)?;

        let metadata = mint.get_variable_len_extension::<TokenMetadata>()?;
        let decoded_mode = Self::decode_metadata(&metadata)?;
        let source_wallet_mode = Self::decode_wallet_mode(&self.source_ab_wallet)?;
        let destination_wallet_mode = Self::decode_wallet_mode(&self.destination_ab_wallet)?;
        let authority_is_permanent_delegate = mint
            .get_extension::<PermanentDelegate>()
            .ok()
            .and_then(|extension| Option::<Pubkey>::from(extension.delegate))
            .is_some_and(|delegate| delegate == self.owner_delegate.key());

        decide(decoded_mode, source_wallet_mode, destination_wallet_mode, amount, authority_is_permanent_delegate)
    }

    fn require_immutable_owner(account: &UncheckedAccount) -> Result<()> {
        let data = account.data.borrow();
        let token_account = StateWithExtensions::<TokenAccount>::unpack(&data)?;
        token_account.get_extension::<ImmutableOwner>().map_err(|_| ABListError::ImmutableOwnerRequired)?;
        Ok(())
    }

    fn decode_wallet_mode(account: &UncheckedAccount) -> Result<DecodedWalletMode> {
        if account.data_is_empty() {
            return Ok(DecodedWalletMode::None);
        }

        let wallet_data = &mut account.data.borrow();
        let wallet = ABWallet::try_deserialize(&mut &wallet_data[..])?;

        if wallet.allowed {
            Ok(DecodedWalletMode::Allow)
        } else {
            Ok(DecodedWalletMode::Block)
        }
    }

    fn decode_metadata(metadata: &TokenMetadata) -> Result<DecodedMintMode> {
        let mut mode = Mode::Allow;
        let mut threshold = 0;

        for (key, value) in metadata.additional_metadata.iter() {
            if key == "AB" {
                mode = Mode::from_str(value).map_err(|_| ABListError::InvalidMetadata)?;
                if mode == Mode::Allow {
                    return Ok(DecodedMintMode::Allow);
                } else if mode == Mode::Block {
                    return Ok(DecodedMintMode::Block);
                } else if mode == Mode::Mixed && threshold > 0 {
                    return Ok(DecodedMintMode::Threshold(threshold));
                }
            } else if key == "threshold" {
                threshold = u64::from_str(value).map_err(|_| ABListError::InvalidMetadata)?;
                if threshold > 0 {
                    return Ok(DecodedMintMode::Threshold(threshold));
                }
            }
        }

        // we have early returns above, but we can reach here if metadata is meddled with
        // which is why we have this fallback
        // also, anchor doesn't yet support removing keys from metadata, which means that if we set threshold, we can never remove the KV pair
        // only set it to 0

        if mode == Mode::Allow {
            return Ok(DecodedMintMode::Allow);
        } else if mode == Mode::Block {
            return Ok(DecodedMintMode::Block);
        }

        Ok(DecodedMintMode::Threshold(threshold))
    }
}

/// The transfer decision, kept as a pure function of the decoded mint/wallet
/// state so it's directly unit-testable without needing real accounts.
///
/// A wallet with an explicit `allowed: false` ABWallet record is blocked from
/// transacting entirely - neither sending nor receiving - regardless of the
/// mint's overall mode. This is checked first and applies to both sides. The
/// one exception is the mint's permanent delegate, which may still move
/// tokens *out* of a blocked wallet (clawback); the destination rules apply
/// to it like to anyone else.
///
/// Beyond that, Allow/Threshold mode gate who may *receive* only, matching
/// this program's documented semantics (see README): Force Allow requires
/// the receiver to be explicitly allowed in; Threshold requires the receiver
/// to be explicitly allowed in for transfers at or above the threshold.
fn decide(
    mint_mode: DecodedMintMode,
    source_wallet_mode: DecodedWalletMode,
    destination_wallet_mode: DecodedWalletMode,
    amount: u64,
    authority_is_permanent_delegate: bool,
) -> Result<()> {
    if destination_wallet_mode == DecodedWalletMode::Block {
        return Err(ABListError::WalletBlocked.into());
    }
    if source_wallet_mode == DecodedWalletMode::Block && !authority_is_permanent_delegate {
        return Err(ABListError::WalletBlocked.into());
    }

    match (mint_mode, destination_wallet_mode) {
        // first check the force allow modes
        (DecodedMintMode::Allow, DecodedWalletMode::Allow) => Ok(()),
        (DecodedMintMode::Allow, _) => Err(ABListError::WalletNotAllowed.into()),
        // block mode: neither wallet was explicitly blocked (checked above), so allow
        (DecodedMintMode::Block, _) => Ok(()),
        // lastly check the threshold mode
        (DecodedMintMode::Threshold(threshold), DecodedWalletMode::None) if amount >= threshold => {
            Err(ABListError::AmountNotAllowed.into())
        }
        (DecodedMintMode::Threshold(_), _) => Ok(()),
    }
}

#[derive(Debug, PartialEq)]
enum DecodedMintMode {
    Allow,
    Block,
    Threshold(u64),
}

#[derive(Debug, PartialEq)]
enum DecodedWalletMode {
    Allow,
    Block,
    None,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_blocked_is_always_rejected() {
        // This is the exact case that was broken: a blocked SENDER used to
        // be allowed through, since only the destination was ever checked.
        for mint_mode in [DecodedMintMode::Allow, DecodedMintMode::Block, DecodedMintMode::Threshold(100)] {
            for destination_mode in [DecodedWalletMode::Allow, DecodedWalletMode::Block, DecodedWalletMode::None] {
                let result = decide(mint_mode_clone(&mint_mode), DecodedWalletMode::Block, destination_mode, 0, false);
                assert!(
                    result.is_err(),
                    "expected a blocked source to be rejected regardless of mint mode / destination status"
                );
            }
        }
    }

    #[test]
    fn destination_blocked_is_always_rejected() {
        // Regression guard: this already worked before the fix, must keep working.
        for mint_mode in [DecodedMintMode::Allow, DecodedMintMode::Block, DecodedMintMode::Threshold(100)] {
            for source_mode in [DecodedWalletMode::Allow, DecodedWalletMode::Block, DecodedWalletMode::None] {
                for is_permanent_delegate in [false, true] {
                    let result = decide(
                        mint_mode_clone(&mint_mode),
                        mint_mode_clone_wallet(&source_mode),
                        DecodedWalletMode::Block,
                        0,
                        is_permanent_delegate,
                    );
                    assert!(
                        result.is_err(),
                        "expected a blocked destination to be rejected regardless of mint mode / source status / authority"
                    );
                }
            }
        }
    }

    #[test]
    fn permanent_delegate_may_claw_back_from_a_blocked_source() {
        for mint_mode in [DecodedMintMode::Block, DecodedMintMode::Threshold(100)] {
            let result = decide(mint_mode, DecodedWalletMode::Block, DecodedWalletMode::None, 0, true);
            assert!(
                result.is_ok(),
                "expected the permanent delegate to be able to move tokens out of a blocked wallet"
            );
        }
        let result = decide(DecodedMintMode::Allow, DecodedWalletMode::Block, DecodedWalletMode::Allow, 0, true);
        assert!(result.is_ok());
    }

    #[test]
    fn permanent_delegate_is_still_subject_to_destination_rules() {
        let result = decide(DecodedMintMode::Allow, DecodedWalletMode::Block, DecodedWalletMode::None, 0, true);
        assert!(result.is_err(), "Allow mode must still require the destination to be allowed");
        let result =
            decide(DecodedMintMode::Threshold(100), DecodedWalletMode::Block, DecodedWalletMode::None, 100, true);
        assert!(result.is_err(), "Threshold mode must still gate large transfers to unlisted destinations");
    }

    #[test]
    fn allow_mode_does_not_gate_the_source() {
        // The source is intentionally NOT gated in Allow mode - only "who may
        // receive" is documented/intended to be restricted. This is the
        // control case proving the fix doesn't over-correct.
        let result = decide(DecodedMintMode::Allow, DecodedWalletMode::None, DecodedWalletMode::Allow, 0, false);
        assert!(result.is_ok());
    }

    #[test]
    fn allow_mode_rejects_an_unlisted_destination() {
        let result = decide(DecodedMintMode::Allow, DecodedWalletMode::None, DecodedWalletMode::None, 0, false);
        assert!(result.is_err());
    }

    #[test]
    fn block_mode_allows_unlisted_wallets() {
        let result = decide(DecodedMintMode::Block, DecodedWalletMode::None, DecodedWalletMode::None, 0, false);
        assert!(result.is_ok());
    }

    #[test]
    fn threshold_mode_allows_small_transfers_to_unlisted_destinations() {
        let result =
            decide(DecodedMintMode::Threshold(100), DecodedWalletMode::None, DecodedWalletMode::None, 50, false);
        assert!(result.is_ok());
    }

    #[test]
    fn threshold_mode_rejects_large_transfers_to_unlisted_destinations() {
        let result =
            decide(DecodedMintMode::Threshold(100), DecodedWalletMode::None, DecodedWalletMode::None, 100, false);
        assert!(result.is_err());
    }

    #[test]
    fn threshold_mode_allows_large_transfers_to_an_allowed_destination() {
        let result =
            decide(DecodedMintMode::Threshold(100), DecodedWalletMode::None, DecodedWalletMode::Allow, 100, false);
        assert!(result.is_ok());
    }

    fn mint_mode_clone(mode: &DecodedMintMode) -> DecodedMintMode {
        match mode {
            DecodedMintMode::Allow => DecodedMintMode::Allow,
            DecodedMintMode::Block => DecodedMintMode::Block,
            DecodedMintMode::Threshold(t) => DecodedMintMode::Threshold(*t),
        }
    }

    fn mint_mode_clone_wallet(mode: &DecodedWalletMode) -> DecodedWalletMode {
        match mode {
            DecodedWalletMode::Allow => DecodedWalletMode::Allow,
            DecodedWalletMode::Block => DecodedWalletMode::Block,
            DecodedWalletMode::None => DecodedWalletMode::None,
        }
    }
}
