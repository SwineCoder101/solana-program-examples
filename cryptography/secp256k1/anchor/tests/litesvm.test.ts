import * as anchor from '@anchor-lang/core';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Secp256k1Program,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SystemProgram,
    TransactionInstruction,
} from '@solana/web3.js';
import { LiteSVMProvider } from 'anchor-litesvm';
import { assert } from 'chai';
import { LiteSVM } from 'litesvm';
import IDL from '../target/idl/ethereum_notes.json';
import type { EthereumNotes } from '../target/types/ethereum_notes';

const PROGRAM_ID = new PublicKey(IDL.address);

type Action = 'create' | 'edit' | 'delete';

/** Ethereum address = last 20 bytes of keccak256(uncompressed pubkey without the 0x04 prefix). */
const ethAddressOf = (privateKey: Uint8Array): Buffer => {
    const uncompressed = secp256k1.getPublicKey(privateKey, false);
    return Buffer.from(keccak_256(uncompressed.slice(1)).slice(-20));
};

/** Must match `note_message` in lib.rs byte for byte. */
const noteMessage = (note: PublicKey, action: Action, nonce: number, content?: string): Buffer => {
    let text = `Solana note\nprogram: ${PROGRAM_ID.toBase58()}\nnote: ${note.toBase58()}\naction: ${action}\nnonce: ${nonce}`;
    if (content !== undefined) text += `\ncontent: ${content}`;
    const body = Buffer.from(text, 'utf8');
    // What MetaMask's personal_sign actually signs (EIP-191).
    return Buffer.concat([
        Buffer.from('\x19Ethereum Signed Message:\n', 'utf8'),
        Buffer.from(String(body.length), 'utf8'),
        body,
    ]);
};

/** Signs like a wallet would and wraps the result in a secp256k1 precompile instruction. */
const secp256k1Instruction = (message: Buffer, privateKey: Uint8Array): TransactionInstruction => {
    const signature = secp256k1.sign(keccak_256(message), privateKey);
    return Secp256k1Program.createInstructionWithEthAddress({
        ethAddress: ethAddressOf(privateKey),
        message,
        signature: signature.toCompactRawBytes(),
        recoveryId: signature.recovery,
        instructionIndex: 0, // the precompile is the first instruction in every transaction below
    });
};

const expectAnchorError = async (promise: Promise<unknown>, code: string) => {
    let caught: any;
    try {
        await promise;
    } catch (err) {
        caught = err;
    }
    assert.isDefined(caught, `expected the transaction to fail with ${code}`);
    assert.equal(caught?.error?.errorCode?.code, code, `expected ${code}, got ${caught}`);
};

describe('Ethereum-signed notes', () => {
    const client = new LiteSVM();
    client.addProgramFromFile(PROGRAM_ID, 'target/deploy/ethereum_notes.so');
    const provider = new LiteSVMProvider(client);
    anchor.setProvider(provider);
    const program = new anchor.Program<EthereumNotes>(IDL as EthereumNotes, provider);

    // Funds the note; the provider wallet pays transaction fees.
    const payer = Keypair.generate();
    client.airdrop(payer.publicKey, BigInt(LAMPORTS_PER_SOL));

    const ethPrivateKey = secp256k1.utils.randomSecretKey();
    const otherEthPrivateKey = secp256k1.utils.randomSecretKey();
    const ethAddress = ethAddressOf(ethPrivateKey);

    const [noteAddress] = PublicKey.findProgramAddressSync([Buffer.from('note'), ethAddress], PROGRAM_ID);

    const create = (content: string, signer = ethPrivateKey) =>
        program.methods
            .create(Array.from(ethAddress), content)
            .accountsPartial({
                note: noteAddress,
                payer: payer.publicKey,
                instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                systemProgram: SystemProgram.programId,
            })
            .preInstructions([secp256k1Instruction(noteMessage(noteAddress, 'create', 0, content), signer)])
            .signers([payer])
            .rpc();

    const edit = (content: string, nonce: number, signer = ethPrivateKey) =>
        program.methods
            .edit(content)
            .accountsPartial({
                note: noteAddress,
                instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .preInstructions([secp256k1Instruction(noteMessage(noteAddress, 'edit', nonce, content), signer)])
            .rpc();

    const remove = (nonce: number, signer = ethPrivateKey) =>
        program.methods
            .delete()
            .accountsPartial({
                note: noteAddress,
                rentPayer: payer.publicKey,
                instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .preInstructions([secp256k1Instruction(noteMessage(noteAddress, 'delete', nonce), signer)])
            .rpc();

    it('rejects create without a secp256k1 instruction in front of it', async () => {
        await expectAnchorError(
            program.methods
                .create(Array.from(ethAddress), 'hello')
                .accountsPartial({
                    note: noteAddress,
                    payer: payer.publicKey,
                    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                    systemProgram: SystemProgram.programId,
                })
                .signers([payer])
                .rpc(),
            'MissingSignatureInstruction',
        );
    });

    it('rejects create signed by a different Ethereum key', async () => {
        await expectAnchorError(create('hello', otherEthPrivateKey), 'WrongSigner');
    });

    it('creates a note authorised by an Ethereum signature', async () => {
        await create('hello');

        const note = await program.account.note.fetch(noteAddress);
        assert.deepEqual(note.ethAddress, Array.from(ethAddress));
        assert.equal(note.rentPayer.toBase58(), payer.publicKey.toBase58());
        assert.equal(note.nonce.toNumber(), 1);
        assert.equal(note.content, 'hello');
    });

    it('edits the note and advances the nonce', async () => {
        await edit('hello again', 1);

        const note = await program.account.note.fetch(noteAddress);
        assert.equal(note.nonce.toNumber(), 2);
        assert.equal(note.content, 'hello again');
    });

    it('rejects a signature over a stale nonce', async () => {
        // Fresh blockhash so this is not dropped as a duplicate before the program runs.
        client.expireBlockhash();
        await expectAnchorError(edit('hello again', 1), 'MessageMismatch');
    });

    it('rejects a valid signature submitted with different content', async () => {
        await expectAnchorError(
            program.methods
                .edit('tampered')
                .accountsPartial({
                    note: noteAddress,
                    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                })
                .preInstructions([secp256k1Instruction(noteMessage(noteAddress, 'edit', 2, 'signed'), ethPrivateKey)])
                .rpc(),
            'MessageMismatch',
        );
    });

    it('rejects delete signed by a different Ethereum key', async () => {
        await expectAnchorError(remove(2, otherEthPrivateKey), 'WrongSigner');
    });

    it('deletes the note and refunds rent to the payer', async () => {
        const rent = client.getAccount(noteAddress)!.lamports;
        const before = client.getBalance(payer.publicKey)!;

        await remove(2);

        assert.isNull(client.getAccount(noteAddress));
        // The provider wallet paid the fee, so the payer's balance rises by exactly the rent.
        assert.equal(client.getBalance(payer.publicKey)! - before, BigInt(rent));
    });
});
