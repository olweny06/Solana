import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { BN } from "bn.js";
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import type { BankApp } from "../target/types/bank_app";
import {
  batchDepositTokens,
  createAndExtendLookupTable,
  getLookupTableAccountOrThrow,
} from "./helpers";

type TokenCaseInput = {
  label: string;
  mint: string;
  amount: BN;
};

type TokenCase = {
  label: string;
  mint: PublicKey;
  amount: BN;
};

describe("Bank App - Batch Token Operations with ALT", function () {
  this.timeout(180_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BankApp as Program<BankApp>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const BANK_INFO_SEED = Buffer.from("BANK_INFO_SEED");
  const BANK_VAULT_SEED = Buffer.from("BANK_VAULT_SEED");
  const USER_RESERVE_SEED = Buffer.from("USER_RESERVE_SEED");

  const TOKEN_CASES_RAW: TokenCaseInput[] = [
    {
      label: "TOKEN_A",
      mint: "4K1HpyXypdjtt9hNnnuj7SxqK3vGJc6NVTk89ezkC4K8",
      amount: new BN("10000"),
    },
    {
      label: "TOKEN_B",
      mint: "BP9mQoqrZiLWSfBJ2di6y1qfGUUSW8N8gxVe1ZmnZeZm",
      amount: new BN("2000"),
    },
  ];

  let tokenCases: TokenCase[] = [];
  let bankInfoPda: PublicKey;
  let bankVaultPda: PublicKey;
  let lookupTableAddress: PublicKey;
  let lookupTableAccount: AddressLookupTableAccount;

  const BANK_APP_ACCOUNTS = {
    bankInfo: undefined as unknown as PublicKey,
    bankVault: undefined as unknown as PublicKey,
    userReserve: (pubkey: PublicKey, tokenMint: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [USER_RESERVE_SEED, pubkey.toBuffer(), tokenMint.toBuffer()],
        program.programId
      )[0],
  };

  async function initializeBankIfNeeded() {
    try {
      await program.account.bankInfo.fetch(bankInfoPda);
    } catch {
      const signature = await program.methods
        .initialize()
        .accountsStrict({
          bankInfo: bankInfoPda,
          bankVault: bankVaultPda,
          authority: provider.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Initialize bank_app signature:", signature);
    }
  }

  async function readTokenState(tokenCase: TokenCase) {
    const bankAta = getAssociatedTokenAddressSync(tokenCase.mint, bankVaultPda, true);
    const userReservePda = BANK_APP_ACCOUNTS.userReserve(payer.publicKey, tokenCase.mint);

    let bankAtaAmount = new BN(0);
    const bankAtaInfo = await connection.getAccountInfo(bankAta);
    if (bankAtaInfo) {
      const bankAtaAccount = await getAccount(connection, bankAta);
      bankAtaAmount = new BN(bankAtaAccount.amount.toString());
    }

    let reserveAmount = new BN(0);
    try {
      const reserve = await program.account.userReserve.fetch(userReservePda);
      reserveAmount = new BN(reserve.depositedAmount.toString());
    } catch {}

    return {
      label: tokenCase.label,
      mint: tokenCase.mint,
      bankAtaAmount,
      reserveAmount,
    };
  }

  async function assertUserHasEnoughBalance(tokenCase: TokenCase) {
    const userAta = getAssociatedTokenAddressSync(tokenCase.mint, payer.publicKey);
    const userAtaInfo = await connection.getAccountInfo(userAta);

    if (!userAtaInfo) {
      throw new Error(
        `User ATA ${userAta.toBase58()} cho mint ${tokenCase.mint.toBase58()} chưa tồn tại.`
      );
    }

    const userAtaAccount = await getAccount(connection, userAta);
    const balance = new BN(userAtaAccount.amount.toString());

    if (balance.lt(tokenCase.amount)) {
      throw new Error(
        `${tokenCase.label} không đủ số dư. Have=${balance.toString()}, need=${tokenCase.amount.toString()}`
      );
    }

    return balance;
  }

  async function buildBatchDepositInstructions(
    selectedTokenCases: TokenCase[]
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    const bankAtas = selectedTokenCases.map((tokenCase) =>
      getAssociatedTokenAddressSync(tokenCase.mint, bankVaultPda, true)
    );
    const userAtas = selectedTokenCases.map((tokenCase) =>
      getAssociatedTokenAddressSync(tokenCase.mint, payer.publicKey)
    );

    const [bankAtaInfos, userAtaInfos] = await Promise.all([
      connection.getMultipleAccountsInfo(bankAtas),
      connection.getMultipleAccountsInfo(userAtas),
    ]);

    for (let i = 0; i < selectedTokenCases.length; i++) {
      const tokenCase = selectedTokenCases[i];
      const userAta = userAtas[i];
      const bankAta = bankAtas[i];
      const userReserve = BANK_APP_ACCOUNTS.userReserve(payer.publicKey, tokenCase.mint);

      if (!userAtaInfos[i]) {
        throw new Error(
          `${tokenCase.label}: user ATA chưa tồn tại. Hãy tự tạo/fund trước khi chạy test.`
        );
      }

      if (!bankAtaInfos[i]) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            bankAta,
            bankVaultPda,
            tokenCase.mint
          )
        );
      }

      instructions.push(
        await program.methods
          .depositToken(tokenCase.amount)
          .accountsStrict({
            bankInfo: bankInfoPda,
            bankVault: bankVaultPda,
            tokenMint: tokenCase.mint,
            userAta,
            bankAta,
            userReserve,
            user: payer.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );
    }

    return instructions;
  }

  before(async () => {
    tokenCases = TOKEN_CASES_RAW.map((item) => ({
      label: item.label,
      mint: new PublicKey(item.mint),
      amount: item.amount,
    }));

    expect(tokenCases.length).to.be.at.least(2);

    [bankInfoPda] = PublicKey.findProgramAddressSync(
      [BANK_INFO_SEED],
      program.programId
    );
    [bankVaultPda] = PublicKey.findProgramAddressSync(
      [BANK_VAULT_SEED],
      program.programId
    );

    BANK_APP_ACCOUNTS.bankInfo = bankInfoPda;
    BANK_APP_ACCOUNTS.bankVault = bankVaultPda;

    await initializeBankIfNeeded();

    const altAddressMap = new Map<string, PublicKey>();
    const rawAltAddresses = [
      bankInfoPda,
      bankVaultPda,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ...tokenCases.map((tokenCase) => tokenCase.mint),
      ...tokenCases.map((tokenCase) =>
        getAssociatedTokenAddressSync(tokenCase.mint, payer.publicKey)
      ),
      ...tokenCases.map((tokenCase) =>
        getAssociatedTokenAddressSync(tokenCase.mint, bankVaultPda, true)
      ),
      ...tokenCases.map((tokenCase) =>
        BANK_APP_ACCOUNTS.userReserve(payer.publicKey, tokenCase.mint)
      ),
    ];

    for (const address of rawAltAddresses) {
      altAddressMap.set(address.toBase58(), address);
    }

    lookupTableAddress = await createAndExtendLookupTable(
      connection,
      payer,
      Array.from(altAddressMap.values())
    );

    lookupTableAccount = await getLookupTableAccountOrThrow(
      connection,
      lookupTableAddress
    );
  });

  it("batch deposits 2-3 tokens with ALT and verifies every deposit succeeded", async () => {
    for (const tokenCase of tokenCases) {
      await assertUserHasEnoughBalance(tokenCase);
    }

    const beforeStates = await Promise.all(
      tokenCases.map((tokenCase) => readTokenState(tokenCase))
    );

    const signature = await batchDepositTokens(
      connection,
      provider,
      payer,
      program,
      lookupTableAccount,
      tokenCases.map((tokenCase) => tokenCase.mint),
      tokenCases.map((tokenCase) => tokenCase.amount),
      BANK_APP_ACCOUNTS
    );

    expect(signature).to.be.a("string");

    const afterStates = await Promise.all(
      tokenCases.map((tokenCase) => readTokenState(tokenCase))
    );

    for (let i = 0; i < tokenCases.length; i++) {
      expect(
        afterStates[i].bankAtaAmount.sub(beforeStates[i].bankAtaAmount).eq(tokenCases[i].amount),
        `${tokenCases[i].label}: bank ATA delta mismatch`
      ).to.eq(true);

      expect(
        afterStates[i].reserveAmount.sub(beforeStates[i].reserveAmount).eq(tokenCases[i].amount),
        `${tokenCases[i].label}: user reserve delta mismatch`
      ).to.eq(true);
    }
  });

  it("fails atomically when one token amount exceeds user balance", async () => {
    const validToken = tokenCases[0];
    const failingTokenBase = tokenCases[1];

    await assertUserHasEnoughBalance(validToken);
    const failingUserBalance = await assertUserHasEnoughBalance(failingTokenBase);

    const failingBatch: TokenCase[] = [
      validToken,
      {
        ...failingTokenBase,
        amount: failingUserBalance.add(new BN(1)),
      },
    ];

    const beforeStates = await Promise.all(
      failingBatch.map((tokenCase) => readTokenState(tokenCase))
    );

    try {
      await batchDepositTokens(
        connection,
        provider,
        payer,
        program,
        lookupTableAccount,
        failingBatch.map((tokenCase) => tokenCase.mint),
        failingBatch.map((tokenCase) => tokenCase.amount),
        BANK_APP_ACCOUNTS
      );

      expect.fail("Expected batch deposit to fail due to insufficient balance");
    } catch (err: any) {
      const message = String(err?.message ?? err);
      expect(message).to.match(/insufficient|custom program error|0x1/i);
    }

    const afterStates = await Promise.all(
      failingBatch.map((tokenCase) => readTokenState(tokenCase))
    );

    for (let i = 0; i < failingBatch.length; i++) {
      expect(
        afterStates[i].bankAtaAmount.sub(beforeStates[i].bankAtaAmount).eq(new BN(0)),
        `${failingBatch[i].label}: bank ATA changed even though transaction should rollback`
      ).to.eq(true);

      expect(
        afterStates[i].reserveAmount.sub(beforeStates[i].reserveAmount).eq(new BN(0)),
        `${failingBatch[i].label}: reserve changed even though transaction should rollback`
      ).to.eq(true);
    }
  });

  it("compares legacy message size vs v0 + ALT for the same batch instructions", async () => {
    for (const tokenCase of tokenCases) {
      await assertUserHasEnoughBalance(tokenCase);
    }

    const instructions = await buildBatchDepositInstructions(tokenCases);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const legacyTx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: blockhash,
    }).add(...instructions);

    const legacyMessageSize = legacyTx.serializeMessage().length;

    const v0Message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message([lookupTableAccount]);

    const v0MessageSize = v0Message.serialize().length;

    console.log("Legacy message size:", legacyMessageSize);
    console.log("V0 + ALT message size:", v0MessageSize);

    expect(v0MessageSize).to.be.lessThan(legacyMessageSize);
  });
});
