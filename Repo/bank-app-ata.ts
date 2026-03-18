import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BankApp } from "../bank-app/target/types/bank_app";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { BN } from "bn.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {assert, expect} from "chai"

describe("bank-app", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.BankApp as Program<BankApp>;

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
    let tokenMint = new PublicKey("4K1HpyXypdjtt9hNnnuj7SxqK3vGJc6NVTk89ezkC4K8") 
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

  it("Withdraw token with pause logic!", async() => {
    let tokenMint = new PublicKey("4K1HpyXypdjtt9hNnnuj7SxqK3vGJc6NVTk89ezkC4K8") 
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
    const withdrawAmount = new BN(3_000_000); 

    console.log("Pause the bank");
    const txPause = await program.methods.togglePause()
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        authority: provider.publicKey,
      }).rpc();
    
    // Withdraw should fail
    try {
      await program.methods.withdrawToken(withdrawAmount)
        .accountsStrict({
          bankInfo: BANK_APP_ACCOUNTS.bankInfo,
          bankVault: BANK_APP_ACCOUNTS.bankVault,
          userReserve: BANK_APP_ACCOUNTS.userReserve(provider.publicKey, tokenMint),
          user: provider.publicKey,
          tokenMint: tokenMint,
          bankAta: bankAta,
          userAta: userAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId
        }).rpc();
      
      expect.fail("Withdraw should have been blocked!"); 
    } catch {
      console.log("Token withdraw blocked successfully due to pause");
    }

    console.log("Unpause the bank");
    await program.methods.togglePause()
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        authority: provider.publicKey,
      }).rpc();

    // Check the reserve balance before withdrawing
    let userReserveBefore = await program.account.userReserve.fetch(
      BANK_APP_ACCOUNTS.userReserve(provider.publicKey, tokenMint)
    );

    console.log("Executing successful token withdrawal");
    const txWithdraw = await program.methods.withdrawToken(withdrawAmount)
      .accountsStrict({
        bankInfo: BANK_APP_ACCOUNTS.bankInfo,
        bankVault: BANK_APP_ACCOUNTS.bankVault,
        userReserve: BANK_APP_ACCOUNTS.userReserve(provider.publicKey, tokenMint), 
        user: provider.publicKey,
        tokenMint: tokenMint, 
        bankAta: bankAta,
        userAta: userAta,
        tokenProgram: TOKEN_PROGRAM_ID, 
        systemProgram: SystemProgram.programId
      }).rpc();
    console.log("Token withdraw signature: ", txWithdraw);

    // Check the reserve balance after withdrawing
    let userReserveAfter = await program.account.userReserve.fetch(
      BANK_APP_ACCOUNTS.userReserve(provider.publicKey, tokenMint)
    );
    
    // Validate that the math matches up perfectly
    expect(userReserveAfter.depositedAmount.toNumber()).to.equal(
      userReserveBefore.depositedAmount.toNumber() - withdrawAmount.toNumber()
    );
  });
});
