import { createHash } from 'node:crypto';
import {
    type AccountMeta,
    AccountRole,
    type AccountSignerMeta,
    type Address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressCodec,
    getProgramDerivedAddress,
    getStructEncoder,
    getU8Encoder,
    getU64Encoder,
    type Instruction,
    isOffCurveAddress,
    type KeyPairSigner,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { assert } from 'chai';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';

const INIT_RENT_VAULT_DISCRIMINATOR = 0;
const CREATE_NEW_ACCOUNT_DISCRIMINATOR = 1;
const FUND_LAMPORTS = 1_000_000_000n;

const initRentVaultEncoder = getStructEncoder([
    ['discriminator', getU8Encoder()],
    ['bump', getU8Encoder()],
    ['lamports', getU64Encoder()],
]);

describe('PDA Rent-Payer', () => {
    const svm = new LiteSVM();
    let programId: Address;
    let payer: KeyPairSigner;
    let rentVaultPda: Address;
    let bump: number;
    let rentExemptBalance: bigint;

    before(async () => {
        programId = (await generateKeyPairSigner()).address;
        svm.addProgramFromFile(programId, 'tests/fixtures/pda_rent_payer_pinocchio_program.so');

        payer = await generateKeyPairSigner();
        svm.airdrop(payer.address, lamports(10_000_000_000n));

        [rentVaultPda, bump] = await getProgramDerivedAddress({
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

    function initRentVaultInstruction(vault: Address, vaultBump: number) {
        return {
            programAddress: programId,
            accounts: [
                { address: vault, role: AccountRole.WRITABLE },
                { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
                { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            ],
            data: initRentVaultEncoder.encode({
                discriminator: INIT_RENT_VAULT_DISCRIMINATOR,
                bump: vaultBump,
                lamports: FUND_LAMPORTS,
            }),
        };
    }

    function createNewAccountInstruction(
        newAccount: { address: Address; signer?: KeyPairSigner },
        vault: Address,
        vaultBump: number,
    ) {
        const newAccountMeta: AccountMeta | AccountSignerMeta = newAccount.signer
            ? { address: newAccount.address, role: AccountRole.WRITABLE_SIGNER, signer: newAccount.signer }
            : { address: newAccount.address, role: AccountRole.WRITABLE };
        return {
            programAddress: programId,
            accounts: [
                newAccountMeta,
                { address: vault, role: AccountRole.WRITABLE },
                { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            ],
            data: new Uint8Array([CREATE_NEW_ACCOUNT_DISCRIMINATOR, vaultBump]),
        };
    }

    // Highest bump below the canonical one that still lands off-curve: a valid but non-canonical rent vault PDA.
    function findNonCanonicalRentVault(): [Address, number] {
        const addressCodec = getAddressCodec();
        for (let candidate = bump - 1; candidate >= 0; candidate--) {
            const hash = createHash('sha256')
                .update('rent_vault')
                .update(new Uint8Array([candidate]))
                .update(new Uint8Array(addressCodec.encode(programId)))
                .update('ProgramDerivedAddress')
                .digest();
            const address = addressCodec.decode(hash);
            if (isOffCurveAddress(address)) {
                return [address, candidate];
            }
        }
        assert.fail('no non-canonical bump found');
    }

    it('Initialize the Rent Vault', async () => {
        const result = await sendInstruction(initRentVaultInstruction(rentVaultPda, bump));
        assert(!(result instanceof FailedTransactionMetadata), `transaction failed: ${result.toString()}`);

        assert.equal(balance(rentVaultPda), rentExemptBalance + FUND_LAMPORTS);
    });

    it('Create a new account using the Rent Vault', async () => {
        const newAccount = await generateKeyPairSigner();
        const vaultBalanceBefore = balance(rentVaultPda);

        const result = await sendInstruction(
            createNewAccountInstruction({ address: newAccount.address, signer: newAccount }, rentVaultPda, bump),
        );
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

        const result = await sendInstruction(
            createNewAccountInstruction({ address: wallet.address }, rentVaultPda, bump),
        );
        assert(result instanceof FailedTransactionMetadata, 'unsigned new_account must be rejected');

        assert.equal(balance(wallet.address), walletBalanceBefore);
        assert.equal(balance(rentVaultPda), vaultBalanceBefore);
    });

    it('Rejects paying vault lamports into an existing wallet even when it signs', async () => {
        const wallet = await generateKeyPairSigner();
        svm.airdrop(wallet.address, lamports(500_000_000n));
        const walletBalanceBefore = balance(wallet.address);
        const vaultBalanceBefore = balance(rentVaultPda);

        const result = await sendInstruction(
            createNewAccountInstruction({ address: wallet.address, signer: wallet }, rentVaultPda, bump),
        );
        assert(result instanceof FailedTransactionMetadata, 'an already existing new_account must be rejected');

        assert.equal(balance(wallet.address), walletBalanceBefore);
        assert.equal(balance(rentVaultPda), vaultBalanceBefore);
    });

    it('Rejects a non-canonical rent vault bump', async () => {
        const [altVault, altBump] = findNonCanonicalRentVault();
        assert.notEqual(altVault, rentVaultPda);

        // Vaults at alternate bumps can still be initialized; they must not be usable as the rent payer.
        const initResult = await sendInstruction(initRentVaultInstruction(altVault, altBump));
        assert(!(initResult instanceof FailedTransactionMetadata), `transaction failed: ${initResult.toString()}`);
        const altVaultBalanceBefore = balance(altVault);

        const newAccount = await generateKeyPairSigner();
        const result = await sendInstruction(
            createNewAccountInstruction({ address: newAccount.address, signer: newAccount }, altVault, altBump),
        );
        assert(result instanceof FailedTransactionMetadata, 'non-canonical bump must be rejected');

        assert.equal(balance(altVault), altVaultBalanceBefore);
        assert.isNull(svm.getBalance(newAccount.address));
    });
});
