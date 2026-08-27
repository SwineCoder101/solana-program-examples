import type { Program } from '@anchor-lang/core';
import * as anchor from '@anchor-lang/core';
import { getAssociatedTokenAddressSync, transfer } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { expect } from 'chai';
import type { SwapExample } from '../target/types/swap_example';
import { createValues, mintToHolder, mintingTokens, type TestValues } from './utils';

describe('Deposit liquidity', () => {
    const provider = anchor.AnchorProvider.env();
    const connection = provider.connection;
    anchor.setProvider(provider);

    const program = anchor.workspace.SwapExample as Program<SwapExample>;

    let values: TestValues;

    beforeEach(async () => {
        values = createValues();

        await program.methods
            .createAmm(values.id, values.fee)
            .accountsPartial({ amm: values.ammKey, admin: values.admin.publicKey })
            .rpc();

        await mintingTokens({
            connection,
            creator: values.admin,
            mintAKeypair: values.mintAKeypair,
            mintBKeypair: values.mintBKeypair,
        });

        await program.methods
            .createPool()
            .accountsPartial({
                amm: values.ammKey,
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
            })
            .rpc();
    });

    it('Deposit equal amounts', async () => {
        await program.methods
            .depositLiquidity(values.depositAmountA, values.depositAmountA)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc({ skipPreflight: true });

        const depositTokenAccountLiquditiy = await connection.getTokenAccountBalance(values.liquidityAccount);
        expect(depositTokenAccountLiquditiy.value.amount).to.equal(
            values.depositAmountA.sub(values.minimumLiquidity).toString(),
        );
        const depositTokenAccountA = await connection.getTokenAccountBalance(values.holderAccountA);
        expect(depositTokenAccountA.value.amount).to.equal(values.defaultSupply.sub(values.depositAmountA).toString());
        const depositTokenAccountB = await connection.getTokenAccountBalance(values.holderAccountB);
        expect(depositTokenAccountB.value.amount).to.equal(values.defaultSupply.sub(values.depositAmountA).toString());
    });

    it('Deposit with existing liquidity (same ratio)', async () => {
        // 1. Initial Deposit
        await program.methods
            .depositLiquidity(values.depositAmountA, values.depositAmountA)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc({ skipPreflight: true });

        // 2. Second Deposit
        const secondDepositAmount = new anchor.BN(100000);
        await program.methods
            .depositLiquidity(secondDepositAmount, secondDepositAmount)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc({ skipPreflight: true });

        const poolAccountA = await connection.getTokenAccountBalance(values.poolAccountA);
        expect(poolAccountA.value.amount).to.equal(values.depositAmountA.add(secondDepositAmount).toString());
    });

    it('Deposit with different ratio', async () => {
        // 1. Initial Deposit with 1:5 ratio
        // Pool A: 1,000,000
        // Pool B: 5,000,000
        const initialAmountA = new anchor.BN(1_000_000);
        const initialAmountB = new anchor.BN(5_000_000);

        await program.methods
            .depositLiquidity(initialAmountA, initialAmountB)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc({ skipPreflight: true });

        // 2. Second Deposit with mismatched input
        // Input A: 500,000
        // Input B: 500,000
        // Logic:
        // - 500k A requires 2.5M B. (User only provided 500k B).
        // - 500k B requires 100k A. (User provided 500k A).
        // Result: Deposit 100k A and 500k B.
        const secondDepositA = new anchor.BN(500000);
        const secondDepositBInput = new anchor.BN(500000);

        await program.methods
            .depositLiquidity(secondDepositA, secondDepositBInput)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc({ skipPreflight: true });

        // 3. Verify Balances
        const poolAccountA = await connection.getTokenAccountBalance(values.poolAccountA);
        const poolAccountB = await connection.getTokenAccountBalance(values.poolAccountB);

        // Total A: 1,000,000 + 100,000 = 1,100,000
        // We expect 100,000 A to be deposited.
        const expectedAdditionalA = secondDepositBInput.mul(initialAmountA).div(initialAmountB); // 500k * (1M/5M) = 100k
        expect(poolAccountA.value.amount).to.equal(initialAmountA.add(expectedAdditionalA).toString());

        // Total B: 5,000,000 + 500,000 = 5,500,000
        expect(poolAccountB.value.amount).to.equal(initialAmountB.add(secondDepositBInput).toString());
    });

    it('Second depositor cannot capture fees accrued by earlier depositors', async () => {
        const depositor = Keypair.generate();
        await connection.confirmTransaction(await connection.requestAirdrop(depositor.publicKey, 10 ** 10));
        await mintToHolder({
            connection,
            creator: values.admin,
            holder: depositor,
            mintAKeypair: values.mintAKeypair,
            mintBKeypair: values.mintBKeypair,
        });
        const depositorAccountA = getAssociatedTokenAddressSync(values.mintAKeypair.publicKey, depositor.publicKey);
        const depositorAccountB = getAssociatedTokenAddressSync(values.mintBKeypair.publicKey, depositor.publicKey);
        const depositorAccountLiquidity = getAssociatedTokenAddressSync(values.mintLiquidity, depositor.publicKey);

        // 1. Admin seeds the pool
        const initialAmount = new anchor.BN(10_000_000);
        await program.methods
            .depositLiquidity(initialAmount, initialAmount)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc({ skipPreflight: true });

        // 2. Swaps accrue fees to the pool while LP supply stays fixed
        for (const swapA of [true, false, true, false]) {
            await program.methods
                .swapExactTokensForTokens(swapA, new anchor.BN(1_000_000), new anchor.BN(1))
                .accountsPartial({
                    amm: values.ammKey,
                    pool: values.poolKey,
                    poolAuthority: values.poolAuthority,
                    trader: values.admin.publicKey,
                    mintA: values.mintAKeypair.publicKey,
                    mintB: values.mintBKeypair.publicKey,
                    poolAccountA: values.poolAccountA,
                    poolAccountB: values.poolAccountB,
                    traderAccountA: values.holderAccountA,
                    traderAccountB: values.holderAccountB,
                })
                .signers([values.admin])
                .rpc({ skipPreflight: true });
        }

        const reserveABefore = new anchor.BN(
            (await connection.getTokenAccountBalance(values.poolAccountA)).value.amount,
        );
        const reserveBBefore = new anchor.BN(
            (await connection.getTokenAccountBalance(values.poolAccountB)).value.amount,
        );
        const supplyBefore = new anchor.BN((await connection.getTokenSupply(values.mintLiquidity)).value.amount);
        const totalBefore = supplyBefore.add(values.minimumLiquidity);

        // 3. Second depositor joins
        await program.methods
            .depositLiquidity(initialAmount, initialAmount)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: depositor.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity,
                depositorAccountA,
                depositorAccountB,
            })
            .signers([depositor])
            .rpc({ skipPreflight: true });

        const depositedA = new anchor.BN(
            (await connection.getTokenAccountBalance(values.poolAccountA)).value.amount,
        ).sub(reserveABefore);
        const depositedB = new anchor.BN(
            (await connection.getTokenAccountBalance(values.poolAccountB)).value.amount,
        ).sub(reserveBBefore);
        const liquidity = new anchor.BN(
            (await connection.getTokenAccountBalance(depositorAccountLiquidity)).value.amount,
        );

        // LP minted must be pro-rata to the existing supply, not sqrt(a * b)
        const expectedLiquidity = anchor.BN.min(
            depositedA.mul(totalBefore).div(reserveABefore),
            depositedB.mul(totalBefore).div(reserveBBefore),
        );
        expect(liquidity.toString()).to.equal(expectedLiquidity.toString());

        // 4. Withdrawing everything must not return more than was deposited
        await program.methods
            .withdrawLiquidity(liquidity)
            .accountsPartial({
                amm: values.ammKey,
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: depositor.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity,
                depositorAccountA,
                depositorAccountB,
            })
            .signers([depositor])
            .rpc({ skipPreflight: true });

        const receivedA = new anchor.BN((await connection.getTokenAccountBalance(depositorAccountA)).value.amount)
            .sub(values.defaultSupply)
            .add(depositedA);
        const receivedB = new anchor.BN((await connection.getTokenAccountBalance(depositorAccountB)).value.amount)
            .sub(values.defaultSupply)
            .add(depositedB);
        expect(receivedA.lte(depositedA), `received ${receivedA} A for a ${depositedA} deposit`).to.be.true;
        expect(receivedB.lte(depositedB), `received ${receivedB} B for a ${depositedB} deposit`).to.be.true;
        // Sanity: rounding only costs dust
        expect(receivedA.gt(depositedA.muln(999).divn(1000))).to.be.true;
        expect(receivedB.gt(depositedB.muln(999).divn(1000))).to.be.true;
    });

    it('First deposit succeeds after token B is donated to the pool', async () => {
        await transfer(connection, values.admin, values.holderAccountB, values.poolAccountB, values.admin, 1);

        await program.methods
            .depositLiquidity(values.depositAmountA, values.depositAmountA)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc();

        const liquidity = await connection.getTokenAccountBalance(values.liquidityAccount);
        expect(liquidity.value.amount).to.equal(values.depositAmountA.sub(values.minimumLiquidity).toString());
        const poolAccountA = await connection.getTokenAccountBalance(values.poolAccountA);
        expect(poolAccountA.value.amount).to.equal(values.depositAmountA.toString());
        const poolAccountB = await connection.getTokenAccountBalance(values.poolAccountB);
        expect(poolAccountB.value.amount).to.equal(values.depositAmountA.addn(1).toString());
    });

    it('First deposit mints liquidity after token A is donated to the pool', async () => {
        await transfer(connection, values.admin, values.holderAccountA, values.poolAccountA, values.admin, 1);

        await program.methods
            .depositLiquidity(values.depositAmountA, values.depositAmountA)
            .accountsPartial({
                pool: values.poolKey,
                poolAuthority: values.poolAuthority,
                depositor: values.admin.publicKey,
                mintLiquidity: values.mintLiquidity,
                mintA: values.mintAKeypair.publicKey,
                mintB: values.mintBKeypair.publicKey,
                poolAccountA: values.poolAccountA,
                poolAccountB: values.poolAccountB,
                depositorAccountLiquidity: values.liquidityAccount,
                depositorAccountA: values.holderAccountA,
                depositorAccountB: values.holderAccountB,
            })
            .signers([values.admin])
            .rpc();

        const liquidity = await connection.getTokenAccountBalance(values.liquidityAccount);
        expect(liquidity.value.amount).to.equal(values.depositAmountA.sub(values.minimumLiquidity).toString());
        const poolAccountA = await connection.getTokenAccountBalance(values.poolAccountA);
        expect(poolAccountA.value.amount).to.equal(values.depositAmountA.addn(1).toString());
        const poolAccountB = await connection.getTokenAccountBalance(values.poolAccountB);
        expect(poolAccountB.value.amount).to.equal(values.depositAmountA.toString());
    });
});
