import * as anchor from '@anchor-lang/core';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createInitializeMint2Instruction,
    createMintToInstruction,
    createTransferInstruction,
    getAssociatedTokenAddressSync,
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { getTokenDecoder } from '@solana-program/token';
import { LiteSVMProvider } from 'anchor-litesvm';
import { assert } from 'chai';
import { LiteSVM } from 'litesvm';
import IDL from '../target/idl/fundraiser.json';
import type { Fundraiser } from '../target/types/fundraiser';
import { expectAnchorError } from './utils';

const PROGRAM_ID = new PublicKey(IDL.address);
const SECONDS_PER_DAY = 86400n;

const DECIMALS = 6;
const ONE_TOKEN = 10 ** DECIMALS;
// 30 tokens: the per-contributor cap (10%) is then 3 tokens, so whole-token
// contributions fit under it.
const AMOUNT_TO_RAISE = 30 * ONE_TOKEN;

describe('fundraiser minimums and accounting', () => {
    const client = new LiteSVM();
    client.addProgramFromFile(PROGRAM_ID, 'target/deploy/fundraiser.so');
    const provider = new LiteSVMProvider(client);
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const program = new anchor.Program<Fundraiser>(IDL, provider);

    // The provider wallet is both the mint authority and the contributor.
    let mint: PublicKey;
    let contributorATA: PublicKey;

    const tokenBalance = (account: PublicKey) => getTokenDecoder().decode(client.getAccount(account).data).amount;

    const fundraiserPda = (maker: PublicKey) =>
        PublicKey.findProgramAddressSync([Buffer.from('fundraiser'), maker.toBuffer()], program.programId)[0];

    const contributorPda = (fundraiser: PublicKey) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from('contributor'), fundraiser.toBuffer(), wallet.publicKey.toBuffer()],
            program.programId,
        )[0];

    const newMaker = () => {
        const maker = anchor.web3.Keypair.generate();
        client.airdrop(maker.publicKey, BigInt(anchor.web3.LAMPORTS_PER_SOL));
        return maker;
    };

    const initialize = (maker: anchor.web3.Keypair, amount: number, duration: number) =>
        program.methods
            .initialize(new anchor.BN(amount), duration)
            .accountsPartial({
                maker: maker.publicKey,
                fundraiser: fundraiserPda(maker.publicKey),
                mintToRaise: mint,
                vault: getAssociatedTokenAddressSync(mint, fundraiserPda(maker.publicKey), true),
                systemProgram: anchor.web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([maker])
            .rpc();

    const contribute = (maker: PublicKey, amount: number) => {
        const fundraiser = fundraiserPda(maker);
        return program.methods
            .contribute(new anchor.BN(amount))
            .accountsPartial({
                contributor: wallet.publicKey,
                fundraiser,
                contributorAccount: contributorPda(fundraiser),
                contributorAta: contributorATA,
                vault: getAssociatedTokenAddressSync(mint, fundraiser, true),
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    };

    it('sets up a 6-decimal mint and funds the contributor', async () => {
        const mintKeypair = anchor.web3.Keypair.generate();
        mint = mintKeypair.publicKey;
        contributorATA = getAssociatedTokenAddressSync(mint, wallet.publicKey);

        const lamports = await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
        const setupTx = new anchor.web3.Transaction().add(
            anchor.web3.SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mint,
                space: MINT_SIZE,
                lamports,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMint2Instruction(mint, DECIMALS, wallet.publicKey, wallet.publicKey),
            createAssociatedTokenAccountInstruction(wallet.publicKey, contributorATA, wallet.publicKey, mint),
            createMintToInstruction(mint, contributorATA, wallet.publicKey, 100 * ONE_TOKEN),
        );
        await provider.sendAndConfirm(setupTx, [mintKeypair]);

        assert.strictEqual(tokenBalance(contributorATA), BigInt(100 * ONE_TOKEN));
    });

    describe('minimum amounts scale with the mint decimals', () => {
        it('rejects a target below 3 whole tokens', async () => {
            const maker = newMaker();

            // 1_000 base units is 0.001 tokens: above 3^6 = 729 but far
            // below 3 * 10^6.
            await expectAnchorError(initialize(maker, 1_000, 1), 'InvalidAmount');

            assert.isNull(client.getAccount(fundraiserPda(maker.publicKey)), 'no fundraiser should have been created');
        });

        it('rejects a contribution below 1 whole token', async () => {
            const maker = newMaker();
            await initialize(maker, AMOUNT_TO_RAISE, 1);

            const fundraiser = fundraiserPda(maker.publicKey);
            const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
            const contributorBefore = tokenBalance(contributorATA);

            // 500 base units is 0.0005 tokens.
            await expectAnchorError(contribute(maker.publicKey, 500), 'ContributionTooSmall');

            assert.strictEqual(tokenBalance(vault), 0n, 'nothing should have reached the vault');
            assert.strictEqual(tokenBalance(contributorATA), contributorBefore, 'contributor must not be debited');
            assert.isNull(client.getAccount(contributorPda(fundraiser)), 'no Contributor account should exist');
        });
    });

    describe('target and refund gating use the tracked current_amount', () => {
        const checkerMaker = anchor.web3.Keypair.generate();
        const refundMaker = anchor.web3.Keypair.generate();

        // Contributes 1 token through the program, then pushes the vault's
        // raw balance up to the target with a plain SPL transfer that the
        // program never sees.
        const padVaultToTarget = async (maker: anchor.web3.Keypair) => {
            client.airdrop(maker.publicKey, BigInt(anchor.web3.LAMPORTS_PER_SOL));
            await initialize(maker, AMOUNT_TO_RAISE, 1);
            await contribute(maker.publicKey, ONE_TOKEN);

            const fundraiser = fundraiserPda(maker.publicKey);
            const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
            const padTx = new anchor.web3.Transaction().add(
                createTransferInstruction(contributorATA, vault, wallet.publicKey, AMOUNT_TO_RAISE - ONE_TOKEN),
            );
            await provider.sendAndConfirm(padTx);

            const state = await program.account.fundraiser.fetch(fundraiser);
            assert.strictEqual(tokenBalance(vault), BigInt(AMOUNT_TO_RAISE), 'vault balance sits at the target');
            assert.strictEqual(state.currentAmount.toNumber(), ONE_TOKEN, 'only 1 token was actually contributed');
        };

        it('pads two campaign vaults to their target', async () => {
            await padVaultToTarget(checkerMaker);
            await padVaultToTarget(refundMaker);
        });

        it('check_contributions does not treat a padded vault as target met', async () => {
            const fundraiser = fundraiserPda(checkerMaker.publicKey);
            const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
            const makerATA = getAssociatedTokenAddressSync(mint, checkerMaker.publicKey);

            await expectAnchorError(
                program.methods
                    .checkContributions()
                    .accountsPartial({
                        maker: checkerMaker.publicKey,
                        mintToRaise: mint,
                        fundraiser,
                        makerAta: makerATA,
                        vault,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([checkerMaker])
                    .rpc(),
                'TargetNotMet',
            );

            assert.strictEqual(tokenBalance(vault), BigInt(AMOUNT_TO_RAISE), 'the maker must not have swept the vault');
            const state = await program.account.fundraiser.fetch(fundraiser);
            assert.strictEqual(state.currentAmount.toNumber(), ONE_TOKEN, 'fundraiser must remain open');
        });

        it('refund still succeeds after the deadline when the vault was padded past target', async () => {
            const fundraiser = fundraiserPda(refundMaker.publicKey);
            const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
            const contributorAccount = contributorPda(fundraiser);

            const state = await program.account.fundraiser.fetch(fundraiser);
            const deadline = BigInt(state.timeStarted.toString()) + BigInt(state.duration) * SECONDS_PER_DAY;
            const clock = client.getClock();
            clock.unixTimestamp = deadline;
            client.setClock(clock);
            client.expireBlockhash();

            const contributorBefore = tokenBalance(contributorATA);

            await program.methods
                .refund()
                .accountsPartial({
                    contributor: wallet.publicKey,
                    maker: refundMaker.publicKey,
                    mintToRaise: mint,
                    fundraiser,
                    contributorAccount,
                    contributorAta: contributorATA,
                    vault,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();

            assert.strictEqual(
                tokenBalance(contributorATA),
                contributorBefore + BigInt(ONE_TOKEN),
                'contributor gets exactly their contribution back',
            );
            assert.strictEqual(
                tokenBalance(vault),
                BigInt(AMOUNT_TO_RAISE - ONE_TOKEN),
                'only the tracked contribution leaves the vault',
            );
            assert.isNull(client.getAccount(contributorAccount), 'the Contributor account should be closed');
            const after = await program.account.fundraiser.fetch(fundraiser);
            assert.strictEqual(after.currentAmount.toNumber(), 0, 'current_amount drops back to zero');
        });
    });
});
