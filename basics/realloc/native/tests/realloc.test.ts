import {
    type Address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    generateKeyPairSigner,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { assert } from 'chai';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
    addressInfoDecoder,
    createCreateInstruction,
    createReallocateWithoutZeroInitInstruction,
    createReallocateZeroInitInstruction,
    enhancedAddressInfoDecoder,
    workInfoDecoder,
} from '../ts';

// Serialized `EnhancedAddressInfo` for the values used below (borsh: 4-byte length-prefixed strings).
const enhancedAddressInfoLength = 4 + 5 + 1 + 4 + 8 + 4 + 7 + 4 + 8 + 4;
// LiteSVM's default fee for a single-signature transaction.
const TRANSACTION_FEE = 5_000n;

describe('Realloc!', () => {
    const svm = new LiteSVM();
    let programId: Address;
    let payer: KeyPairSigner;
    let testAccount: KeyPairSigner;

    before(async () => {
        programId = (await generateKeyPairSigner()).address;
        svm.addProgramFromFile(programId, 'tests/fixtures/realloc_program.so');
        payer = await generateKeyPairSigner();
        svm.airdrop(payer.address, lamports(1_000_000_000n));
        testAccount = await generateKeyPairSigner();
    });

    async function sendTransaction(ix: Instruction) {
        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);
        const result = svm.sendTransaction(signedTx);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);
    }

    it('Create the account with data', async () => {
        console.log(`${testAccount.address}`);
        const ix = createCreateInstruction(testAccount, payer, programId, 'Jacob', 123, 'Main St.', 'Chicago');

        await sendTransaction(ix);

        printAddressInfo(testAccount.address);
    });

    it('Reallocate WITHOUT zero init', async () => {
        const ix = createReallocateWithoutZeroInitInstruction(testAccount.address, payer, programId, 'Illinois', 12345);

        await sendTransaction(ix);

        printEnhancedAddressInfo(testAccount.address);
    });

    it('Reallocate WITH zero init', async () => {
        const ix = createReallocateZeroInitInstruction(
            testAccount.address,
            payer.address,
            programId,
            'Pete',
            'Engineer',
            'Solana Labs',
            2,
        );

        await sendTransaction(ix);

        printWorkInfo(testAccount.address);
    });

    it('Reallocate WITHOUT zero init when the account already holds more than the new rent-exempt minimum', async () => {
        const overfundedAccount = await generateKeyPairSigner();
        await sendTransaction(
            createCreateInstruction(overfundedAccount, payer, programId, 'Jacob', 123, 'Main St.', 'Chicago'),
        );

        // Anyone can push the account above the enlarged rent-exempt minimum with a plain system transfer.
        const enlargedMinimum = svm.minimumBalanceForRentExemption(BigInt(enhancedAddressInfoLength));
        await sendTransaction(
            getTransferSolInstruction({
                amount: lamports(enlargedMinimum),
                destination: overfundedAccount.address,
                source: payer,
            }),
        );

        const targetLamportsBefore = svm.getBalance(overfundedAccount.address);
        const payerLamportsBefore = svm.getBalance(payer.address);
        assert(targetLamportsBefore !== null && payerLamportsBefore !== null);
        assert(targetLamportsBefore > enlargedMinimum);

        const ix = createReallocateWithoutZeroInitInstruction(
            overfundedAccount.address,
            payer,
            programId,
            'Illinois',
            12345,
        );
        await sendTransaction(ix);

        const account = svm.getAccount(overfundedAccount.address);
        assert(account.exists, 'test account not found');
        assert.strictEqual(account.data.length, enhancedAddressInfoLength);
        const enhancedAddressInfo = enhancedAddressInfoDecoder.decode(account.data);
        assert.strictEqual(enhancedAddressInfo.name, 'Jacob');
        assert.strictEqual(enhancedAddressInfo.house_number, 123);
        assert.strictEqual(enhancedAddressInfo.street, 'Main St.');
        assert.strictEqual(enhancedAddressInfo.city, 'Chicago');
        assert.strictEqual(enhancedAddressInfo.state, 'Illinois');
        assert.strictEqual(enhancedAddressInfo.zip, 12345);

        // No top-up was needed: the target keeps its balance and the payer only pays the transaction fee.
        assert.strictEqual(svm.getBalance(overfundedAccount.address), targetLamportsBefore);
        assert.strictEqual(payerLamportsBefore - svm.getBalance(payer.address)!, TRANSACTION_FEE);
    });

    function printAddressInfo(address: Address): void {
        const account = svm.getAccount(address);
        if (account.exists) {
            const addressInfo = addressInfoDecoder.decode(account.data);
            console.log('Address info:');
            console.log(`   Name:       ${addressInfo.name}`);
            console.log(`   House Num:  ${addressInfo.house_number}`);
            console.log(`   Street:     ${addressInfo.street}`);
            console.log(`   City:       ${addressInfo.city}`);
        }
    }

    function printEnhancedAddressInfo(address: Address): void {
        const account = svm.getAccount(address);
        if (account.exists) {
            const enhancedAddressInfo = enhancedAddressInfoDecoder.decode(account.data);
            console.log('Enhanced Address info:');
            console.log(`   Name:       ${enhancedAddressInfo.name}`);
            console.log(`   House Num:  ${enhancedAddressInfo.house_number}`);
            console.log(`   Street:     ${enhancedAddressInfo.street}`);
            console.log(`   City:       ${enhancedAddressInfo.city}`);
            console.log(`   State:      ${enhancedAddressInfo.state}`);
            console.log(`   Zip:        ${enhancedAddressInfo.zip}`);
        }
    }

    function printWorkInfo(address: Address): void {
        const account = svm.getAccount(address);
        if (account.exists) {
            const workInfo = workInfoDecoder.decode(account.data);
            console.log('Work info:');
            console.log(`   Name:       ${workInfo.name}`);
            console.log(`   Position:   ${workInfo.position}`);
            console.log(`   Company:    ${workInfo.company}`);
            console.log(`   Years:      ${workInfo.years_employed}`);
        }
    }
});
