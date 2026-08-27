use {
    abl_token::{
        accounts::{InitConfig, InitMint, InitWallet, ResizeMetaList},
        instructions::{InitMintArgs, InitWalletArgs},
        Mode,
    },
    anchor_lang::solana_program::system_instruction::create_account,
    anchor_lang::InstructionData,
    anchor_lang::ToAccountMetas,
    anchor_spl::token_2022::{
        spl_token_2022::{
            self,
            extension::{transfer_hook, ExtensionType, StateWithExtensions},
            instruction::{
                initialize_account3, initialize_immutable_owner, initialize_mint2, mint_to, set_authority,
                transfer_checked, AuthorityType,
            },
            state::{Account as TokenAccount, Mint},
        },
        ID as TOKEN_22_PROGRAM_ID,
    },
    litesvm::{types::FailedTransactionMetadata, types::TransactionMetadata, LiteSVM},
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::Message,
    solana_native_token::LAMPORTS_PER_SOL,
    solana_pubkey::Pubkey,
    solana_sdk_ids::system_program::ID as SYSTEM_PROGRAM_ID,
    solana_signer::Signer,
    solana_transaction::Transaction,
    spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList},
    spl_transfer_hook_interface::instruction::ExecuteInstruction,
    std::path::PathBuf,
};

const PROGRAM_ID: Pubkey = abl_token::ID_CONST;
const DECIMALS: u8 = 6;

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let admin_kp = Keypair::new();
    let admin_pk = admin_kp.pubkey();

    svm.airdrop(&admin_pk, 10000 * LAMPORTS_PER_SOL).unwrap();

    let mut so_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    so_path.push("../../target/deploy/abl_token.so");

    println!("Deploying program from {}", so_path.display());

    let bytecode = std::fs::read(so_path).unwrap();

    svm.add_program(PROGRAM_ID, &bytecode);

    (svm, admin_kp)
}

/// Signs with every keypair in `signers` (the first one pays) and sends.
fn send(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    instructions: &[Instruction],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let msg = Message::new(instructions, Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx)
}

fn init_config(svm: &mut LiteSVM, admin_kp: &Keypair) {
    let admin_pk = admin_kp.pubkey();
    let init_cfg_accounts = InitConfig { payer: admin_pk, config: derive_config(), system_program: SYSTEM_PROGRAM_ID };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: init_cfg_accounts.to_account_metas(None),
        data: abl_token::instruction::InitConfig {}.data(),
    };
    send(svm, &[admin_kp], &[instruction]).unwrap();
}

/// Runs `init_mint` for `mint_kp` with `args` and returns the meta-list pubkey.
fn init_mint(svm: &mut LiteSVM, admin_kp: &Keypair, mint_kp: &Keypair, args: InitMintArgs) -> Pubkey {
    let admin_pk = admin_kp.pubkey();
    let mint_pk = mint_kp.pubkey();
    let meta_list = derive_meta_list(&mint_pk);

    let init_mint_accounts = InitMint {
        payer: admin_pk,
        mint: mint_pk,
        extra_metas_account: meta_list,
        system_program: SYSTEM_PROGRAM_ID,
        token_program: TOKEN_22_PROGRAM_ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: init_mint_accounts.to_account_metas(None),
        data: abl_token::instruction::InitMint { args }.data(),
    };
    send(svm, &[admin_kp, mint_kp], &[instruction]).unwrap();

    meta_list
}

fn mint_args(mode: Mode, threshold: u64, authority: Pubkey, permanent_delegate: Pubkey) -> InitMintArgs {
    InitMintArgs {
        name: "Test".to_string(),
        symbol: "TEST".to_string(),
        uri: "https://test.com".to_string(),
        decimals: DECIMALS,
        mint_authority: authority,
        freeze_authority: authority,
        permanent_delegate,
        transfer_hook_authority: authority,
        mode,
        threshold,
    }
}

/// Runs `init_config` then `init_mint` (with `admin_pk` as the mint's
/// `transfer_hook_authority`) and returns the resulting mint + meta-list
/// pubkeys, so tests that need a live mint don't have to repeat the setup.
fn setup_mint(svm: &mut LiteSVM, admin_kp: &Keypair) -> (Pubkey, Pubkey) {
    let admin_pk = admin_kp.pubkey();
    let mint_kp = Keypair::new();
    let mint_pk = mint_kp.pubkey();

    init_config(svm, admin_kp);

    let args = InitMintArgs {
        name: "Test".to_string(),
        symbol: "TEST".to_string(),
        uri: "https://test.com".to_string(),
        decimals: DECIMALS,
        mint_authority: mint_pk,
        freeze_authority: mint_pk,
        permanent_delegate: mint_pk,
        transfer_hook_authority: admin_pk,
        mode: Mode::Mixed,
        threshold: 100000,
    };
    let meta_list = init_mint(svm, admin_kp, &mint_kp, args);

    (mint_pk, meta_list)
}

/// A Block-mode mint (everyone may transact unless explicitly blocked) with
/// `admin_kp` as mint authority and `permanent_delegate` as the mint's
/// permanent delegate. Returns the mint pubkey.
fn setup_block_mode_mint(svm: &mut LiteSVM, admin_kp: &Keypair, permanent_delegate: Pubkey) -> Pubkey {
    let mint_kp = Keypair::new();
    init_config(svm, admin_kp);
    init_mint(svm, admin_kp, &mint_kp, mint_args(Mode::Block, 0, admin_kp.pubkey(), permanent_delegate));
    mint_kp.pubkey()
}

fn init_wallet(svm: &mut LiteSVM, admin_kp: &Keypair, wallet: Pubkey, allowed: bool) {
    let accounts = InitWallet {
        authority: admin_kp.pubkey(),
        config: derive_config(),
        wallet,
        ab_wallet: derive_ab_wallet(&wallet),
        system_program: SYSTEM_PROGRAM_ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: abl_token::instruction::InitWallet { args: InitWalletArgs { allowed } }.data(),
    };
    send(svm, &[admin_kp], &[instruction]).unwrap();
}

/// Creates a non-associated Token-2022 account for `owner`, optionally with
/// the `ImmutableOwner` extension (which every ATA carries, but which plain
/// token accounts only get when explicitly initialized).
fn create_token_account(
    svm: &mut LiteSVM,
    payer_kp: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
    immutable_owner: bool,
) -> Pubkey {
    let account_kp = Keypair::new();
    let account_pk = account_kp.pubkey();

    let mut extensions = vec![ExtensionType::TransferHookAccount];
    if immutable_owner {
        extensions.push(ExtensionType::ImmutableOwner);
    }
    let space = ExtensionType::try_calculate_account_len::<TokenAccount>(&extensions).unwrap();
    let rent = svm.minimum_balance_for_rent_exemption(space);

    let mut instructions =
        vec![create_account(&payer_kp.pubkey(), &account_pk, rent, space as u64, &TOKEN_22_PROGRAM_ID)];
    if immutable_owner {
        instructions.push(initialize_immutable_owner(&TOKEN_22_PROGRAM_ID, &account_pk).unwrap());
    }
    instructions.push(initialize_account3(&TOKEN_22_PROGRAM_ID, &account_pk, mint, owner).unwrap());
    send(svm, &[payer_kp, &account_kp], &instructions).unwrap();

    account_pk
}

fn mint_tokens(svm: &mut LiteSVM, authority_kp: &Keypair, mint: &Pubkey, account: &Pubkey, amount: u64) {
    let instruction = mint_to(&TOKEN_22_PROGRAM_ID, mint, account, &authority_kp.pubkey(), &[], amount).unwrap();
    send(svm, &[authority_kp], &[instruction]).unwrap();
}

fn token_account(svm: &LiteSVM, account: &Pubkey) -> TokenAccount {
    let data = svm.get_account(account).unwrap().data;
    StateWithExtensions::<TokenAccount>::unpack(&data).unwrap().base
}

fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    token_account(svm, account).amount
}

/// A `TransferChecked` signed by `authority_kp`, carrying the extra accounts
/// the transfer hook resolves: the hook program, the mint's meta list and the
/// `ab_wallet` PDA of each side's token-account owner.
fn hooked_transfer(
    svm: &mut LiteSVM,
    authority_kp: &Keypair,
    mint: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let source_owner = token_account(svm, source).owner;
    let destination_owner = token_account(svm, destination).owner;

    let mut instruction = transfer_checked(
        &TOKEN_22_PROGRAM_ID,
        source,
        mint,
        destination,
        &authority_kp.pubkey(),
        &[],
        amount,
        DECIMALS,
    )
    .unwrap();
    instruction.accounts.extend([
        AccountMeta::new_readonly(PROGRAM_ID, false),
        AccountMeta::new_readonly(derive_meta_list(mint), false),
        AccountMeta::new_readonly(derive_ab_wallet(&source_owner), false),
        AccountMeta::new_readonly(derive_ab_wallet(&destination_owner), false),
    ]);

    send(svm, &[authority_kp], &[instruction])
}

fn assert_hook_error(failure: &FailedTransactionMetadata, error_name: &str) {
    assert!(
        failure.meta.logs.iter().any(|log| log.contains(error_name)),
        "expected the transfer to fail with {error_name}, got: {:?}",
        failure.meta.logs
    );
}

fn funded_keypair(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    kp
}

#[test]
fn init_config_and_init_mint_succeed() {
    let (mut svm, admin_kp) = setup();
    setup_mint(&mut svm, &admin_kp);
}

#[test]
fn init_mint_honours_the_mint_authority_argument() {
    let (mut svm, admin_kp) = setup();
    init_config(&mut svm, &admin_kp);

    let mint_kp = Keypair::new();
    let mint_authority = Pubkey::new_unique();
    let mut args = mint_args(Mode::Block, 0, admin_kp.pubkey(), admin_kp.pubkey());
    args.mint_authority = mint_authority;
    init_mint(&mut svm, &admin_kp, &mint_kp, args);

    let data = svm.get_account(&mint_kp.pubkey()).unwrap().data;
    let mint = StateWithExtensions::<Mint>::unpack(&data).unwrap();
    assert_eq!(
        Option::<Pubkey>::from(mint.base.mint_authority),
        Some(mint_authority),
        "the mint authority must be the one passed in InitMintArgs, not the payer"
    );
}

#[test]
fn unlisted_wallets_can_transfer_in_block_mode() {
    let (mut svm, admin_kp) = setup();
    let mint = setup_block_mode_mint(&mut svm, &admin_kp, admin_kp.pubkey());

    let sender_kp = funded_keypair(&mut svm);
    let source = create_token_account(&mut svm, &admin_kp, &mint, &sender_kp.pubkey(), true);
    let destination = create_token_account(&mut svm, &admin_kp, &mint, &Pubkey::new_unique(), true);
    mint_tokens(&mut svm, &admin_kp, &mint, &source, 1_000);

    hooked_transfer(&mut svm, &sender_kp, &mint, &source, &destination, 400).unwrap();

    assert_eq!(token_balance(&svm, &source), 600);
    assert_eq!(token_balance(&svm, &destination), 400);
}

#[test]
fn blocked_wallet_cannot_send() {
    let (mut svm, admin_kp) = setup();
    let mint = setup_block_mode_mint(&mut svm, &admin_kp, admin_kp.pubkey());

    let blocked_kp = funded_keypair(&mut svm);
    init_wallet(&mut svm, &admin_kp, blocked_kp.pubkey(), false);

    let source = create_token_account(&mut svm, &admin_kp, &mint, &blocked_kp.pubkey(), true);
    let destination = create_token_account(&mut svm, &admin_kp, &mint, &Pubkey::new_unique(), true);
    mint_tokens(&mut svm, &admin_kp, &mint, &source, 1_000);

    let failure = hooked_transfer(&mut svm, &blocked_kp, &mint, &source, &destination, 400)
        .expect_err("a blocked wallet must not be able to send");
    assert_hook_error(&failure, "WalletBlocked");

    assert_eq!(token_balance(&svm, &source), 1_000);
    assert_eq!(token_balance(&svm, &destination), 0);
}

#[test]
fn hook_rejects_a_source_account_without_immutable_owner() {
    let (mut svm, admin_kp) = setup();
    let mint = setup_block_mode_mint(&mut svm, &admin_kp, admin_kp.pubkey());

    let blocked_kp = funded_keypair(&mut svm);
    init_wallet(&mut svm, &admin_kp, blocked_kp.pubkey(), false);

    // A plain (non-ATA) token account without ImmutableOwner, funded while
    // owned by the blocked wallet.
    let source = create_token_account(&mut svm, &admin_kp, &mint, &blocked_kp.pubkey(), false);
    let destination = create_token_account(&mut svm, &admin_kp, &mint, &Pubkey::new_unique(), true);
    mint_tokens(&mut svm, &admin_kp, &mint, &source, 1_000);

    // SetAuthority(AccountOwner) never invokes the transfer hook, so the
    // blocked wallet hands the whole account to a fresh, unlisted wallet...
    let fresh_kp = funded_keypair(&mut svm);
    let reassign = set_authority(
        &TOKEN_22_PROGRAM_ID,
        &source,
        Some(&fresh_kp.pubkey()),
        AuthorityType::AccountOwner,
        &blocked_kp.pubkey(),
        &[],
    )
    .unwrap();
    send(&mut svm, &[&blocked_kp], &[reassign]).unwrap();
    assert_eq!(token_account(&svm, &source).owner, fresh_kp.pubkey());

    // ...and the fresh wallet sends the blocked wallet's tokens out.
    let failure = hooked_transfer(&mut svm, &fresh_kp, &mint, &source, &destination, 400)
        .expect_err("a source token account without ImmutableOwner must be rejected");
    assert_hook_error(&failure, "ImmutableOwnerRequired");

    assert_eq!(token_balance(&svm, &source), 1_000);
    assert_eq!(token_balance(&svm, &destination), 0);
}

#[test]
fn hook_rejects_a_destination_account_without_immutable_owner() {
    let (mut svm, admin_kp) = setup();
    let mint = setup_block_mode_mint(&mut svm, &admin_kp, admin_kp.pubkey());

    let blocked_kp = funded_keypair(&mut svm);
    init_wallet(&mut svm, &admin_kp, blocked_kp.pubkey(), false);

    let sender_kp = funded_keypair(&mut svm);
    let source = create_token_account(&mut svm, &admin_kp, &mint, &sender_kp.pubkey(), true);
    mint_tokens(&mut svm, &admin_kp, &mint, &source, 1_000);

    // The destination is owned by an unlisted wallet at transfer time...
    let mule_kp = funded_keypair(&mut svm);
    let destination = create_token_account(&mut svm, &admin_kp, &mint, &mule_kp.pubkey(), false);

    let failure = hooked_transfer(&mut svm, &sender_kp, &mint, &source, &destination, 400)
        .expect_err("a destination token account without ImmutableOwner must be rejected");
    assert_hook_error(&failure, "ImmutableOwnerRequired");

    assert_eq!(token_balance(&svm, &source), 1_000);
    assert_eq!(token_balance(&svm, &destination), 0);

    // ...because otherwise it could be handed to the blocked wallet afterwards
    // without the hook ever seeing the transfer.
    let reassign = set_authority(
        &TOKEN_22_PROGRAM_ID,
        &destination,
        Some(&blocked_kp.pubkey()),
        AuthorityType::AccountOwner,
        &mule_kp.pubkey(),
        &[],
    )
    .unwrap();
    send(&mut svm, &[&mule_kp], &[reassign]).unwrap();
    assert_eq!(token_account(&svm, &destination).owner, blocked_kp.pubkey());
}

#[test]
fn permanent_delegate_can_claw_back_from_a_blocked_wallet() {
    let (mut svm, admin_kp) = setup();
    let delegate_kp = funded_keypair(&mut svm);
    let mint = setup_block_mode_mint(&mut svm, &admin_kp, delegate_kp.pubkey());

    let blocked_kp = funded_keypair(&mut svm);
    init_wallet(&mut svm, &admin_kp, blocked_kp.pubkey(), false);

    let source = create_token_account(&mut svm, &admin_kp, &mint, &blocked_kp.pubkey(), true);
    let treasury = create_token_account(&mut svm, &admin_kp, &mint, &admin_kp.pubkey(), true);
    mint_tokens(&mut svm, &admin_kp, &mint, &source, 1_000);

    hooked_transfer(&mut svm, &delegate_kp, &mint, &source, &treasury, 1_000)
        .expect("the permanent delegate must be able to claw back from a blocked wallet");

    assert_eq!(token_balance(&svm, &source), 0);
    assert_eq!(token_balance(&svm, &treasury), 1_000);
}

#[test]
fn permanent_delegate_cannot_send_to_a_blocked_wallet() {
    let (mut svm, admin_kp) = setup();
    let delegate_kp = funded_keypair(&mut svm);
    let mint = setup_block_mode_mint(&mut svm, &admin_kp, delegate_kp.pubkey());

    let blocked_kp = funded_keypair(&mut svm);
    init_wallet(&mut svm, &admin_kp, blocked_kp.pubkey(), false);

    let source = create_token_account(&mut svm, &admin_kp, &mint, &Pubkey::new_unique(), true);
    let destination = create_token_account(&mut svm, &admin_kp, &mint, &blocked_kp.pubkey(), true);
    mint_tokens(&mut svm, &admin_kp, &mint, &source, 1_000);

    let failure = hooked_transfer(&mut svm, &delegate_kp, &mint, &source, &destination, 400)
        .expect_err("destination rules still apply to the permanent delegate");
    assert_hook_error(&failure, "WalletBlocked");

    assert_eq!(token_balance(&svm, &source), 1_000);
    assert_eq!(token_balance(&svm, &destination), 0);
}

#[test]
fn resize_meta_list_succeeds_and_is_idempotent() {
    let (mut svm, admin_kp) = setup();
    let admin_pk = admin_kp.pubkey();
    let (mint_pk, meta_list) = setup_mint(&mut svm, &admin_kp);

    // Fresh mints already get the current (2-entry) layout, so this is the
    // idempotent case: resizing to the same size and rewriting identical
    // content must still succeed and leave a well-formed account behind.
    let before = svm.get_account(&meta_list).unwrap().data;
    assert_eq!(before.len(), abl_token::get_meta_list_size().unwrap());

    let resize_ix = abl_token::instruction::ResizeMetaList {};
    let resize_accounts = ResizeMetaList {
        payer: admin_pk,
        mint: mint_pk,
        extra_metas_account: meta_list,
        system_program: SYSTEM_PROGRAM_ID,
        token_program: TOKEN_22_PROGRAM_ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: resize_accounts.to_account_metas(None),
        data: resize_ix.data(),
    };
    let msg = Message::new(&[instruction], Some(&admin_pk));
    let tx = Transaction::new(&[&admin_kp], msg, svm.latest_blockhash());

    svm.send_transaction(tx).unwrap();

    let after = svm.get_account(&meta_list).unwrap().data;
    assert_eq!(after.len(), abl_token::get_meta_list_size().unwrap());
    assert_eq!(after, before);
}

#[test]
fn resize_meta_list_is_permissionless() {
    // Deliberately permissionless: gating this on the mint's transfer-hook
    // authority would permanently strand any mint whose authority was
    // revoked, since the content written doesn't depend on who calls it.
    let (mut svm, admin_kp) = setup();
    let (mint_pk, meta_list) = setup_mint(&mut svm, &admin_kp);

    let stranger_kp = Keypair::new();
    let stranger_pk = stranger_kp.pubkey();
    svm.airdrop(&stranger_pk, 10 * LAMPORTS_PER_SOL).unwrap();

    let resize_ix = abl_token::instruction::ResizeMetaList {};
    let resize_accounts = ResizeMetaList {
        payer: stranger_pk,
        mint: mint_pk,
        extra_metas_account: meta_list,
        system_program: SYSTEM_PROGRAM_ID,
        token_program: TOKEN_22_PROGRAM_ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: resize_accounts.to_account_metas(None),
        data: resize_ix.data(),
    };
    let msg = Message::new(&[instruction], Some(&stranger_pk));
    let tx = Transaction::new(&[&stranger_kp], msg, svm.latest_blockhash());

    svm.send_transaction(tx).unwrap();
}

#[test]
fn resize_meta_list_rejects_a_mint_not_using_this_hook() {
    let (mut svm, admin_kp) = setup();
    let admin_pk = admin_kp.pubkey();

    // A mint whose TransferHook extension points at some other program.
    let mint_kp = Keypair::new();
    let mint_pk = mint_kp.pubkey();
    let other_program = Pubkey::new_unique();

    let space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[ExtensionType::TransferHook])
        .unwrap();
    let rent = svm.minimum_balance_for_rent_exemption(space);

    let create_ix = create_account(&admin_pk, &mint_pk, rent, space as u64, &TOKEN_22_PROGRAM_ID);
    let init_hook_ix =
        transfer_hook::instruction::initialize(&TOKEN_22_PROGRAM_ID, &mint_pk, Some(admin_pk), Some(other_program))
            .unwrap();
    let init_mint_ix = initialize_mint2(&TOKEN_22_PROGRAM_ID, &mint_pk, &admin_pk, None, 6).unwrap();

    let tx = Transaction::new(
        &[&admin_kp, &mint_kp],
        Message::new(&[create_ix, init_hook_ix, init_mint_ix], Some(&admin_pk)),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    let meta_list = derive_meta_list(&mint_pk);
    let resize_ix = abl_token::instruction::ResizeMetaList {};
    let resize_accounts = ResizeMetaList {
        payer: admin_pk,
        mint: mint_pk,
        extra_metas_account: meta_list,
        system_program: SYSTEM_PROGRAM_ID,
        token_program: TOKEN_22_PROGRAM_ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: resize_accounts.to_account_metas(None),
        data: resize_ix.data(),
    };
    let msg = Message::new(&[instruction], Some(&admin_pk));
    let tx = Transaction::new(&[&admin_kp], msg, svm.latest_blockhash());

    let res = svm.send_transaction(tx);
    assert!(res.is_err(), "resizing a mint that isn't using this hook program must be rejected");
}

#[test]
fn resize_meta_list_migrates_a_mint_created_under_the_old_one_entry_layout() {
    let (mut svm, admin_kp) = setup();
    let admin_pk = admin_kp.pubkey();
    let (mint_pk, meta_list) = setup_mint(&mut svm, &admin_kp);

    // Overwrite the freshly-created (already-correct, 2-entry) meta list with
    // what a mint set up under the *old* program would actually have on
    // chain: a single entry resolving only the destination wallet. This is
    // the exact stale state Greptile flagged - upgrading the program alone
    // doesn't rewrite already-initialized accounts.
    let old_metas = vec![ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes: b"ab_wallet".to_vec() },
            Seed::AccountData { account_index: 2, data_index: 32, length: 32 },
        ],
        false,
        false,
    )
    .unwrap()];
    let old_size = ExtraAccountMetaList::size_of(old_metas.len()).unwrap();
    let mut old_data = vec![0u8; old_size];
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut old_data, &old_metas).unwrap();

    let current_account = svm.get_account(&meta_list).unwrap();
    svm.set_account(
        meta_list,
        Account { lamports: svm.minimum_balance_for_rent_exemption(old_size), data: old_data, ..current_account },
    )
    .unwrap();
    assert_eq!(svm.get_account(&meta_list).unwrap().data.len(), old_size);

    let resize_ix = abl_token::instruction::ResizeMetaList {};
    let resize_accounts = ResizeMetaList {
        payer: admin_pk,
        mint: mint_pk,
        extra_metas_account: meta_list,
        system_program: SYSTEM_PROGRAM_ID,
        token_program: TOKEN_22_PROGRAM_ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: resize_accounts.to_account_metas(None),
        data: resize_ix.data(),
    };
    let msg = Message::new(&[instruction], Some(&admin_pk));
    let tx = Transaction::new(&[&admin_kp], msg, svm.latest_blockhash());
    svm.send_transaction(tx).unwrap();

    let new_size = abl_token::get_meta_list_size().unwrap();
    let mut expected_data = vec![0u8; new_size];
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut expected_data,
        &abl_token::get_extra_account_metas().unwrap(),
    )
    .unwrap();

    let migrated = svm.get_account(&meta_list).unwrap();
    assert_eq!(migrated.data.len(), new_size, "meta list must be resized to the current 2-entry layout");
    assert_eq!(migrated.data, expected_data, "migrated meta list must match a freshly-initialized one exactly");
}

fn derive_config() -> Pubkey {
    let seeds = &[b"config".as_ref()];
    Pubkey::find_program_address(seeds, &PROGRAM_ID).0
}

fn derive_meta_list(mint: &Pubkey) -> Pubkey {
    let seeds = &[b"extra-account-metas", mint.as_ref()];
    Pubkey::find_program_address(seeds, &PROGRAM_ID).0
}

fn derive_ab_wallet(wallet: &Pubkey) -> Pubkey {
    let seeds = &[b"ab_wallet", wallet.as_ref()];
    Pubkey::find_program_address(seeds, &PROGRAM_ID).0
}
