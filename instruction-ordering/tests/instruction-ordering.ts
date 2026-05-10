import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { InstructionOrdering } from "../target/types/instruction_ordering";
import { expect } from "chai";
import { SYSVAR_INSTRUCTIONS_PUBKEY, PublicKey, SystemProgram } from "@solana/web3.js";

describe("instruction-ordering", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.instructionOrdering as Program<InstructionOrdering>;

  // ------------ Instruction Ordering-----------------
  it("fails to execute without approval", async () => {
    try{
      await program.methods.execute(new anchor.BN(1000))
      .accounts({
        authority: provider.wallet.publicKey, 
      }).rpc(); 
      expect.fail("Should be failed!"); 
    } catch (err:any){
      // TODO: Verify it failed with your custom error
      expect(err.message).to.include("MustApproveFirst");
    }
  });

  it("succeeds with approval in same transaction", async () => {
    // TODO:
    // - Create approve instruction:
    //     const approveIx = await program.methods
    //       .approve()
    //       .accounts({ authority: provider.wallet.publicKey })
    //       .instruction();
    //
    // - Create execute instruction:
    //     const executeIx = await program.methods
    //       .execute(new anchor.BN(1000))
    //       .accounts({
    //         authority: provider.wallet.publicKey,
    //         instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    //       })
    //       .instruction();
    //
    // - Combine them in a single transaction in the correct order:
    //     const tx = new anchor.web3.Transaction().add(approveIx).add(executeIx);
    //     await provider.sendAndConfirm(tx);
    const approveIdx = await program.methods
    .approve()
    .accounts({ authority: provider.wallet.publicKey })
    .instruction();

    const executeIdx = await program.methods
    .execute(new anchor.BN(1000))
    .accounts({
      authority: provider.wallet.publicKey,
    })
    .instruction();

    const tx = new anchor.web3.Transaction().add(approveIdx).add(executeIdx);
    await provider.sendAndConfirm(tx);
  });

  it("fails with wrong order (execute before approve)", async () => {
    // TODO:
    // - Build execute instruction first, then approve instruction
    // - Add them to a Transaction in the wrong order
    // - Send the transaction and assert that it fails with MustApproveFirst

    const executeIdx = await program.methods
    .execute(new anchor.BN(1000))
    .accounts({
      authority: provider.wallet.publicKey,
    })
    .instruction();

    const approveIdx = await program.methods
    .approve()
    .accounts({ authority: provider.wallet.publicKey })
    .instruction();

    const tx = new anchor.web3.Transaction().add(executeIdx).add(approveIdx);

    try{
      await provider.sendAndConfirm(tx);
      expect.fail("Should be failed!");
    } catch(err:any){
      expect(err.message).to.include("MustApproveFirst");
    }
  });

  // ---------------- Part 2: Regular Account<T> vs Zero-Copy ----------------

  it("initializes and uses large approval data with regular Account<T>", async () => {
    // TODO:
    // - Derive a PDA for the "regular" account:
    //     const [regularPda] = PublicKey.findProgramAddressSync(
    //       [Buffer.from("approval_regular"), provider.wallet.publicKey.toBuffer()],
    //       program.programId
    //     );
    //
    // - Call `initializeLargeApprovalRegular` with that PDA.
    // - Then call `processLargeApprovalRegular` to write a timestamp.
    // - Fetch the account with `getAccountInfo` and assert that:
    //     * accountInfo is not null
    //     * data length is > 8 (so you know it's storing something non-trivial)
    const [regularPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("approval_regular"), provider.wallet.publicKey.toBuffer()],
      program.programId
    ); 

    await program.methods
    .initializeLargeApprovalRegular()
    .accounts({
      approvalData: regularPda,
      authority: provider.wallet.publicKey,
      SystemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

    await program.methods.processLargeApprovalRegular()
    .accounts({
      approvalData: regularPda,
      authority: provider.wallet.publicKey,
    }).rpc(); 

    const accountInfo = await provider.connection.getAccountInfo(regularPda);
    expect(accountInfo).to.not.equal(null);
    expect(accountInfo!.data.length).to.be.greaterThan(8);
  });

  it("initializes and uses large approval data with zero-copy AccountLoader<T>", async () => {
    // TODO:
    // - Derive a PDA for the zero-copy account:
    //     const [zcPda] = PublicKey.findProgramAddressSync(
    //       [Buffer.from("approval_zero_copy"), provider.wallet.publicKey.toBuffer()],
    //       program.programId
    //     );
    //
    // - Call `initializeLargeApprovalZeroCopy` with that PDA.
    // - Then call `processLargeApprovalZeroCopy`.
    // - Fetch the account with `getAccountInfo` and assert that:
    //     * accountInfo is not null
    //     * data length is large (e.g. > 4096) since it holds 512 u64 values.
    //
    // Discussion prompt for students:
    // - What happens if you try to make the "regular" account as large as the zero-copy one?
    // - When/why does the BPF stack limit become a problem?
    
    const [zcPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("approval_zero_copy"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
    .initializeLargeApprovalZeroCopy()
    .accounts({
      approvalData: zcPda,
      authority: provider.wallet.publicKey,
      SystemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

    await program.methods.processLargeApprovalZeroCopy()
    .accounts({
      approvalData: zcPda,
      authority: provider.wallet.publicKey,
    }).rpc();

    const accountInfo = await provider.connection.getAccountInfo(zcPda);
    expect(accountInfo).to.not.equal(null);
    expect(accountInfo!.data.length).to.be.greaterThan(4096);
    
  });

});
