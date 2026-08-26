import { createHash } from 'node:crypto';
import {
    type Address,
    appendTransactionMessageInstructions,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressDecoder,
    getAddressEncoder,
    getProgramDerivedAddress,
    getU64Encoder,
    type Instruction,
    isOffCurveAddress,
    type KeyPairSigner,
    pipe,
    setTransactionMessageFeePayerSigner,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstruction,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm';

const addressEncoder = getAddressEncoder();

export const expectRevert = async (promise: Promise<unknown>) => {
    let reverted = false;
    try {
        await promise;
    } catch {
        reverted = true;
    }
    if (!reverted) {
        throw new Error('Expected a revert');
    }
};

// Sends the instructions as one transaction and returns the raw result, for
// tests that expect the transaction to be rejected.
export async function trySendInstructions(svm: LiteSVM, payer: KeyPairSigner, instructions: readonly Instruction[]) {
    const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(payer, m),
        m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
        m => appendTransactionMessageInstructions(instructions, m),
    );
    const signedTx = await signTransactionMessageWithSigners(transactionMessage);
    return svm.sendTransaction(signedTx);
}

export async function sendInstructions(svm: LiteSVM, payer: KeyPairSigner, instructions: readonly Instruction[]) {
    const result = await trySendInstructions(svm, payer, instructions);
    if (result instanceof FailedTransactionMetadata) {
        throw new Error(`transaction failed: ${result.toString()}`);
    }
}

// Finds a bump below the canonical one that still derives a valid (off-curve)
// address for the offer seeds, i.e. a second "valid" PDA for the same
// (maker, id) that `find_program_address` would never return.
export async function findNonCanonicalOfferPda(
    programId: Address,
    maker: Address,
    id: bigint,
    canonicalBump: number,
): Promise<{ address: Address; bump: number }> {
    const seeds = [
        new TextEncoder().encode('offer'),
        addressEncoder.encode(maker),
        getU64Encoder().encode(id),
    ] as const;
    for (let bump = canonicalBump - 1; bump >= 0; bump--) {
        const hash = createHash('sha256');
        for (const part of [
            ...seeds,
            new Uint8Array([bump]),
            addressEncoder.encode(programId),
            new TextEncoder().encode('ProgramDerivedAddress'),
        ]) {
            hash.update(Uint8Array.from(part));
        }
        const address = getAddressDecoder().decode(hash.digest());
        if (isOffCurveAddress(address)) {
            return { address, bump };
        }
    }
    throw new Error('no non-canonical bump derives an off-curve address');
}

export async function mintingTokens({
    svm,
    payer,
    holder,
    mintKeypair,
    mintedAmount = 100,
    decimals = 6,
}: {
    svm: LiteSVM;
    payer: KeyPairSigner;
    holder: KeyPairSigner;
    mintKeypair: KeyPairSigner;
    mintedAmount?: number;
    decimals?: number;
}) {
    const [holderAta] = await findAssociatedTokenPda({
        mint: mintKeypair.address,
        owner: holder.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await sendInstructions(svm, payer, [
        getCreateAccountInstruction({
            payer,
            newAccount: mintKeypair,
            lamports: svm.minimumBalanceForRentExemption(BigInt(getMintSize())),
            space: getMintSize(),
            programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMint2Instruction({
            mint: mintKeypair.address,
            decimals,
            mintAuthority: payer.address,
            freezeAuthority: payer.address,
        }),
    ]);

    await sendInstructions(svm, payer, [
        getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata: holderAta,
            owner: holder.address,
            mint: mintKeypair.address,
        }),
    ]);

    await sendInstructions(svm, payer, [
        getMintToInstruction({
            mint: mintKeypair.address,
            token: holderAta,
            mintAuthority: payer,
            amount: BigInt(mintedAmount) * 10n ** BigInt(decimals),
        }),
    ]);
}

export interface TestValues {
    id: bigint;
    amountA: bigint;
    amountB: bigint;
    maker: KeyPairSigner;
    taker: KeyPairSigner;
    mintAKeypair: KeyPairSigner;
    mintBKeypair: KeyPairSigner;
    offer: Address;
    offerBump: number;
    vault: Address;
    makerAccountA: Address;
    makerAccountB: Address;
    takerAccountA: Address;
    takerAccountB: Address;
    programId: Address;
}

function addressValue(address: Address): bigint {
    return addressEncoder.encode(address).reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
}

type TestValuesDefaults = {
    [K in keyof TestValues]+?: TestValues[K];
};

export async function createValues(defaults?: TestValuesDefaults): Promise<TestValues> {
    const programId = defaults?.programId ?? (await generateKeyPairSigner()).address;
    const id = defaults?.id ?? 0n;
    const maker = defaults?.maker ?? (await generateKeyPairSigner());
    const taker = defaults?.taker ?? (await generateKeyPairSigner());

    // Making sure tokens are in the right order. Only the mint(s) NOT
    // supplied by the caller are ever (re)generated, so a caller-provided
    // mint is never silently discarded.
    let mintAKeypair = defaults?.mintAKeypair ?? (await generateKeyPairSigner());
    let mintBKeypair = defaults?.mintBKeypair ?? (await generateKeyPairSigner());
    while (addressValue(mintBKeypair.address) < addressValue(mintAKeypair.address)) {
        if (!defaults?.mintAKeypair) {
            mintAKeypair = await generateKeyPairSigner();
        } else if (!defaults?.mintBKeypair) {
            mintBKeypair = await generateKeyPairSigner();
        } else {
            throw new Error('mintAKeypair and mintBKeypair were both supplied out of the required address order');
        }
    }

    const [offer, offerBump] = await getProgramDerivedAddress({
        programAddress: programId,
        seeds: ['offer', addressEncoder.encode(maker.address), getU64Encoder().encode(id)],
    });

    const findAta = (mint: Address, owner: Address) =>
        findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });

    const [vault] = await findAta(mintAKeypair.address, offer);
    const [makerAccountA] = await findAta(mintAKeypair.address, maker.address);
    const [makerAccountB] = await findAta(mintBKeypair.address, maker.address);
    const [takerAccountA] = await findAta(mintAKeypair.address, taker.address);
    const [takerAccountB] = await findAta(mintBKeypair.address, taker.address);

    return {
        id,
        maker,
        taker,
        mintAKeypair,
        mintBKeypair,
        offer,
        offerBump,
        vault,
        makerAccountA,
        makerAccountB,
        takerAccountA,
        takerAccountB,
        amountA: defaults?.amountA ?? 4_000_000n,
        amountB: defaults?.amountB ?? 1_000_000n,
        programId,
    };
}
