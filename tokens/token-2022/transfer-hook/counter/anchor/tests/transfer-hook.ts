import type { Program } from '@anchor-lang/core';
import * as anchor from '@anchor-lang/core';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createInitializeMintInstruction,
    createInitializeTransferHookInstruction,
    createMintToInstruction,
    createTransferCheckedWithTransferHookInstruction,
    ExtensionType,
    getAccount,
    getAssociatedTokenAddressSync,
    getMintLen,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
    Keypair,
    PublicKey,
    SendTransactionError,
    SystemProgram,
    sendAndConfirmTransaction,
    Transaction,
} from '@solana/web3.js';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import type { TransferHook } from '../target/types/transfer_hook';

use(chaiAsPromised);

describe('transfer-hook', () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.TransferHook as Program<TransferHook>;
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    // Generate keypair to use as address for the transfer-hook enabled mint
    const mint = new Keypair();
    const decimals = 9;

    // Sender token account address
    const sourceTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // Recipient token account address
    const recipient = Keypair.generate();
    const destinationTokenAccount = getAssociatedTokenAddressSync(
        mint.publicKey,
        recipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // ExtraAccountMetaList address
    // Store extra accounts required by the custom transfer hook instruction
    const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('extra-account-metas'), mint.publicKey.toBuffer()],
        program.programId,
    );

    // Per-mint transfer counter PDA
    const [counterPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('counter'), mint.publicKey.toBuffer()],
        program.programId,
    );

    // Number of hook-gated transfers executed against `mint` so far
    let transfersSoFar = 0;

    async function transferWithHook(
        mintPubkey: PublicKey,
        source: PublicKey,
        destination: PublicKey,
        amount: bigint,
    ): Promise<string> {
        const ix = await createTransferCheckedWithTransferHookInstruction(
            connection,
            source,
            mintPubkey,
            destination,
            wallet.publicKey,
            amount,
            decimals,
            [],
            'confirmed',
            TOKEN_2022_PROGRAM_ID,
        );
        return sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet.payer], {
            skipPreflight: true,
            commitment: 'confirmed',
        });
    }

    // Create a transfer-hook mint plus funded source / destination token accounts
    async function createHookedMint(newMint: Keypair, recipientOwner: PublicKey) {
        const mintLen = getMintLen([ExtensionType.TransferHook]);
        const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
        const source = getAssociatedTokenAddressSync(
            newMint.publicKey,
            wallet.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const destination = getAssociatedTokenAddressSync(
            newMint.publicKey,
            recipientOwner,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        const transaction = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: newMint.publicKey,
                space: mintLen,
                lamports,
                programId: TOKEN_2022_PROGRAM_ID,
            }),
            createInitializeTransferHookInstruction(
                newMint.publicKey,
                wallet.publicKey,
                program.programId,
                TOKEN_2022_PROGRAM_ID,
            ),
            createInitializeMintInstruction(newMint.publicKey, decimals, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                source,
                wallet.publicKey,
                newMint.publicKey,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                destination,
                recipientOwner,
                newMint.publicKey,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createMintToInstruction(
                newMint.publicKey,
                source,
                wallet.publicKey,
                100 * 10 ** decimals,
                [],
                TOKEN_2022_PROGRAM_ID,
            ),
        );
        await sendAndConfirmTransaction(connection, transaction, [wallet.payer, newMint], {
            skipPreflight: true,
            commitment: 'confirmed',
        });

        return { source, destination };
    }

    it('Create Mint Account with Transfer Hook Extension', async () => {
        const extensions = [ExtensionType.TransferHook];
        const mintLen = getMintLen(extensions);
        const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

        const transaction = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mint.publicKey,
                space: mintLen,
                lamports: lamports,
                programId: TOKEN_2022_PROGRAM_ID,
            }),
            createInitializeTransferHookInstruction(
                mint.publicKey,
                wallet.publicKey,
                program.programId, // Transfer Hook Program ID
                TOKEN_2022_PROGRAM_ID,
            ),
            createInitializeMintInstruction(mint.publicKey, decimals, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
        );

        const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer, mint], {
            skipPreflight: true,
            commitment: 'confirmed',
        });

        const txDetails = await program.provider.connection.getTransaction(txSig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });
        console.log(txDetails.meta.logMessages);

        console.log(`Transaction Signature: ${txSig}`);
    });

    // Create the two token accounts for the transfer-hook enabled mint
    // Fund the sender token account with 100 tokens
    it('Create Token Accounts and Mint Tokens', async () => {
        // 100 tokens
        const amount = 100 * 10 ** decimals;

        const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                sourceTokenAccount,
                wallet.publicKey,
                mint.publicKey,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                destinationTokenAccount,
                recipient.publicKey,
                mint.publicKey,
                TOKEN_2022_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createMintToInstruction(
                mint.publicKey,
                sourceTokenAccount,
                wallet.publicKey,
                amount,
                [],
                TOKEN_2022_PROGRAM_ID,
            ),
        );

        const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });

        console.log(`Transaction Signature: ${txSig}`);
    });

    // Account to store extra accounts required by the transfer hook instruction
    it('Create ExtraAccountMetaList Account', async () => {
        const initializeExtraAccountMetaListInstruction = await program.methods
            .initializeExtraAccountMetaList()
            .accounts({
                mint: mint.publicKey,
            })
            .instruction();

        const transaction = new Transaction().add(initializeExtraAccountMetaListInstruction);

        const txSig = await sendAndConfirmTransaction(provider.connection, transaction, [wallet.payer], {
            skipPreflight: true,
            commitment: 'confirmed',
        });
        console.log('Transaction Signature:', txSig);
    });

    it('Transfer Hook with Extra Account Meta', async () => {
        // 1 tokens
        const amount = 1 * 10 ** decimals;
        const amountBigInt = BigInt(amount);

        const transferInstructionWithHelper = await createTransferCheckedWithTransferHookInstruction(
            connection,
            sourceTokenAccount,
            mint.publicKey,
            destinationTokenAccount,
            wallet.publicKey,
            amountBigInt,
            decimals,
            [],
            'confirmed',
            TOKEN_2022_PROGRAM_ID,
        );

        console.log(`Extra accounts meta: ${extraAccountMetaListPDA}`);
        console.log(`Counter PDA: ${counterPDA}`);
        console.log(`Transfer Instruction: ${JSON.stringify(transferInstructionWithHelper)}`);

        const transaction = new Transaction().add(transferInstructionWithHelper);

        const txSig = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], { skipPreflight: true });
        transfersSoFar += 1;
        console.log('Transfer Signature:', txSig);
    });

    it('Counter PDA records every transfer', async () => {
        const amount = BigInt(1 * 10 ** decimals);

        for (let i = 0; i < 3; i++) {
            await transferWithHook(mint.publicKey, sourceTokenAccount, destinationTokenAccount, amount);
            transfersSoFar += 1;
        }

        const counterAccount = await program.account.counterAccount.fetch(counterPDA);
        expect(counterAccount.counter.toNumber()).to.equal(transfersSoFar);
    });

    it('Set up the transfer hook for a second mint', async () => {
        const secondMint = Keypair.generate();
        const { source, destination } = await createHookedMint(secondMint, Keypair.generate().publicKey);

        const initializeExtraAccountMetaListInstruction = await program.methods
            .initializeExtraAccountMetaList()
            .accounts({ mint: secondMint.publicKey })
            .instruction();
        const txSig = await sendAndConfirmTransaction(
            connection,
            new Transaction().add(initializeExtraAccountMetaListInstruction),
            [wallet.payer],
            { skipPreflight: true, commitment: 'confirmed' },
        );
        console.log('Second mint ExtraAccountMetaList Signature:', txSig);

        await transferWithHook(secondMint.publicKey, source, destination, BigInt(1 * 10 ** decimals));

        const destinationAccount = await getAccount(connection, destination, 'confirmed', TOKEN_2022_PROGRAM_ID);
        expect(destinationAccount.amount).to.equal(BigInt(1 * 10 ** decimals));

        // Each mint gets its own counter
        const [secondCounterPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('counter'), secondMint.publicKey.toBuffer()],
            program.programId,
        );
        const secondCounter = await program.account.counterAccount.fetch(secondCounterPDA);
        expect(secondCounter.counter.toNumber()).to.equal(1);
        const firstCounter = await program.account.counterAccount.fetch(counterPDA);
        expect(firstCounter.counter.toNumber()).to.equal(transfersSoFar);
    });

    it('Try call transfer hook without transfer', async () => {
        const transferHookIx = await program.methods
            .transferHook(new anchor.BN(1))
            .accounts({
                sourceToken: sourceTokenAccount,
                mint: mint.publicKey,
                destinationToken: destinationTokenAccount,
                owner: wallet.publicKey,
            })
            .instruction();

        const transaction = new Transaction().add(transferHookIx);

        const sendPromise = sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
            skipPreflight: false,
        });

        await expect(sendPromise).to.eventually.be.rejectedWith(SendTransactionError, program.idl.errors[1].msg);
    });
});
