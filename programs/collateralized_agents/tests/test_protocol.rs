use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    collateralized_agents::{
        constants::*,
        state::{Agent, Position, PositionStatus},
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;

struct Env {
    svm: LiteSVM,
    program_id: Pubkey,
    agent_auth: Keypair,
    trader: Keypair,
    agent: Pubkey,
    agent_vault: Pubkey,
}

impl Env {
    fn new() -> Self {
        let program_id = collateralized_agents::id();
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/collateralized_agents.so"
        ));
        svm.add_program(program_id, bytes).unwrap();
        let agent_auth = Keypair::new();
        let trader = Keypair::new();
        svm.airdrop(&agent_auth.pubkey(), 100 * SOL).unwrap();
        svm.airdrop(&trader.pubkey(), 100 * SOL).unwrap();
        let agent =
            Pubkey::find_program_address(&[AGENT_SEED, agent_auth.pubkey().as_ref()], &program_id).0;
        let agent_vault =
            Pubkey::find_program_address(&[AGENT_VAULT_SEED, agent.as_ref()], &program_id).0;
        Self { svm, program_id, agent_auth, trader, agent, agent_vault }
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    fn advance_time(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    fn agent_state(&self) -> Agent {
        let acc = self.svm.get_account(&self.agent).unwrap();
        Agent::try_deserialize(&mut &acc.data[..]).unwrap()
    }

    fn position_pda(&self, nonce: u64) -> (Pubkey, Pubkey) {
        let position = Pubkey::find_program_address(
            &[
                POSITION_SEED,
                self.agent.as_ref(),
                self.trader.pubkey().as_ref(),
                &nonce.to_le_bytes(),
            ],
            &self.program_id,
        )
        .0;
        let vault =
            Pubkey::find_program_address(&[POSITION_VAULT_SEED, position.as_ref()], &self.program_id).0;
        (position, vault)
    }

    fn position_state(&self, nonce: u64) -> Position {
        let (position, _) = self.position_pda(nonce);
        let acc = self.svm.get_account(&position).unwrap();
        Position::try_deserialize(&mut &acc.data[..]).unwrap()
    }

    // ---- instruction builders ----

    fn register(&mut self, ratio_bps: u16, drawdown_bps: u16) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::RegisterAgent {
                name: "Momentum Bot".into(),
                strategy: "SOL/USDC momentum".into(),
                collateral_ratio_bps: ratio_bps,
                max_drawdown_bps: drawdown_bps,
            }
            .data(),
            collateralized_agents::accounts::RegisterAgent {
                authority: self.agent_auth.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.agent_auth.insecure_clone();
        self.send(ix, &signer)
    }

    fn deposit(&mut self, amount: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::DepositCollateral { amount }.data(),
            collateralized_agents::accounts::DepositCollateral {
                authority: self.agent_auth.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.agent_auth.insecure_clone();
        self.send(ix, &signer)
    }

    fn withdraw(&mut self, amount: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::WithdrawCollateral { amount }.data(),
            collateralized_agents::accounts::WithdrawCollateral {
                authority: self.agent_auth.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.agent_auth.insecure_clone();
        self.send(ix, &signer)
    }

    fn open(&mut self, nonce: u64, amount: u64, duration: i64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::OpenPosition { nonce, amount, duration_secs: duration }
                .data(),
            collateralized_agents::accounts::OpenPosition {
                trader: self.trader.pubkey(),
                agent: self.agent,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.trader.insecure_clone();
        self.send(ix, &signer)
    }

    fn draw(&mut self, nonce: u64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::DrawFunds {}.data(),
            collateralized_agents::accounts::DrawFunds {
                authority: self.agent_auth.pubkey(),
                agent: self.agent,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.agent_auth.insecure_clone();
        self.send(ix, &signer)
    }

    fn settle(&mut self, nonce: u64, returned: u64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::SettlePosition { returned }.data(),
            collateralized_agents::accounts::SettlePosition {
                authority: self.agent_auth.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                position,
                position_vault,
                trader: self.trader.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.agent_auth.insecure_clone();
        self.send(ix, &signer)
    }

    fn claim_default(&mut self, nonce: u64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::ClaimDefault {}.data(),
            collateralized_agents::accounts::ClaimDefault {
                trader: self.trader.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.trader.insecure_clone();
        self.send(ix, &signer)
    }

    fn cancel(&mut self, nonce: u64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &collateralized_agents::instruction::CancelPosition {}.data(),
            collateralized_agents::accounts::CancelPosition {
                trader: self.trader.pubkey(),
                agent: self.agent,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let signer = self.trader.insecure_clone();
        self.send(ix, &signer)
    }
}

fn assert_err(res: Result<(), String>, code: &str) {
    let err = res.expect_err("expected failure");
    assert!(err.contains(code), "expected error {code}, got {err}");
}

#[test]
fn register_sets_fee_from_collateral_ratio() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    let a = env.agent_state();
    assert_eq!(a.collateral_ratio_bps, 3_000);
    assert_eq!(a.fee_bps, 1_500); // 30% collateral -> 15% performance fee
    assert!(a.accepting);
    assert_eq!(a.total_collateral, 0);
}

#[test]
fn register_rejects_bad_ratio() {
    let mut env = Env::new();
    assert_err(env.register(500, 2_000), "Custom(6000)"); // InvalidCollateralRatio
}

#[test]
fn open_locks_collateral_and_rejects_when_unbacked() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();

    // 1k -> 300 guaranteed: 1 SOL of collateral backs at most 3.33 SOL managed.
    assert_err(env.open(0, 4 * SOL, 3_600), "Custom(6005)"); // InsufficientFreeCollateral

    env.open(0, 1_000_000_000, 3_600).unwrap();
    let a = env.agent_state();
    assert_eq!(a.locked_collateral, 300_000_000);
    assert_eq!(a.free_collateral(), 700_000_000);
    assert_eq!(a.open_positions, 1);
    let p = env.position_state(0);
    assert_eq!(p.principal, 1 * SOL);
    assert_eq!(p.locked_collateral, 300_000_000);
    assert_eq!(p.status, PositionStatus::Open);

    // locked collateral cannot be withdrawn
    assert_err(env.withdraw(800_000_000), "Custom(6005)");
    env.withdraw(700_000_000).unwrap();
    assert_eq!(env.agent_state().total_collateral, 300_000_000);
}

#[test]
fn profitable_settlement_pays_fee_on_profit() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap();
    env.draw(0).unwrap();
    assert_eq!(env.position_state(0).status, PositionStatus::Trading);

    let trader_before = env.balance(&env.trader.pubkey());
    let agent_before = env.balance(&env.agent_auth.pubkey());

    // Agent made 20%: returns 1.2 SOL. Fee = 15% of 0.2 = 0.03 SOL.
    env.settle(0, 1_200_000_000).unwrap();

    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Settled);
    assert_eq!(p.fee_paid, 30_000_000);
    assert_eq!(p.slashed, 0);
    let rent_floor = env.svm.get_sysvar::<anchor_lang::prelude::Rent>().minimum_balance(0);
    assert_eq!(
        env.balance(&env.trader.pubkey()) - trader_before,
        1_170_000_000 + rent_floor
    );
    // agent paid 1.2 SOL, got 0.03 back, minus tx fee (5000)
    assert_eq!(agent_before - env.balance(&env.agent_auth.pubkey()), 1_170_000_000 + 5_000);

    let a = env.agent_state();
    assert_eq!(a.locked_collateral, 0);
    assert_eq!(a.total_collateral, 1 * SOL);
    assert_eq!(a.settled_positions, 1);
    assert_eq!(a.fees_earned, 30_000_000);
}

#[test]
fn loss_within_drawdown_is_not_slashed() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap();
    env.draw(0).unwrap();
    env.settle(0, 850_000_000).unwrap(); // -15%, allowed up to -20%
    let p = env.position_state(0);
    assert_eq!(p.slashed, 0);
    assert_eq!(p.fee_paid, 0);
    assert_eq!(env.agent_state().total_collateral, 1 * SOL);
}

#[test]
fn loss_beyond_drawdown_slashes_collateral() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap();
    env.draw(0).unwrap();
    let trader_before = env.balance(&env.trader.pubkey());

    // -50%: allowed loss 0.2, shortfall 0.3 -> fully covered by the 0.3 guarantee.
    env.settle(0, 500_000_000).unwrap();
    let p = env.position_state(0);
    assert_eq!(p.slashed, 300_000_000);
    let rent_floor = env.svm.get_sysvar::<anchor_lang::prelude::Rent>().minimum_balance(0);
    assert_eq!(
        env.balance(&env.trader.pubkey()) - trader_before,
        800_000_000 + rent_floor
    );
    let a = env.agent_state();
    assert_eq!(a.total_collateral, 700_000_000);
    assert_eq!(a.slashed_total, 300_000_000);
    assert_eq!(a.locked_collateral, 0);
}

#[test]
fn slash_is_capped_at_locked_guarantee() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap();
    env.draw(0).unwrap();
    env.settle(0, 0).unwrap(); // lost everything: shortfall 0.8, guarantee 0.3
    assert_eq!(env.position_state(0).slashed, 300_000_000);
    assert_eq!(env.agent_state().total_collateral, 700_000_000);
}

#[test]
fn missed_deadline_pays_guarantee_to_trader() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap();
    env.draw(0).unwrap();

    assert_err(env.claim_default(0), "Custom(6010)"); // DeadlineNotReached
    env.advance_time(3_601);
    let trader_before = env.balance(&env.trader.pubkey());
    env.claim_default(0).unwrap();

    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Defaulted);
    assert_eq!(p.slashed, 300_000_000);
    let rent_floor = env.svm.get_sysvar::<anchor_lang::prelude::Rent>().minimum_balance(0);
    assert_eq!(
        env.balance(&env.trader.pubkey()) - trader_before + 5_000,
        300_000_000 + rent_floor
    );
    let a = env.agent_state();
    assert_eq!(a.total_collateral, 700_000_000);
    assert_eq!(a.locked_collateral, 0);
    assert_eq!(a.defaulted_positions, 1);

    // agent can no longer settle a defaulted position
    assert_err(env.settle(0, 1 * SOL), "Custom(6008)"); // InvalidStatus
}

#[test]
fn agent_cannot_draw_after_deadline() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 60).unwrap();
    env.advance_time(61);
    assert_err(env.draw(0), "Custom(6011)"); // DeadlinePassed
    // trader gets principal back via cancel
    env.cancel(0).unwrap();
    assert_eq!(env.position_state(0).status, PositionStatus::Cancelled);
}

#[test]
fn cancel_before_draw_refunds_and_unlocks() {
    let mut env = Env::new();
    env.register(3_000, 2_000).unwrap();
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap();
    let trader_before = env.balance(&env.trader.pubkey());
    env.cancel(0).unwrap();
    let rent_floor = env.svm.get_sysvar::<anchor_lang::prelude::Rent>().minimum_balance(0);
    assert_eq!(
        env.balance(&env.trader.pubkey()) - trader_before + 5_000,
        1 * SOL + rent_floor
    );
    assert_eq!(env.agent_state().locked_collateral, 0);
    // cannot cancel twice / cannot draw a cancelled position
    assert_err(env.cancel(0), "Custom(6008)");
    assert_err(env.draw(0), "Custom(6008)");
}

#[test]
fn multiple_positions_share_collateral_pool() {
    let mut env = Env::new();
    env.register(5_000, 1_000).unwrap(); // 50% collateral -> 25% fee
    env.deposit(1 * SOL).unwrap();
    env.open(0, 1 * SOL, 3_600).unwrap(); // locks 0.5
    env.open(1, 1 * SOL, 3_600).unwrap(); // locks 0.5
    assert_err(env.open(2, 1, 3_600), "Custom(6005)"); // pool exhausted: even 1 lamport needs 1 lamport locked
    let a = env.agent_state();
    assert_eq!(a.locked_collateral, 1 * SOL);
    assert_eq!(a.capital_managed, 2 * SOL);
    assert_eq!(a.open_positions, 2);

    // settling one frees half the pool
    env.draw(0).unwrap();
    env.settle(0, 1 * SOL).unwrap();
    assert_eq!(env.agent_state().free_collateral(), 500_000_000);
    env.open(2, 1 * SOL, 3_600).unwrap();
}
