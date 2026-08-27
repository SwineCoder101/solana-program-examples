import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressEncoder,
    getProgramDerivedAddress,
    type KeyPairSigner,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { assert } from 'chai';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { createCloseUserInstruction, createCreateUserInstruction, userDecoder } from '../ts';

// LiteSVM's default fee for a single-signature transaction.
const TX_FEE = 5000n;

describe('Close Account!', () => {
    const svm = new LiteSVM();
    const userName = 'Jacob';
    let programId: Address;
    let payer: KeyPairSigner;
    let testAccountAddress: Address;

    before(async () => {
        programId = (await generateKeyPairSigner()).address;
        svm.addProgramFromFile(programId, 'tests/fixtures/close_account_native_program.so');
        payer = await generateKeyPairSigner();
        svm.airdrop(payer.address, lamports(1_000_000_000n));

        [testAccountAddress] = await getProgramDerivedAddress({
            programAddress: programId,
            seeds: ['USER', getAddressEncoder().encode(payer.address)],
        });
    });

    it('Create the account', async () => {
        const ix = createCreateUserInstruction(testAccountAddress, payer, programId, userName);

        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);

        const result = svm.sendTransaction(signedTx);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        const account = svm.getAccount(testAccountAddress);
        assert(account.exists);
        assert.equal(account.programAddress, programId);
        assert.equal(userDecoder.decode(account.data).name, userName);
    });

    it("An attacker cannot close another user's account", async () => {
        // The attacker signs with their own key, but passes the victim's
        // (payer's) User PDA as the account to close. Without a check that
        // the target PDA actually belongs to the signer, this would drain
        // the victim's account into the attacker's.
        const attacker = await generateKeyPairSigner();
        svm.airdrop(attacker.address, lamports(1_000_000_000n));

        const ix = createCloseUserInstruction(testAccountAddress, attacker, programId);

        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(attacker, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);

        const result = svm.sendTransaction(signedTx);
        assert(result instanceof FailedTransactionMetadata, 'expected the attacker transaction to fail');
        assert.include(
            result.err().toString(),
            'IncorrectProgramId',
            `expected the attacker's target PDA to be rejected as not belonging to them, got: ${result.toString()}`,
        );
    });

    it('Close with a bogus system program account is rejected', async () => {
        // Use a separate user so this test cannot disturb the main account.
        const other = await generateKeyPairSigner();
        svm.airdrop(other.address, lamports(1_000_000_000n));
        const [otherAccountAddress] = await getProgramDerivedAddress({
            programAddress: programId,
            seeds: ['USER', getAddressEncoder().encode(other.address)],
        });

        const createIx = createCreateUserInstruction(otherAccountAddress, other, programId, userName);
        const createTx = await signTransactionMessageWithSigners(
            pipe(
                createTransactionMessage({ version: 0 }),
                m => setTransactionMessageFeePayerSigner(other, m),
                m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
                m => appendTransactionMessageInstruction(createIx, m),
            ),
        );
        const createResult = svm.sendTransaction(createTx);
        assert(!(createResult instanceof FailedTransactionMetadata), `transaction failed: ${createResult.toString()}`);

        const bogusProgram = (await generateKeyPairSigner()).address;
        const closeIx = createCloseUserInstruction(otherAccountAddress, other, programId);
        const ix = {
            ...closeIx,
            accounts: [closeIx.accounts[0], closeIx.accounts[1], { address: bogusProgram, role: AccountRole.READONLY }],
        };

        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(other, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);

        const result = svm.sendTransaction(signedTx);
        assert(result instanceof FailedTransactionMetadata, 'expected the bogus system program to be rejected');
        assert.include(
            result.err().toString(),
            'IncorrectProgramId',
            `expected the bogus system program account to be rejected, got: ${result.toString()}`,
        );

        const account = svm.getAccount(otherAccountAddress);
        assert(account.exists, 'expected the user account to be untouched');
        assert.equal(account.programAddress, programId);
        assert.equal(userDecoder.decode(account.data).name, userName);
    });

    it('Close the account', async () => {
        const payerBalanceBefore = svm.getBalance(payer.address)!;
        const accountBalanceBefore = svm.getBalance(testAccountAddress)!;
        assert(accountBalanceBefore > 0n, 'expected the user account to hold rent lamports');

        const ix = createCloseUserInstruction(testAccountAddress, payer, programId);

        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);

        const result = svm.sendTransaction(signedTx);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        // Closing must drain every lamport back to the payer so the account
        // is deleted by the runtime, not left as a rent-exempt empty shell.
        const account = svm.getAccount(testAccountAddress);
        assert(!account.exists, 'expected the closed account to no longer exist');
        assert.equal(svm.getBalance(testAccountAddress) ?? 0n, 0n);
        assert.equal(
            svm.getBalance(payer.address),
            payerBalanceBefore + accountBalanceBefore - TX_FEE,
            'expected the payer to receive every lamport from the closed account',
        );
    });

    it('Re-create the account after closing it', async () => {
        const ix = createCreateUserInstruction(testAccountAddress, payer, programId, userName);

        svm.expireBlockhash();
        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);

        const result = svm.sendTransaction(signedTx);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        const account = svm.getAccount(testAccountAddress);
        assert(account.exists, 'expected the user account to be re-created');
        assert.equal(account.programAddress, programId);
        assert.equal(userDecoder.decode(account.data).name, userName);
    });
});
