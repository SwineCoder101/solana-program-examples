use close_account_native_program::state::user::User;
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::{Keypair, Signer};
use solana_native_token::LAMPORTS_PER_SOL;
use solana_pubkey::Pubkey;
use solana_transaction::Transaction;

use close_account_native_program::processor::MyInstruction;

// LiteSVM's default fee for a single-signature transaction.
const TX_FEE: u64 = 5000;

#[test]
fn test_close_account() {
    let mut svm = LiteSVM::new();

    let program_id = Pubkey::new_unique();
    let program_bytes = include_bytes!("../../tests/fixtures/close_account_native_program.so");

    svm.add_program(program_id, program_bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), LAMPORTS_PER_SOL * 10).unwrap();

    let test_account_pubkey =
        Pubkey::find_program_address(&[b"USER".as_ref(), &payer.pubkey().as_ref()], &program_id).0;

    // create user ix
    let data = borsh::to_vec(&MyInstruction::CreateUser(User { name: "Jacob".to_string() })).unwrap();

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(test_account_pubkey, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(solana_system_interface::program::ID, false),
        ],
        data,
    };

    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], svm.latest_blockhash());

    assert!(svm.send_transaction(tx).is_ok());

    // close user ix with a bogus system program account
    let bogus_program = Pubkey::new_unique();
    let data = borsh::to_vec(&MyInstruction::CloseUser).unwrap();

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(test_account_pubkey, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(bogus_program, false),
        ],
        data,
    };

    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], svm.latest_blockhash());

    let err = svm.send_transaction(tx).expect_err("expected the bogus system program to be rejected").err;
    assert!(format!("{err:?}").contains("IncorrectProgramId"), "unexpected error: {err:?}");
    assert_eq!(svm.get_account(&test_account_pubkey).unwrap().owner, program_id);

    // close user ix
    let payer_balance_before = svm.get_balance(&payer.pubkey()).unwrap();
    let account_balance_before = svm.get_balance(&test_account_pubkey).unwrap();
    assert!(account_balance_before > 0);

    let data = borsh::to_vec(&MyInstruction::CloseUser).unwrap();

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(test_account_pubkey, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(solana_system_interface::program::ID, false),
        ],
        data,
    };

    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], svm.latest_blockhash());

    assert!(svm.send_transaction(tx).is_ok());

    // Closing drains every lamport back to the payer and deletes the account.
    assert!(svm.get_account(&test_account_pubkey).is_none(), "expected the closed account to no longer exist");
    assert_eq!(svm.get_balance(&payer.pubkey()).unwrap(), payer_balance_before + account_balance_before - TX_FEE);

    // re-create user ix after closing
    let data = borsh::to_vec(&MyInstruction::CreateUser(User { name: "Jacob".to_string() })).unwrap();

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(test_account_pubkey, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(solana_system_interface::program::ID, false),
        ],
        data,
    };

    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], svm.latest_blockhash());

    let res = svm.send_transaction(tx);
    assert!(res.is_ok(), "expected the account to be re-creatable after closing: {res:?}");

    let account = svm.get_account(&test_account_pubkey).unwrap();
    assert_eq!(account.owner, program_id);
    assert_eq!(borsh::from_slice::<User>(&account.data).unwrap().name, "Jacob");
}
