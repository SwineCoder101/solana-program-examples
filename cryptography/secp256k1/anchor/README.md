# Ethereum signature verification with the secp256k1 precompile (Anchor)

Solana wallets sign with ed25519, Ethereum wallets with secp256k1. This example lets an Ethereum
address be the only authority over an on-chain account: every create, edit and delete of a small
`Note` is authorised by a MetaMask-style `personal_sign` signature, and no Solana keypair other
than a fee payer is involved.

The runtime ships a secp256k1 native program for exactly this, but it is a _precompile_: it can
only run as a top-level instruction and rejects cross-program invocation. So the pattern is
instruction introspection rather than CPI:

1. The client puts a `Secp256k1Program` instruction first in the transaction, carrying the Ethereum
   address, the signed message and the signature. If the signature does not recover to that
   address the runtime rejects the whole transaction before any program runs.
2. The note instruction comes second. It loads the previous instruction from the Instructions
   sysvar, checks it really is the secp256k1 program, and reads the address and message back out of
   the instruction data the runtime already verified.

Nothing in the program is cryptographic. `verify_eth_signature` in
[lib.rs](programs/ethereum-notes/src/lib.rs) is bookkeeping that ties the runtime's check to this
note and this action. Compare with
[external-delegate-token-master](../../../tokens/external-delegate-token-master/anchor), which
uses the `secp256k1_recover` syscall inside the program instead.

## What gets signed

The message is human readable so the user can see what they authorise in their wallet:

```
Solana note
program: <program id>
note: <note address>
action: create | edit | delete
nonce: <note nonce>
content: <content>          (create and edit only)
```

The program rebuilds this text, wraps it in the EIP-191 prefix that `personal_sign` adds
(`"\x19Ethereum Signed Message:\n" + length`), and compares byte for byte with the message the
precompile verified. Binding the program id, the note address and a nonce that increments on every
accepted action means a signature is valid for one action on one note, once.

## Accounts and checks

`Note` is a PDA at `["note", eth_address]`, one per Ethereum address.

| field         | purpose                                                            |
| ------------- | ------------------------------------------------------------------ |
| `eth_address` | the only authority over the note                                   |
| `rent_payer`  | Solana account that funded the note; receives the rent on `delete` |
| `nonce`       | replay protection, incremented on every accepted action            |
| `content`     | up to 200 bytes                                                    |

| instruction | authority check                                           | state transition                 | value movement                     |
| ----------- | --------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| `create`    | signature from `eth_address` over nonce 0 and the content | `init` note, `nonce = 1`         | `payer` funds rent                 |
| `edit`      | signature from `note.eth_address` over `note.nonce`       | `content` replaced, `nonce += 1` | none                               |
| `delete`    | signature from `note.eth_address` over `note.nonce`       | account closed                   | rent returned to `note.rent_payer` |

The `instructions_sysvar` account is pinned with an `address` constraint. The precompile
instruction must be immediately before the note instruction, must carry exactly one signature, and
all of its offsets must point inside its own data, so the program cannot be tricked into reading an
address or message from some other instruction.

## Threat model notes

- The fee payer is trusted for nothing but fees. It cannot forge an action because it does not hold
  the Ethereum key. This is what makes a gasless relayer safe here.
- A `create` signature could be replayed to recreate a deleted note with its original content,
  because the nonce lives in the account that `delete` closes. Keep the nonce in a persistent
  per-address account if that matters for your use case.
- Ethereum wallets show `personal_sign` messages to the user; the message deliberately includes the
  program id and note address so a signature requested by one dapp cannot be used by another.

## Test

```sh
pnpm install
anchor build       # first run generates a program keypair and stops on the id mismatch
anchor keys sync   # adopt that keypair, then build again
anchor build
pnpm test          # mocha + LiteSVM, no validator needed
```

The tests sign with a throwaway secp256k1 key and cover the happy path plus the rejections: no
precompile instruction, wrong signer, stale nonce, tampered content, and the rent refund on delete.
