import type { Program } from '@anchor-lang/core';
import * as anchor from '@anchor-lang/core';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    getTokenMetadata,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { assert } from 'chai';
import type { ExtensionNft } from '../target/types/extension_nft';

describe('extension_nft', () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.ExtensionNft as Program<ExtensionNft>;
    const connection = provider.connection;
    const payer = provider.wallet as anchor.Wallet;

    const LEVEL_SEED = 'level_1';
    const mint = new Keypair();

    const ataOf = (owner: PublicKey) =>
        getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const playerPdaOf = (authority: PublicKey) =>
        PublicKey.findProgramAddressSync([Buffer.from('player'), authority.toBuffer()], program.programId)[0];

    const woodMetadataOf = async (mintKey: PublicKey) => {
        const metadata = await getTokenMetadata(connection, mintKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
        return metadata?.additionalMetadata.find(([key]) => key === 'wood')?.[1];
    };

    const airdrop = async (to: PublicKey) => {
        const sig = await connection.requestAirdrop(to, 1e9);
        await connection.confirmTransaction(sig, 'confirmed');
    };

    it('Mint nft!', async () => {
        const balance = await connection.getBalance(payer.publicKey);

        if (balance < 1e8) {
            await airdrop(payer.publicKey);
        }

        console.log('Mint public key', mint.publicKey.toBase58());

        const tx = await program.methods
            .mintNft()
            .accounts({
                signer: payer.publicKey,
                tokenAccount: ataOf(payer.publicKey),
                mint: mint.publicKey,
            })
            .signers([mint])
            .rpc();

        console.log('Mint nft tx', tx);
        await connection.confirmTransaction(tx, 'confirmed');
    });

    it('Init player', async () => {
        await program.methods
            .initPlayer(LEVEL_SEED)
            .accounts({ signer: payer.publicKey })
            .rpc({ commitment: 'confirmed' });

        const player = await program.account.playerData.fetch(playerPdaOf(payer.publicKey), 'confirmed');
        assert.isTrue(player.authority.equals(payer.publicKey));
        assert.strictEqual(player.wood.toNumber(), 0);
    });

    it('Chop tree with own NFT updates the wood metadata field', async () => {
        for (const counter of [1, 2]) {
            await program.methods
                .chopTree(LEVEL_SEED, counter)
                .accountsPartial({
                    sessionToken: null,
                    player: playerPdaOf(payer.publicKey),
                    signer: payer.publicKey,
                    mint: mint.publicKey,
                    playerTokenAccount: ataOf(payer.publicKey),
                })
                .rpc({ commitment: 'confirmed' });
        }

        const player = await program.account.playerData.fetch(playerPdaOf(payer.publicKey), 'confirmed');
        assert.strictEqual(player.wood.toNumber(), 2);
        assert.strictEqual(await woodMetadataOf(mint.publicKey), '2');
    });

    it("Chop tree with another player's NFT is rejected", async () => {
        const attacker = Keypair.generate();
        await airdrop(attacker.publicKey);

        await program.methods
            .initPlayer(LEVEL_SEED)
            .accounts({ signer: attacker.publicKey })
            .signers([attacker])
            .rpc({ commitment: 'confirmed' });

        let rejected = false;
        try {
            await program.methods
                .chopTree(LEVEL_SEED, 1)
                .accountsPartial({
                    sessionToken: null,
                    player: playerPdaOf(attacker.publicKey),
                    signer: attacker.publicKey,
                    mint: mint.publicKey,
                    playerTokenAccount: ataOf(attacker.publicKey),
                })
                .signers([attacker])
                .rpc({ commitment: 'confirmed' });
        } catch (error) {
            rejected = true;
            console.log('chop_tree rejected:', error instanceof Error ? error.message : String(error));
        }

        assert.strictEqual(
            await woodMetadataOf(mint.publicKey),
            '2',
            'wood metadata of the foreign NFT was overwritten',
        );
        assert.isTrue(rejected, "chop_tree with another player's mint must be rejected");

        const attackerPlayer = await program.account.playerData.fetch(playerPdaOf(attacker.publicKey), 'confirmed');
        assert.strictEqual(attackerPlayer.wood.toNumber(), 0);
    });
});
