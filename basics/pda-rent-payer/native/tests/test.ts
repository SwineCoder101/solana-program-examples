import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    generateKeyPairSigner,
    getProgramDerivedAddress,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { assert } from 'chai';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
    createCreateNewAccountInstruction,
    createInitRentVaultInstruction,
    createNewAccountEncoder,
    MyInstruction,
} from '../ts';

describe('PDA Rent-Payer', () => {
    const svm = new LiteSVM();
    let programId: Address;
    let payer: KeyPairSigner;
    let rentVaultPda: Address;
    let rentExemptBalance: bigint;

    before(async () => {
        programId = (await generateKeyPairSigner()).address;
        svm.addProgramFromFile(programId, 'tests/fixtures/pda_rent_payer_program.so');
        payer = await generateKeyPairSigner();
        svm.airdrop(payer.address, lamports(2_000_000_000n));

        [rentVaultPda] = await getProgramDerivedAddress({
            programAddress: programId,
            seeds: ['rent_vault'],
        });
        rentExemptBalance = svm.getRent().minimumBalance(0n);
    });

    function balance(address: Address): bigint {
        const value = svm.getBalance(address);
        assert(value !== null, `expected ${address} to exist`);
        return value;
    }

    async function sendInstruction(ix: Instruction) {
        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);
        return svm.sendTransaction(signedTx);
    }

    // Same layout as `createCreateNewAccountInstruction`, but with `new_account` passed as a plain writable account.
    function createNewAccountWithoutSignature(newAccount: Address): Instruction {
        return {
            programAddress: programId,
            accounts: [
                { address: newAccount, role: AccountRole.WRITABLE },
                { address: rentVaultPda, role: AccountRole.WRITABLE },
                { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            ],
            data: createNewAccountEncoder.encode({ instruction: MyInstruction.CreateNewAccount }),
        };
    }

    it('Initialize the Rent Vault', async () => {
        const ix = createInitRentVaultInstruction(rentVaultPda, payer, programId, 1_000_000_000n);

        const result = await sendInstruction(ix);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        assert.equal(balance(rentVaultPda), rentExemptBalance + 1_000_000_000n);
    });

    it('Create a new account using the Rent Vault', async () => {
        const newAccount = await generateKeyPairSigner();
        const vaultBalanceBefore = balance(rentVaultPda);
        const ix = createCreateNewAccountInstruction(newAccount, rentVaultPda, programId);

        const result = await sendInstruction(ix);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        const created = svm.getAccount(newAccount.address);
        assert(created.exists, 'new account was not created');
        assert.equal(created.lamports, rentExemptBalance);
        assert.equal(created.programAddress, SYSTEM_PROGRAM_ADDRESS);
        assert.equal(created.data.length, 0);
        assert.equal(balance(rentVaultPda), vaultBalanceBefore - rentExemptBalance);
    });

    it('Rejects paying vault lamports into an existing wallet that does not sign', async () => {
        const wallet = await generateKeyPairSigner();
        svm.airdrop(wallet.address, lamports(500_000_000n));
        const walletBalanceBefore = balance(wallet.address);
        const vaultBalanceBefore = balance(rentVaultPda);

        const result = await sendInstruction(createNewAccountWithoutSignature(wallet.address));
        assert(result instanceof FailedTransactionMetadata, 'unsigned new_account must be rejected');

        assert.equal(balance(wallet.address), walletBalanceBefore);
        assert.equal(balance(rentVaultPda), vaultBalanceBefore);
    });

    it('Rejects paying vault lamports into an existing wallet even when it signs', async () => {
        const wallet = await generateKeyPairSigner();
        svm.airdrop(wallet.address, lamports(500_000_000n));
        const walletBalanceBefore = balance(wallet.address);
        const vaultBalanceBefore = balance(rentVaultPda);

        const result = await sendInstruction(createCreateNewAccountInstruction(wallet, rentVaultPda, programId));
        assert(result instanceof FailedTransactionMetadata, 'an already existing new_account must be rejected');

        assert.equal(balance(wallet.address), walletBalanceBefore);
        assert.equal(balance(rentVaultPda), vaultBalanceBefore);
    });
});
