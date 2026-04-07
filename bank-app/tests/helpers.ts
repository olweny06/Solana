import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  Signer,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { BankApp } from "../target/types/bank_app";

const ALT_EXTEND_CHUNK_SIZE = 20;
const DEFAULT_ALT_WAIT_RETRIES = 15;
const DEFAULT_ALT_WAIT_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupePublicKeys(keys: PublicKey[]): PublicKey[] {
  const map = new Map<string, PublicKey>();

  for (const key of keys) {
    map.set(key.toBase58(), key);
  }

  return Array.from(map.values());
}

function chunkPublicKeys(keys: PublicKey[], chunkSize: number): PublicKey[][] {
  const chunks: PublicKey[][] = [];

  for (let i = 0; i < keys.length; i += chunkSize) {
    chunks.push(keys.slice(i, i + chunkSize));
  }

  return chunks;
}

async function fetchLookupTableOrThrow(
  connection: Connection,
  lookupTableAddress: PublicKey
): Promise<AddressLookupTableAccount> {
  const lookupTable = (await connection.getAddressLookupTable(lookupTableAddress)).value;

  if (!lookupTable) {
    throw new Error(`Lookup table ${lookupTableAddress.toBase58()} not found`);
  }

  return lookupTable;
}

async function waitForLookupTable(
  connection: Connection,
  lookupTableAddress: PublicKey,
  expectedAddressCount: number,
  retries = DEFAULT_ALT_WAIT_RETRIES,
  delayMs = DEFAULT_ALT_WAIT_MS
): Promise<AddressLookupTableAccount> {
  for (let i = 0; i < retries; i++) {
    const lookupTable = (await connection.getAddressLookupTable(lookupTableAddress)).value;

    if (lookupTable && lookupTable.state.addresses.length >= expectedAddressCount) {
      return lookupTable;
    }

    await sleep(delayMs);
  }

  throw new Error(
    `ALT ${lookupTableAddress.toBase58()} was not ready after waiting for ${retries} retries`
  );
}

export async function createAndExtendLookupTable(
  connection: Connection,
  payer: Signer,
  newAddresses: PublicKey[],
  existingAltAddress?: PublicKey
): Promise<PublicKey> {
  const dedupedNewAddresses = dedupePublicKeys(newAddresses);

  let lookupTableAddress = existingAltAddress;
  let currentLookupTable: AddressLookupTableAccount | null = null;

  if (!lookupTableAddress) {
    console.log("No existing ALT provided. Creating a new lookup table...");

    const recentSlot = await connection.getSlot("confirmed");
    const [createIx, createdLookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot,
      });

    lookupTableAddress = createdLookupTableAddress;

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [createIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payer]);

    const signature = await connection.sendTransaction(tx);
    await connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );

    currentLookupTable = await waitForLookupTable(connection, lookupTableAddress, 0);
    console.log(`Created ALT: ${lookupTableAddress.toBase58()}`);
  } else {
    console.log(`Using existing ALT: ${lookupTableAddress.toBase58()}`);
    currentLookupTable = await fetchLookupTableOrThrow(connection, lookupTableAddress);
  }

  const existingAddressSet = new Set(
    currentLookupTable.state.addresses.map((address) => address.toBase58())
  );

  const addressesToAdd = dedupedNewAddresses.filter(
    (address) => !existingAddressSet.has(address.toBase58())
  );

  if (addressesToAdd.length === 0) {
    console.log("No new addresses to extend into ALT.");
    return lookupTableAddress;
  }

  console.log(`Adding ${addressesToAdd.length} new addresses to ALT...`);

  let expectedAddressCount = currentLookupTable.state.addresses.length;
  const addressChunks = chunkPublicKeys(addressesToAdd, ALT_EXTEND_CHUNK_SIZE);

  for (const chunk of addressChunks) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lookupTableAddress,
      addresses: chunk,
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [extendIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payer]);

    const signature = await connection.sendTransaction(tx);
    await connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );

    expectedAddressCount += chunk.length;
    currentLookupTable = await waitForLookupTable(
      connection,
      lookupTableAddress,
      expectedAddressCount
    );
  }

  console.log("ALT setup completed.");
  return lookupTableAddress;
}

export async function getLookupTableAccountOrThrow(
  connection: Connection,
  lookupTableAddress: PublicKey
): Promise<AddressLookupTableAccount> {
  return fetchLookupTableOrThrow(connection, lookupTableAddress);
}

export interface BankAppAccountsForTokenDeposit {
  bankInfo: PublicKey;
  bankVault: PublicKey;
  userReserve: (pubkey: PublicKey, tokenMint: PublicKey) => PublicKey;
}

export async function batchDepositTokens(
  connection: Connection,
  provider: anchor.AnchorProvider,
  payer: Signer,
  program: anchor.Program<BankApp>,
  lookupTableAccount: AddressLookupTableAccount,
  tokenMints: PublicKey[],
  amounts: anchor.BN[],
  bankAccounts: BankAppAccountsForTokenDeposit
) {
  if (tokenMints.length === 0) {
    throw new Error("tokenMints must not be empty");
  }

  if (tokenMints.length !== amounts.length) {
    throw new Error("tokenMints and amounts length mismatch");
  }

  if (!provider.publicKey.equals(payer.publicKey)) {
    throw new Error(
      "provider.publicKey and payer.publicKey must match in batchDepositTokens"
    );
  }

  const instructions: TransactionInstruction[] = [];
  const userPubkey = payer.publicKey;

  const bankAtas = tokenMints.map((mint) =>
    getAssociatedTokenAddressSync(mint, bankAccounts.bankVault, true)
  );
  const userAtas = tokenMints.map((mint) =>
    getAssociatedTokenAddressSync(mint, userPubkey)
  );

  const [bankAtaInfos, userAtaInfos] = await Promise.all([
    connection.getMultipleAccountsInfo(bankAtas),
    connection.getMultipleAccountsInfo(userAtas),
  ]);

  for (let i = 0; i < tokenMints.length; i++) {
    const tokenMint = tokenMints[i];
    const amount = amounts[i];
    const bankAta = bankAtas[i];
    const userAta = userAtas[i];
    const userReserve = bankAccounts.userReserve(userPubkey, tokenMint);

    if (!amount || amount.lten(0)) {
      throw new Error(`Invalid deposit amount at index ${i}`);
    }

    if (!userAtaInfos[i]) {
      throw new Error(
        `User ATA does not exist for mint ${tokenMint.toBase58()}. Create/fund it before running the test.`
      );
    }

    if (!bankAtaInfos[i]) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          userPubkey,
          bankAta,
          bankAccounts.bankVault,
          tokenMint
        )
      );
    }

    instructions.push(
      await program.methods
        .depositToken(amount)
        .accountsStrict({
          bankInfo: bankAccounts.bankInfo,
          bankVault: bankAccounts.bankVault,
          tokenMint,
          userAta,
          bankAta,
          userReserve,
          user: userPubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: userPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lookupTableAccount]);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer]);

  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed"
  );

  return signature;
}

export interface SolDepositInput {
  user: Signer;
  amount: anchor.BN;
}

export async function batchDepositSol(
  connection: Connection,
  program: anchor.Program<BankApp>,
  payer: Signer,
  deposits: SolDepositInput[],
  lookupTableAccount?: AddressLookupTableAccount
) {
  if (deposits.length === 0) {
    throw new Error("deposits must not be empty");
  }

  const instructions: TransactionInstruction[] = [];
  const uniqueSigners = new Map<string, Signer>();
  uniqueSigners.set(payer.publicKey.toBase58(), payer);

  const [bankInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("BANK_INFO_SEED")],
    program.programId
  );
  const [bankVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("BANK_VAULT_SEED")],
    program.programId
  );

  for (const deposit of deposits) {
    if (!deposit.amount || deposit.amount.lten(0)) {
      throw new Error("Each SOL deposit amount must be greater than 0");
    }

    uniqueSigners.set(deposit.user.publicKey.toBase58(), deposit.user);

    const [userReservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("USER_RESERVE_SEED"), deposit.user.publicKey.toBuffer()],
      program.programId
    );

    const ix = await program.methods
      .deposit(deposit.amount)
      .accountsStrict({
        bankInfo: bankInfoPda,
        bankVault: bankVaultPda,
        userReserve: userReservePda,
        user: deposit.user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    instructions.push(ix);
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccount ? [lookupTableAccount] : []);

  const tx = new VersionedTransaction(messageV0);
  tx.sign(Array.from(uniqueSigners.values()));

  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed"
  );

  return signature;
}
