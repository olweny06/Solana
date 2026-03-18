import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BankApp } from "../target/types/bank_app";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { BN } from "bn.js";
import { 
  ASSOCIATED_TOKEN_PROGRAM_ID, 
  createAssociatedTokenAccountInstruction, 
  getAssociatedTokenAddressSync, 
  getAccount,
  TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { StakingApp } from "../target/types/staking_app";
import {expect} from "chai";

describe("bank-app", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.BankApp as Program<BankApp>;
  const stakingProgram = anchor.workspace.StakingApp as Program<StakingApp>;

  const TOKEN_STAKING_PROGRAM_ID= new PublicKey("CQNVZxCegxwvFy3W5exvojnmZrKSyybPxmxeqTfGfxJo");
  let tokenMint = new PublicKey("4K1HpyXypdjtt9hNnnuj7SxqK3vGJc6NVTk89ezkC4K8") //you should put your token mint here

  const BANK_APP_ACCOUNTS = {
    bankInfo: PublicKey.findProgramAddressSync(
      [Buffer.from("BANK_INFO_SEED")],
      program.programId
    )[0],
    bankVault: PublicKey.findProgramAddressSync(
      [Buffer.from("BANK_VAULT_SEED")],
      program.programId
    )[0],
    userReserve: (pubkey: PublicKey, tokenMint?: PublicKey) => {
      let SEEDS = [
        Buffer.from("USER_RESERVE_SEED"),
        pubkey.toBuffer(),
      ]

      if (tokenMint != undefined) {
        SEEDS.push(tokenMint.toBuffer())
      }

      return PublicKey.findProgramAddressSync(
        SEEDS,
        program.programId
      )[0]
    }
  }

  it("Is initialized!", async () => {
    try {
      const bankInfo = await program.account.bankInfo.fetch(BANK_APP_ACCOUNTS.bankInfo)
      console.log("Bank info: ", bankInfo)
    } catch {
      const tx = await program.methods.initialize()
        .accountsStrict({
          bankInfo: BANK_APP_ACCOUNTS.bankInfo,
          bankVault: BANK_APP_ACCOUNTS.bankVault,
          authority: provider.publicKey,
          systemProgram: SystemProgram.programId
        }).rpc();
      console.log("Initialize signature: ", tx);
    }
  });

  it("Is deposited!", async () => {
    const tx = await program.methods.deposit(new BN(1_000_000))
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        bankVault: BANK_APP_ACCOUNTS.bankVault,
        userReserve: BANK_APP_ACCOUNTS.userReserve(provider.publicKey),
        user: provider.publicKey,
        systemProgram: SystemProgram.programId
      }).rpc();
    console.log("Deposit signature: ", tx);

    const userReserve = await program.account.userReserve.fetch(BANK_APP_ACCOUNTS.userReserve(provider.publicKey))
    console.log("User reserve: ", userReserve.depositedAmount.toString())
  });

  it("Is deposited token!", async () => {
    let userAta = getAssociatedTokenAddressSync(tokenMint, provider.publicKey)
    let bankAta = getAssociatedTokenAddressSync(tokenMint, BANK_APP_ACCOUNTS.bankVault, true)

    let preInstructions: TransactionInstruction[] = []
    if (await provider.connection.getAccountInfo(bankAta) == null) {
      preInstructions.push(createAssociatedTokenAccountInstruction(
        provider.publicKey,
        bankAta,
        BANK_APP_ACCOUNTS.bankVault,
        tokenMint
      ))
    }

    const tx = await program.methods.depositToken(new BN(1_000_000_000))
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        bankVault: BANK_APP_ACCOUNTS.bankVault,
        tokenMint,
        userAta,
        bankAta,
        userReserve: BANK_APP_ACCOUNTS.userReserve(provider.publicKey, tokenMint),
        user: provider.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId
      }).preInstructions(preInstructions).rpc();
    console.log("Deposit token signature: ", tx);

    const userReserve = await program.account.userReserve.fetch(BANK_APP_ACCOUNTS.userReserve(provider.publicKey, tokenMint))
    console.log("User reserve: ", userReserve.depositedAmount.toString())
  });

  it("InvestToken: bank authority stakes deposited SPL token via CPI", async () => {
    const bankAta = getAssociatedTokenAddressSync(
      tokenMint,
      BANK_APP_ACCOUNTS.bankVault,
      true
    );

    const [stakingVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("VAULT_AUTH"), tokenMint.toBuffer()],
      TOKEN_STAKING_PROGRAM_ID
    );

    const stakingVault = getAssociatedTokenAddressSync(
      tokenMint,
      stakingVaultAuthority,
      true
    );

    const [stakingUserInfo] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("USER_INFO"),
        BANK_APP_ACCOUNTS.bankVault.toBuffer(),
        tokenMint.toBuffer(),
      ],
      TOKEN_STAKING_PROGRAM_ID
    );

    const preInstructions: TransactionInstruction[] = [];
    if ((await provider.connection.getAccountInfo(stakingVault)) == null) {
      preInstructions.push(
        createAssociatedTokenAccountInstruction(
          provider.publicKey,
          stakingVault,
          stakingVaultAuthority,
          tokenMint
        )
      );
    }

    const bankAtaBefore = Number(
      (await getAccount(provider.connection, bankAta)).amount
    );

    const stakingVaultBeforeInfo = await provider.connection.getAccountInfo(
      stakingVault
    );
    const stakingVaultBefore = stakingVaultBeforeInfo
      ? Number((await getAccount(provider.connection, stakingVault)).amount)
      : 0;

    const investAmount = new BN(500_000);

    const tx = await program.methods
      .investToken(investAmount, true)
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        bankVault: BANK_APP_ACCOUNTS.bankVault,
        tokenMint,
        bankAta,
        stakingUserInfo,
        stakingVaultAuthority,
        stakingVault,
        stakingProgram: TOKEN_STAKING_PROGRAM_ID,
        authority: provider.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(preInstructions)
      .rpc();

    console.log("Invest token signature: ", tx);

    const bankAtaAfter = Number(
      (await getAccount(provider.connection, bankAta)).amount
    );
    const stakingVaultAfter = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );

    console.log("Bank ATA balance change:", bankAtaBefore - bankAtaAfter);
    console.log("Staking Vault balance change:", stakingVaultAfter - stakingVaultBefore);

    expect(bankAtaBefore - bankAtaAfter).to.equal(investAmount.toNumber());
    expect(stakingVaultAfter - stakingVaultBefore).to.equal(investAmount.toNumber());
  });

  it("InvestToken: bank authority unstakes SPL token back to bank ATA via CPI", async () => {
    const bankAta = getAssociatedTokenAddressSync(
      tokenMint,
      BANK_APP_ACCOUNTS.bankVault,
      true
    );

    const [stakingVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("VAULT_AUTH"), tokenMint.toBuffer()],
      TOKEN_STAKING_PROGRAM_ID
    );

    const stakingVault = getAssociatedTokenAddressSync(
      tokenMint,
      stakingVaultAuthority,
      true
    );

    const [stakingUserInfo] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("USER_INFO"),
        BANK_APP_ACCOUNTS.bankVault.toBuffer(),
        tokenMint.toBuffer(),
      ],
      TOKEN_STAKING_PROGRAM_ID
    );

    const bankAtaBefore = Number(
      (await getAccount(provider.connection, bankAta)).amount
    );
    const stakingVaultBefore = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );

    const unstakeAmount = new BN(200_000);

    const tx = await program.methods
      .investToken(unstakeAmount, false)
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        bankVault: BANK_APP_ACCOUNTS.bankVault,
        tokenMint,
        bankAta,
        stakingUserInfo,
        stakingVaultAuthority,
        stakingVault,
        stakingProgram: TOKEN_STAKING_PROGRAM_ID,
        authority: provider.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Unstake token signature: ", tx);

    const bankAtaAfter = Number(
      (await getAccount(provider.connection, bankAta)).amount
    );
    const stakingVaultAfter = Number(
      (await getAccount(provider.connection, stakingVault)).amount
    );

    console.log("Bank ATA balance change:", bankAtaAfter - bankAtaBefore);
    console.log("Staking Vault balance change:", stakingVaultBefore - stakingVaultAfter);

    expect(bankAtaAfter - bankAtaBefore).to.equal(unstakeAmount.toNumber());
    expect(stakingVaultBefore - stakingVaultAfter).to.equal(unstakeAmount.toNumber());
  });


  it("Test invest to send SOL", async() => {
    const [stakingVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("STAKING_VAULT")],
      stakingProgram.programId
    );

    const [stakingInfo] = PublicKey.findProgramAddressSync(
      [Buffer.from("USER_INFO"), BANK_APP_ACCOUNTS.bankVault.toBuffer()],
      stakingProgram.programId
    );
    const investAmount = new BN(1_000_000); 


    // Unstake => Invest should fail 
    let isStake = false;
    try{
      await program.methods.invest(investAmount, isStake).accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        bankVault: BANK_APP_ACCOUNTS.bankVault,
        stakingVault: stakingVault,
        stakingInfo: stakingInfo,
        stakingProgram: stakingProgram.programId,
        authority: provider.publicKey,
        systemProgram: SystemProgram.programId
      }).rpc({skipPreflight: true});
      expect.fail("Investment should be failed due to isStake is false"); 
    } catch(err){
      console.log("Unstake failed as expected"); 
    }

    // Test stake 
    isStake = true;

    // fetch balance before staking
    const initialBankVaultBalance = await provider.connection.getBalance(BANK_APP_ACCOUNTS.bankVault);
    const initialStakingVaultBalance = await provider.connection.getBalance(stakingVault);
    

    const tx = await program.methods.invest(investAmount, isStake).accountsStrict({
      bankInfo: BANK_APP_ACCOUNTS.bankInfo,
      bankVault: BANK_APP_ACCOUNTS.bankVault,
      stakingVault: stakingVault,
      stakingInfo: stakingInfo,
      stakingProgram: stakingProgram.programId,
      authority: provider.publicKey,
      systemProgram: SystemProgram.programId
    }).rpc();
    console.log("Invest (stake) signature: ", tx);

    // fetch balance after staking
    const finalBankVaultBalance = await provider.connection.getBalance(BANK_APP_ACCOUNTS.bankVault);
    const finalStakingVaultBalance = await provider.connection.getBalance(stakingVault);

    console.log("Bank Vault Balance Change:", initialBankVaultBalance - finalBankVaultBalance);
    console.log("Staking Vault Balance Change:", finalStakingVaultBalance - initialStakingVaultBalance);
  })


});
