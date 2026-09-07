import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { connectMetaMask, loadPayer, sendVerify, signWithMetaMask, type VerifyResult } from './solana';

const DEFAULT_RPC = 'http://127.0.0.1:8899';

export default function App() {
    const [rpcUrl, setRpcUrl] = useState(DEFAULT_RPC);
    const [programIdText, setProgramIdText] = useState(import.meta.env.VITE_PROGRAM_ID ?? '');
    const [ethAddress, setEthAddress] = useState('');
    const [text, setText] = useState('Sign in to Solana');
    const [tamper, setTamper] = useState(false);
    const [balance, setBalance] = useState<number | null>(null);
    const [busy, setBusy] = useState('');
    const [result, setResult] = useState<VerifyResult | null>(null);

    const payer = useMemo(loadPayer, []);
    const connection = useMemo(() => new Connection(rpcUrl, 'confirmed'), [rpcUrl]);

    const programId = useMemo(() => {
        try {
            return new PublicKey(programIdText);
        } catch {
            return null;
        }
    }, [programIdText]);

    const refreshBalance = useCallback(async () => {
        try {
            setBalance(await connection.getBalance(payer.publicKey));
        } catch {
            setBalance(null);
        }
    }, [connection, payer]);

    useEffect(() => {
        void refreshBalance();
    }, [refreshBalance]);

    const airdrop = async () => {
        setBusy('Requesting airdrop...');
        try {
            const signature = await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
            const latest = await connection.getLatestBlockhash();
            await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
            await refreshBalance();
        } catch (err) {
            setResult({ ok: false, logs: [], error: err instanceof Error ? err.message : String(err) });
        }
        setBusy('');
    };

    const connect = async () => {
        try {
            setEthAddress(await connectMetaMask());
        } catch (err) {
            setResult({ ok: false, logs: [], error: err instanceof Error ? err.message : String(err) });
        }
    };

    const signAndVerify = async () => {
        if (!programId) return;
        setResult(null);
        setBusy('Waiting for MetaMask signature...');
        try {
            const secpInstruction = await signWithMetaMask(ethAddress, text);
            setBusy('Sending transaction...');
            // With "tamper" on, the program is told to expect a different message than the one
            // MetaMask signed, so the precompile passes but the program rejects it.
            const expected = tamper ? `${text} (tampered)` : text;
            setResult(await sendVerify(connection, payer, programId, secpInstruction, ethAddress, expected));
            await refreshBalance();
        } catch (err) {
            setResult({ ok: false, logs: [], error: err instanceof Error ? err.message : String(err) });
        }
        setBusy('');
    };

    const ready = Boolean(programId && ethAddress && balance && !busy);

    return (
        <main>
            <h1>secp256k1 signature verification</h1>
            <p>
                MetaMask signs a message; a Solana transaction carries that signature in a secp256k1 precompile
                instruction, and the program checks it through the Instructions sysvar.
            </p>

            <section>
                <h2>1. Cluster and program</h2>
                <label>RPC URL</label>
                <input value={rpcUrl} onChange={e => setRpcUrl(e.target.value)} />
                <label>Program id (from `anchor keys sync`)</label>
                <input
                    value={programIdText}
                    onChange={e => setProgramIdText(e.target.value)}
                    placeholder="deployed program id"
                />
            </section>

            <section>
                <h2>2. Fee payer (throwaway keypair in localStorage)</h2>
                <code>{payer.publicKey.toBase58()}</code>
                <p>Balance: {balance === null ? 'unavailable' : `${balance / LAMPORTS_PER_SOL} SOL`}</p>
                <button onClick={airdrop} disabled={Boolean(busy)}>
                    Airdrop 1 SOL
                </button>
            </section>

            <section>
                <h2>3. Ethereum signer</h2>
                {ethAddress ? <code>{ethAddress}</code> : <button onClick={connect}>Connect MetaMask</button>}
            </section>

            <section>
                <h2>4. Sign and verify on Solana</h2>
                <label>Message</label>
                <textarea rows={2} value={text} onChange={e => setText(e.target.value)} />
                <label>
                    <input type="checkbox" checked={tamper} onChange={e => setTamper(e.target.checked)} /> Tell the
                    program to expect a different message (shows the rejection path)
                </label>
                <button onClick={signAndVerify} disabled={!ready}>
                    Sign with MetaMask and send
                </button>
                {busy && <p>{busy}</p>}
                {result && (
                    <div>
                        <p className={result.ok ? 'ok' : 'err'}>
                            {result.ok ? `Verified on-chain: ${result.signature}` : `Rejected: ${result.error}`}
                        </p>
                        {result.logs.length > 0 && <pre>{result.logs.join('\n')}</pre>}
                    </div>
                )}
            </section>
        </main>
    );
}
