# secp256k1 (Ethereum) signature verification (Anchor)

Solana wallets sign with ed25519, Ethereum wallets with secp256k1. This example shows how an
on-chain program can require a valid secp256k1 signature, such as a MetaMask `personal_sign`, from
a specific Ethereum address.

The runtime ships a secp256k1 native program for exactly this, but it is a _precompile_: it can
only run as a top-level instruction and rejects cross-program invocation. So the pattern is not
CPI. It is two instructions in one transaction plus instruction introspection:

1. The client puts a `Secp256k1Program` instruction first, carrying the Ethereum address, the
   signed message and the signature. If the signature does not recover to that address the runtime
   rejects the whole transaction before any program runs.
2. The program's `verify(eth_address, message)` instruction comes second. It loads the previous
   instruction from the Instructions sysvar, checks it is the secp256k1 program, and checks the
   address and message the runtime verified are the ones the caller expects.

Nothing in the program is cryptographic. `verify_eth_signature` in
[lib.rs](programs/secp256k1-anchor-program/src/lib.rs) is bookkeeping that ties the runtime's
check to your expectation, and it is written so you can lift it into your own program. Compare with
[external-delegate-token-master](../../../tokens/external-delegate-token-master/anchor), which uses
the `secp256k1_recover` syscall inside the program instead.

## What the program checks

| check                                                    | error                           |
| -------------------------------------------------------- | ------------------------------- |
| there is a previous instruction and it is the precompile | `MissingSignatureInstruction`   |
| it carries exactly one signature                         | `MalformedSignatureInstruction` |
| all of its offsets point inside its own instruction data | `MalformedSignatureInstruction` |
| the verified address equals `eth_address`                | `WrongSigner`                   |
| the verified message equals `message`                    | `MessageMismatch`               |

The offsets check is the subtle one. A precompile instruction's offsets may point at _any_
instruction in the transaction, and the runtime verifies whatever they point at. A program that
read the address out of the precompile instruction's own bytes without checking the offsets could
be handed a decoy: the last test constructs exactly that transaction and shows the runtime accepts
it while the program does not.

`personal_sign` wraps the text in the EIP-191 prefix (`"\x19Ethereum Signed Message:\n" + length`)
before hashing, so the `message` bytes are the prefixed form. The tests and the demo app build them
the same way.

## Threat model notes

- The program is stateless. Binding the message to what it authorises (program id, accounts,
  amounts, a nonce) is the caller's job; a bare "Sign in" message can be replayed by anyone who saw
  it. The [external-delegate-token-master](../../../tokens/external-delegate-token-master/anchor)
  example shows a nonce-bound digest.
- The fee payer is trusted for nothing but fees. It cannot forge the Ethereum signature.
- Solana's precompile signature check costs a signature fee, so each verified message adds one
  signature's worth of lamports to the transaction fee.

## Test

```sh
pnpm install
anchor build       # first run generates a program keypair and stops on the id mismatch
anchor keys sync   # adopt that keypair, then build again
anchor build
pnpm test          # mocha + LiteSVM, no validator needed
```

## Demo app (React + Vite + MetaMask)

`app/` is a small page that signs a message with MetaMask and sends the two-instruction
transaction from a throwaway fee payer it keeps in localStorage, so no Solana wallet is needed.
Point it at a local validator with the program deployed:

```sh
solana-test-validator --reset            # or surfpool start
anchor deploy                            # localnet, uses the keypair from `anchor keys sync`
cd app && pnpm install && pnpm dev       # open http://localhost:5173
```

Paste the program id from `anchor keys sync` (or set `VITE_PROGRAM_ID`), airdrop to the fee payer,
connect MetaMask, and send. The "expect a different message" checkbox shows the rejection path:
the precompile passes but the program returns `MessageMismatch`.
