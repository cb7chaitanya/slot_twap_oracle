#[cfg(test)]
mod tests {
    use anchor_lang::{AnchorDeserialize, InstructionData};
    use litesvm::LiteSVM;
    use solana_sdk::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        signature::Keypair,
        signer::Signer,
        system_program,
        transaction::Transaction,
    };
    use std::str::FromStr;

    use slot_twap_oracle::state::Oracle;

    const PROGRAM_ID: &str = "7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT";

    fn program_id() -> Pubkey {
        Pubkey::from_str(PROGRAM_ID).unwrap()
    }

    fn oracle_pda(base_mint: &Pubkey, quote_mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"oracle", base_mint.as_ref(), quote_mint.as_ref()],
            &program_id(),
        )
    }

    fn setup() -> LiteSVM {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(
            program_id(),
            "../target/deploy/slot_twap_oracle.so",
        )
        .expect("Failed to load program");
        svm
    }

    fn build_initialize_ix(
        payer: &Pubkey,
        base_mint: &Pubkey,
        quote_mint: &Pubkey,
    ) -> Instruction {
        let (oracle_pda, _) = oracle_pda(base_mint, quote_mint);

        let data = slot_twap_oracle::instruction::InitializeOracle {
            base_mint: *base_mint,
            quote_mint: *quote_mint,
        }
        .data();

        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(oracle_pda, false),
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data,
        }
    }

    fn build_update_price_ix(oracle: &Pubkey, new_price: u128) -> Instruction {
        let data = slot_twap_oracle::instruction::UpdatePrice { new_price }.data();

        Instruction {
            program_id: program_id(),
            accounts: vec![AccountMeta::new(*oracle, false)],
            data,
        }
    }

    fn deserialize_oracle(svm: &LiteSVM, pubkey: &Pubkey) -> Oracle {
        let account = svm.get_account(pubkey).expect("Oracle account not found");
        // Skip 8-byte Anchor discriminator
        Oracle::deserialize(&mut &account.data[8..]).expect("Failed to deserialize Oracle")
    }

    // ── Happy-path tests ──

    #[test]
    fn test_initialize_oracle() {
        let mut svm = setup();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        let (oracle_pda, _) = oracle_pda(&base_mint, &quote_mint);

        let ix = build_initialize_ix(&payer.pubkey(), &base_mint, &quote_mint);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);

        svm.send_transaction(tx).expect("initialize_oracle failed");

        let oracle = deserialize_oracle(&svm, &oracle_pda);
        assert_eq!(oracle.base_mint, base_mint);
        assert_eq!(oracle.quote_mint, quote_mint);
        assert_eq!(oracle.last_price, 0);
        assert_eq!(oracle.cumulative_price, 0);
    }

    #[test]
    fn test_update_price_single() {
        let mut svm = setup();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        let (oracle_pda, _) = oracle_pda(&base_mint, &quote_mint);

        // Initialize
        let ix = build_initialize_ix(&payer.pubkey(), &base_mint, &quote_mint);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
        svm.send_transaction(tx).unwrap();

        let oracle_before = deserialize_oracle(&svm, &oracle_pda);
        let init_slot = oracle_before.last_slot;

        // Warp forward so slot_delta > 0
        svm.warp_to_slot(init_slot + 10);
        svm.expire_blockhash();

        // Update price
        let new_price: u128 = 1_000_000;
        let ix = build_update_price_ix(&oracle_pda, new_price);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
        svm.send_transaction(tx).expect("update_price failed");

        let oracle = deserialize_oracle(&svm, &oracle_pda);
        assert_eq!(oracle.last_price, new_price);
        // cumulative = old_price(0) * slot_delta(10) = 0
        assert_eq!(oracle.cumulative_price, 0);
        assert_eq!(oracle.last_slot, init_slot + 10);
    }

    #[test]
    fn test_update_price_accumulates_cumulative() {
        let mut svm = setup();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        let (oracle_pda, _) = oracle_pda(&base_mint, &quote_mint);

        // Initialize
        let ix = build_initialize_ix(&payer.pubkey(), &base_mint, &quote_mint);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
        svm.send_transaction(tx).unwrap();

        let init_slot = deserialize_oracle(&svm, &oracle_pda).last_slot;

        // First update: set price to 500, after 10 slots
        svm.warp_to_slot(init_slot + 10);
        svm.expire_blockhash();
        let ix = build_update_price_ix(&oracle_pda, 500);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
        svm.send_transaction(tx).unwrap();

        let oracle = deserialize_oracle(&svm, &oracle_pda);
        // cumulative = 0 * 10 = 0
        assert_eq!(oracle.cumulative_price, 0);
        assert_eq!(oracle.last_price, 500);

        // Second update: set price to 1000, after 20 more slots
        svm.warp_to_slot(init_slot + 30);
        svm.expire_blockhash();
        let ix = build_update_price_ix(&oracle_pda, 1000);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
        svm.send_transaction(tx).unwrap();

        let oracle = deserialize_oracle(&svm, &oracle_pda);
        // cumulative = 0 + 500 * 20 = 10_000
        assert_eq!(oracle.cumulative_price, 10_000);
        assert_eq!(oracle.last_price, 1000);

        // Third update: set price to 2000, after 5 more slots
        svm.warp_to_slot(init_slot + 35);
        svm.expire_blockhash();
        let ix = build_update_price_ix(&oracle_pda, 2000);
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
        svm.send_transaction(tx).unwrap();

        let oracle = deserialize_oracle(&svm, &oracle_pda);
        // cumulative = 10_000 + 1000 * 5 = 15_000
        assert_eq!(oracle.cumulative_price, 15_000);
        assert_eq!(oracle.last_price, 2000);
        assert_eq!(oracle.last_slot, init_slot + 35);
    }
}
