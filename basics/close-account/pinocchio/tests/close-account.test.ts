import {
    type AccountMeta,
    AccountRole,
    type AccountSignerMeta,
    type Address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    fixDecoderSize,
    fixEncoderSize,
    generateKeyPairSigner,
    getAddressEncoder,
    getProgramDerivedAddress,
    getStructEncoder,
    getU8Encoder,
    getUtf8Decoder,
    getUtf8Encoder,
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

const USER_ACCOUNT_SIZE = 16;
const CREATE_DISCRIMINATOR = 0;
const CLOSE_DISCRIMINATOR = 1;

const createUserEncoder = getStructEncoder([
    ['discriminator', getU8Encoder()],
    ['bump', getU8Encoder()],
    ['name', fixEncoderSize(getUtf8Encoder(), USER_ACCOUNT_SIZE)],
]);

const userNameDecoder = fixDecoderSize(getUtf8Decoder(), USER_ACCOUNT_SIZE);

// LiteSVM's default fee for a single-signature transaction.
const TX_FEE = 5000n;

describe('Close Account!', () => {
    const svm = new LiteSVM();
    let programId: Address;
    let payer: KeyPairSigner;
    let userAccount: Address;
    let bump: number;
    let keys: (AccountMeta | AccountSignerMeta)[];

    before(async () => {
        programId = (await generateKeyPairSigner()).address;
        svm.addProgramFromFile(programId, 'tests/fixtures/close_account_pinocchio_program.so');

        payer = await generateKeyPairSigner();
        svm.airdrop(payer.address, lamports(10_000_000_000n));

        [userAccount, bump] = await getProgramDerivedAddress({
            programAddress: programId,
            seeds: ['USER', getAddressEncoder().encode(payer.address)],
        });

        keys = [
            { address: userAccount, role: AccountRole.WRITABLE },
            { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
            { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ];
    });

    async function sendInstruction(ix: Instruction, feePayer: KeyPairSigner = payer) {
        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayerSigner(feePayer, m),
            m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
            m => appendTransactionMessageInstruction(ix, m),
        );
        const signedTx = await signTransactionMessageWithSigners(transactionMessage);
        return svm.sendTransaction(signedTx);
    }

    it('Create the account', async () => {
        const ix = {
            programAddress: programId,
            accounts: keys,
            data: createUserEncoder.encode({ discriminator: CREATE_DISCRIMINATOR, bump, name: 'Jacob' }),
        };

        const result = await sendInstruction(ix);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        const account = svm.getAccount(userAccount);
        assert(account.exists, 'expected user account to exist');
        assert.equal(account.data.length, USER_ACCOUNT_SIZE);
        assert.equal(account.programAddress, programId, 'expected user account to be owned by the program');
        assert.equal(userNameDecoder.decode(account.data), 'Jacob');
    });

    it('Close with a bogus system program account is rejected', async () => {
        // Use a separate user so this test cannot disturb the main account.
        const other = await generateKeyPairSigner();
        svm.airdrop(other.address, lamports(10_000_000_000n));
        const [otherAccount, otherBump] = await getProgramDerivedAddress({
            programAddress: programId,
            seeds: ['USER', getAddressEncoder().encode(other.address)],
        });

        const createResult = await sendInstruction(
            {
                programAddress: programId,
                accounts: [
                    { address: otherAccount, role: AccountRole.WRITABLE },
                    { address: other.address, role: AccountRole.WRITABLE_SIGNER, signer: other },
                    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
                ],
                data: createUserEncoder.encode({ discriminator: CREATE_DISCRIMINATOR, bump: otherBump, name: 'Jacob' }),
            },
            other,
        );
        assert(!(createResult instanceof FailedTransactionMetadata), `transaction failed: ${createResult.toString()}`);

        const bogusProgram = (await generateKeyPairSigner()).address;
        const result = await sendInstruction(
            {
                programAddress: programId,
                accounts: [
                    { address: otherAccount, role: AccountRole.WRITABLE },
                    { address: other.address, role: AccountRole.WRITABLE_SIGNER, signer: other },
                    { address: bogusProgram, role: AccountRole.READONLY },
                ],
                data: new Uint8Array([CLOSE_DISCRIMINATOR]),
            },
            other,
        );
        assert(result instanceof FailedTransactionMetadata, 'expected the bogus system program to be rejected');
        assert.include(
            result.err().toString(),
            'IncorrectProgramId',
            `expected the bogus system program account to be rejected, got: ${result.toString()}`,
        );

        const account = svm.getAccount(otherAccount);
        assert(account.exists, 'expected the user account to be untouched');
        assert.equal(account.programAddress, programId);
        assert.equal(userNameDecoder.decode(account.data), 'Jacob');
    });

    it('Close the account', async () => {
        const payerBalanceBefore = svm.getBalance(payer.address)!;
        const accountBalanceBefore = svm.getBalance(userAccount)!;
        assert(accountBalanceBefore > 0n, 'expected the user account to hold rent lamports');

        const ix = {
            programAddress: programId,
            accounts: keys,
            data: new Uint8Array([CLOSE_DISCRIMINATOR]),
        };

        const result = await sendInstruction(ix);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        // Closing must drain every lamport back to the payer so the account
        // is deleted by the runtime, not left as a rent-exempt empty shell.
        const account = svm.getAccount(userAccount);
        assert(!account.exists, 'expected the closed account to no longer exist');
        assert.equal(svm.getBalance(userAccount) ?? 0n, 0n);
        assert.equal(
            svm.getBalance(payer.address),
            payerBalanceBefore + accountBalanceBefore - TX_FEE,
            'expected the payer to receive every lamport from the closed account',
        );
    });

    it('Re-create the account after closing it', async () => {
        const ix = {
            programAddress: programId,
            accounts: keys,
            data: createUserEncoder.encode({ discriminator: CREATE_DISCRIMINATOR, bump, name: 'Jacob' }),
        };

        svm.expireBlockhash();
        const result = await sendInstruction(ix);
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        const account = svm.getAccount(userAccount);
        assert(account.exists, 'expected the user account to be re-created');
        assert.equal(account.programAddress, programId);
        assert.equal(userNameDecoder.decode(account.data), 'Jacob');
    });
});
