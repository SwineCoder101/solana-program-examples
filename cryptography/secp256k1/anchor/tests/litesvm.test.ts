import * as anchor from '@anchor-lang/core';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey, Secp256k1Program, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { LiteSVMProvider } from 'anchor-litesvm';
import { assert } from 'chai';
import { LiteSVM, TransactionMetadata } from 'litesvm';
import IDL from '../target/idl/secp256k1_anchor_program.json';
import type { Secp256k1AnchorProgram } from '../target/types/secp256k1_anchor_program';

const PROGRAM_ID = new PublicKey(IDL.address);

/** Ethereum address = last 20 bytes of keccak256(uncompressed pubkey without the 0x04 prefix). */
const ethAddressOf = (privateKey: Uint8Array): Buffer => {
    const uncompressed = secp256k1.getPublicKey(privateKey, false);
    return Buffer.from(keccak_256(uncompressed.slice(1)).slice(-20));
};

/** The bytes MetaMask's `personal_sign` actually signs (EIP-191). */
const personalSignMessage = (text: string): Buffer => {
    const body = Buffer.from(text, 'utf8');
    return Buffer.concat([
        Buffer.from('\x19Ethereum Signed Message:\n', 'utf8'),
        Buffer.from(String(body.length)),
        body,
    ]);
};

/** Signs like a wallet would and wraps the result in a secp256k1 precompile instruction. */
const secp256k1Instruction = (
    message: Buffer,
    privateKey: Uint8Array,
    options: { ethAddress?: Buffer; instructionIndex?: number } = {}
): TransactionInstruction => {
    const signature = secp256k1.sign(keccak_256(message), privateKey);
    return Secp256k1Program.createInstructionWithEthAddress({
        ethAddress: options.ethAddress ?? ethAddressOf(privateKey),
        message,
        signature: signature.toCompactRawBytes(),
        recoveryId: signature.recovery,
        // Which instruction in the transaction holds the address, signature and message bytes.
        instructionIndex: options.instructionIndex ?? 0,
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

describe('secp256k1 signature verification', () => {
    const client = new LiteSVM();
    client.addProgramFromFile(PROGRAM_ID, 'target/deploy/secp256k1_anchor_program.so');
    const provider = new LiteSVMProvider(client);
    anchor.setProvider(provider);
    const program = new anchor.Program<Secp256k1AnchorProgram>(IDL as Secp256k1AnchorProgram, provider);

    const ethPrivateKey = secp256k1.utils.randomSecretKey();
    const otherEthPrivateKey = secp256k1.utils.randomSecretKey();
    const ethAddress = ethAddressOf(ethPrivateKey);
    const message = personalSignMessage('Sign in to Solana');

    const verify = (expectedAddress: Buffer, expectedMessage: Buffer, preInstructions: TransactionInstruction[]) =>
        program.methods
            .verify(Array.from(expectedAddress), expectedMessage)
            .accountsPartial({ instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
            .preInstructions(preInstructions)
            .rpc();

    it('accepts a signature from the expected address over the expected message', async () => {
        const signature = await verify(ethAddress, message, [secp256k1Instruction(message, ethPrivateKey)]);

        const meta = client.getTransaction(Buffer.from(anchor.utils.bytes.bs58.decode(signature)));
        assert.instanceOf(meta, TransactionMetadata);
        assert.include((meta as TransactionMetadata).logs().join('\n'), 'secp256k1 signature verified');
    });

    it('rejects when no precompile instruction precedes it', async () => {
        await expectAnchorError(verify(ethAddress, message, []), 'MissingSignatureInstruction');
    });

    it('rejects a signature from a different Ethereum address', async () => {
        await expectAnchorError(
            verify(ethAddress, message, [secp256k1Instruction(message, otherEthPrivateKey)]),
            'WrongSigner'
        );
    });

    it('rejects a valid signature over a different message', async () => {
        const signed = personalSignMessage('Something else');
        await expectAnchorError(
            verify(ethAddress, message, [secp256k1Instruction(signed, ethPrivateKey)]),
            'MessageMismatch'
        );
    });

    it('never reaches the program when the signature itself is invalid', async () => {
        // A signature by another key presented as coming from `ethAddress`. The runtime's
        // precompile check fails, so the whole transaction is rejected before any program runs.
        const forged = secp256k1Instruction(message, otherEthPrivateKey, { ethAddress });
        let caught: any;
        try {
            await verify(ethAddress, message, [forged]);
        } catch (err) {
            caught = err;
        }
        assert.isDefined(caught, 'expected the transaction to fail');
        assert.isUndefined(caught?.error?.errorCode, 'the program should not have run');
    });

    it('rejects a precompile instruction whose offsets point at another instruction', async () => {
        // Instruction 0 carries a wrong address in its own bytes but tells the precompile to read
        // the address, signature and message from instruction 2, which holds a genuine signature.
        // The runtime accepts instruction 0 (it verifies what the offsets point at), so a program
        // that trusted the bytes inside instruction 0 would be fooled.
        const decoy = secp256k1Instruction(message, ethPrivateKey, {
            ethAddress: ethAddressOf(otherEthPrivateKey),
            instructionIndex: 2,
        });
        const genuine = secp256k1Instruction(message, ethPrivateKey, { instructionIndex: 2 });

        await expectAnchorError(
            program.methods
                .verify(Array.from(ethAddress), message)
                .accountsPartial({ instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
                .preInstructions([decoy])
                .postInstructions([genuine])
                .rpc(),
            'MalformedSignatureInstruction'
        );
    });
});
