import { sha256 } from '@noble/hashes/sha2.js';
import {
    Connection,
    Keypair,
    PublicKey,
    Secp256k1Program,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';

const PAYER_STORAGE_KEY = 'secp256k1-demo-payer';

/** A throwaway fee payer kept in localStorage so the demo needs no Solana wallet. */
export const loadPayer = (): Keypair => {
    try {
        const stored = localStorage.getItem(PAYER_STORAGE_KEY);
        if (stored) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
        // fall through and mint a new one
    }
    const payer = Keypair.generate();
    try {
        localStorage.setItem(PAYER_STORAGE_KEY, JSON.stringify(Array.from(payer.secretKey)));
    } catch {
        // storage unavailable; a fresh payer per page load is fine for a demo
    }
    return payer;
};

export const hexToBytes = (hex: string): Buffer => Buffer.from(hex.replace(/^0x/, ''), 'hex');

/** The bytes MetaMask's `personal_sign` actually signs (EIP-191). Must match the test helper. */
export const personalSignMessage = (text: string): Buffer => {
    const body = Buffer.from(text, 'utf8');
    return Buffer.concat([
        Buffer.from('\x19Ethereum Signed Message:\n', 'utf8'),
        Buffer.from(String(body.length)),
        body,
    ]);
};

/** Anchor's 8-byte instruction discriminator, so the demo needs no generated client. */
const discriminator = (name: string): Buffer =>
    Buffer.from(sha256(Buffer.from(`global:${name}`, 'utf8'))).subarray(0, 8);

/** `verify(eth_address: [u8; 20], message: Vec<u8>)` */
export const verifyInstruction = (
    programId: PublicKey,
    ethAddress: Buffer,
    message: Buffer,
): TransactionInstruction => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(message.length);
    return new TransactionInstruction({
        programId,
        keys: [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }],
        data: Buffer.concat([discriminator('verify'), ethAddress, length, message]),
    });
};

type Ethereum = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
const ethereum = (): Ethereum => {
    const provider = (window as unknown as { ethereum?: Ethereum }).ethereum;
    if (!provider) throw new Error('MetaMask is not installed');
    return provider;
};

export const connectMetaMask = async (): Promise<string> => {
    const accounts = (await ethereum().request({ method: 'eth_requestAccounts' })) as string[];
    return accounts[0];
};

/** Asks MetaMask for a signature and wraps it in a secp256k1 precompile instruction. */
export const signWithMetaMask = async (ethAddress: string, text: string): Promise<TransactionInstruction> => {
    const hexMessage = `0x${Buffer.from(text, 'utf8').toString('hex')}`;
    const signature = (await ethereum().request({
        method: 'personal_sign',
        params: [hexMessage, ethAddress],
    })) as string;
    const bytes = hexToBytes(signature); // r(32) | s(32) | v(1)
    const v = bytes[64];
    return Secp256k1Program.createInstructionWithEthAddress({
        ethAddress: hexToBytes(ethAddress),
        message: personalSignMessage(text),
        signature: bytes.subarray(0, 64),
        recoveryId: v >= 27 ? v - 27 : v,
        instructionIndex: 0,
    });
};

export type VerifyResult = { ok: boolean; signature?: string; logs: string[]; error?: string };

/** Sends [secp256k1 precompile, verify] and returns the program logs either way. */
export const sendVerify = async (
    connection: Connection,
    payer: Keypair,
    programId: PublicKey,
    secpInstruction: TransactionInstruction,
    ethAddress: string,
    expectedText: string,
): Promise<VerifyResult> => {
    const tx = new Transaction()
        .add(secpInstruction)
        .add(verifyInstruction(programId, hexToBytes(ethAddress), personalSignMessage(expectedText)));
    tx.feePayer = payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(payer);

    try {
        const signature = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        const info = await connection.getTransaction(signature, { commitment: 'confirmed' });
        return { ok: true, signature, logs: info?.meta?.logMessages ?? [] };
    } catch (err) {
        const logs = (err as { logs?: string[] }).logs ?? [];
        return { ok: false, logs, error: err instanceof Error ? err.message : String(err) };
    }
};
