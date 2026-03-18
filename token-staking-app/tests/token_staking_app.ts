import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TokenTakingApp } from "../target/types/token_taking_app";

describe("token-taking-app", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TokenTakingApp as Program<TokenTakingApp>;

  const user = provider.wallet.publicKey;
  const TOKEN_MINT = "6J4RhCDyAZjtYsFs16sYk7nayrCURA7tcpuHD527V69o";
  const TOKEN_ACCOUNT = process.env.TEST_TOKEN_ACCOUNT;
  const stakeAmount = 400_000;
  const unstakeAmount = 150_000;
  const rewardClaimAmount = 1;
  const rewardTargetWaitSeconds = 10;
  const maxRewardWaitSeconds = 30;
  const stakingApr = 5;
  const secondsPerYear = 31_536_000;

  let tokenMint: PublicKey;
  let userTokenAccount: PublicKey;
  let userInfo: PublicKey;
  let vaultAuthority: PublicKey;
  let stakingVault: PublicKey;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  before(async () => {
    tokenMint = new PublicKey(TOKEN_MINT);
    await getMint(provider.connection, tokenMint);

    if (TOKEN_ACCOUNT) {
      userTokenAccount = new PublicKey(TOKEN_ACCOUNT);
    } else {
      const userAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        tokenMint,
        user
      );
      userTokenAccount = userAta.address;
    }

    const userTokenAccountInfo = await getAccount(
      provider.connection,
      userTokenAccount
    );

    if (!userTokenAccountInfo.owner.equals(user)) {
      throw new Error(
        `Token account ${userTokenAccount.toBase58()} is owned by ${userTokenAccountInfo.owner.toBase58()}, not by the test user ${user.toBase58()}.`
      );
    }

    if (!userTokenAccountInfo.mint.equals(tokenMint)) {
      throw new Error(
        `Token account ${userTokenAccount.toBase58()} is for mint ${userTokenAccountInfo.mint.toBase58()}, not ${tokenMint.toBase58()}.`
      );
    }

    if (Number(userTokenAccountInfo.amount) < stakeAmount) {
      throw new Error(
        `Insufficient token balance in ${userTokenAccount.toBase58()}. Expected at least ${stakeAmount} base units for mint ${tokenMint.toBase58()}.`
      );
    }

    userInfo = PublicKey.findProgramAddressSync(
      [Buffer.from("USER_INFO"), user.toBuffer(), tokenMint.toBuffer()],
      program.programId
    )[0];

    vaultAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("VAULT_AUTH"), tokenMint.toBuffer()],
      program.programId
    )[0];

    stakingVault = getAssociatedTokenAddressSync(
      tokenMint,
      vaultAuthority,
      true
    );
  });

  it("stakes SPL tokens into the staking vault", async () => {
    const userBefore = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );
    let userInfoBefore = null;
    try {
      userInfoBefore = await program.account.userInfo.fetch(userInfo);
    } catch {
      userInfoBefore = null;
    }

    let vaultBefore = 0;
    try {
      vaultBefore = Number(
        (await getAccount(provider.connection, stakingVault)).amount
      );
    } catch {
      vaultBefore = 0;
    }

    await program.methods
      .stakeToken(new BN(stakeAmount), true)
      .accountsStrict({
        user,
        payer: provider.wallet.publicKey,
        tokenMint,
        userInfo,
        userTokenAccount,
        vaultAuthority,
        stakingVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userAfter = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );
    const vaultAfter = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );
    const userInfoAccount = await program.account.userInfo.fetch(userInfo);

    expect(userBefore - userAfter).to.equal(stakeAmount);
    expect(vaultAfter - vaultBefore).to.equal(stakeAmount);
    expect(userInfoAccount.owner.toBase58()).to.equal(user.toBase58());
    expect(userInfoAccount.mint.toBase58()).to.equal(tokenMint.toBase58());
    expect(userInfoAccount.stakedAmount.toNumber()).to.equal(
      (userInfoBefore?.stakedAmount.toNumber() ?? 0) + stakeAmount
    );
  });

  it("unstakes SPL tokens back to the user ATA", async () => {
    const userBefore = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );
    const vaultBefore = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );
    const userInfoBefore = await program.account.userInfo.fetch(userInfo);

    await program.methods
      .stakeToken(new BN(unstakeAmount), false)
      .accountsStrict({
        user,
        payer: provider.wallet.publicKey,
        tokenMint,
        userInfo,
        userTokenAccount,
        vaultAuthority,
        stakingVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userAfter = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );
    const vaultAfter = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );
    const userInfoAfter = await program.account.userInfo.fetch(userInfo);

    expect(userAfter - userBefore).to.equal(unstakeAmount);
    expect(vaultBefore - vaultAfter).to.equal(unstakeAmount);
    expect(userInfoAfter.stakedAmount.toNumber()).to.be.at.most(
      userInfoBefore.stakedAmount.toNumber()
    );
    expect(
      userInfoBefore.stakedAmount.toNumber() -
        userInfoAfter.stakedAmount.toNumber()
    ).to.be.at.most(unstakeAmount);
  });

  it("claims a real time-based reward from the staking vault", async function () {
    const userBalanceBefore = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );

    const minimumStakeForTargetWait = Math.ceil(
      (100 * secondsPerYear * rewardClaimAmount) /
        (stakingApr * rewardTargetWaitSeconds)
    );
    const rewardStakeAmount = Math.max(stakeAmount, minimumStakeForTargetWait);

    if (userBalanceBefore <= rewardStakeAmount + rewardClaimAmount) {
      this.skip();
      return;
    }

    const expectedRewardAfterMaxWait =
      Math.floor(
        (rewardStakeAmount * stakingApr * maxRewardWaitSeconds) /
          100 /
          secondsPerYear
      ) || 0;

    if (expectedRewardAfterMaxWait < rewardClaimAmount) {
      this.skip();
      return;
    }

    const rewardLiquidityTx = new Transaction().add(
      createTransferInstruction(
        userTokenAccount,
        stakingVault,
        user,
        rewardClaimAmount
      )
    );
    await provider.sendAndConfirm(rewardLiquidityTx, []);

    await program.methods
      .stakeToken(new BN(rewardStakeAmount), true)
      .accountsStrict({
        user,
        payer: provider.wallet.publicKey,
        tokenMint,
        userInfo,
        userTokenAccount,
        vaultAuthority,
        stakingVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const waitedSeconds = Math.ceil(
      (100 * secondsPerYear * rewardClaimAmount) /
        (rewardStakeAmount * stakingApr)
    );

    await sleep((waitedSeconds + 1) * 1000);

    const userBeforeClaim = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );
    const vaultBeforeClaim = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );
    const userInfoBeforeClaim = await program.account.userInfo.fetch(userInfo);

    await program.methods
      .stakeToken(new BN(rewardClaimAmount), false)
      .accountsStrict({
        user,
        payer: provider.wallet.publicKey,
        tokenMint,
        userInfo,
        userTokenAccount,
        vaultAuthority,
        stakingVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userAfterClaim = Number(
      (await getAccount(provider.connection, userTokenAccount)).amount
    );
    const vaultAfterClaim = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );
    const userInfoAfterClaim = await program.account.userInfo.fetch(userInfo);

    expect(userAfterClaim - userBeforeClaim).to.equal(rewardClaimAmount);
    expect(vaultBeforeClaim - vaultAfterClaim).to.equal(rewardClaimAmount);
    expect(userInfoAfterClaim.stakedAmount.toNumber()).to.equal(
      userInfoBeforeClaim.stakedAmount.toNumber()
    );
    expect(userInfoBeforeClaim.stakedAmount.toNumber()).to.be.at.least(
      rewardStakeAmount
    );
  });
});
