use {
    anchor_lang::{
        prelude::{Clock, Pubkey, Rent},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    proof_of_agent::{
        constants::*,
        state::{Agent, AgentStatus, AgentTerms, Breach, Position, PositionStatus},
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;
const TX_FEE: u64 = 5_000;

fn terms(ratio: u16, fee: u16, drawdown: u16) -> AgentTerms {
    AgentTerms {
        collateral_ratio_bps: ratio,
        fee_bps: fee,
        max_drawdown_bps: drawdown,
        min_duration_secs: 60,
        max_duration_secs: 7 * 24 * 3600,
        allowed_assets: vec![Pubkey::new_unique(), Pubkey::new_unique()],
        rules: "Trade SOL/USDC only. Max 50% of a position in USDC.".into(),
    }
}

struct Env {
    svm: LiteSVM,
    program_id: Pubkey,
    operator: Keypair,
    executor: Keypair,
    trader: Keypair,
    agent: Pubkey,
    agent_vault: Pubkey,
    agent_id: u64,
}

impl Env {
    fn new() -> Self {
        let program_id = proof_of_agent::id();
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/proof_of_agent.so"));
        svm.add_program(program_id, bytes).unwrap();
        // The simulated clock starts at 0; use a realistic date.
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = 1_789_000_000;
        svm.set_sysvar(&clock);
        let operator = Keypair::new();
        let executor = Keypair::new();
        let trader = Keypair::new();
        for k in [&operator, &executor, &trader] {
            svm.airdrop(&k.pubkey(), 100 * SOL).unwrap();
        }
        let agent_id = 7u64;
        let agent = Pubkey::find_program_address(
            &[AGENT_SEED, operator.pubkey().as_ref(), &agent_id.to_le_bytes()],
            &program_id,
        )
        .0;
        let agent_vault = Pubkey::find_program_address(&[AGENT_VAULT_SEED, agent.as_ref()], &program_id).0;
        Self { svm, program_id, operator, executor, trader, agent, agent_vault, agent_id }
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn advance_time(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    fn rent_floor(&self) -> u64 {
        self.svm.get_sysvar::<Rent>().minimum_balance(0)
    }

    fn agent_state(&self) -> Agent {
        let acc = self.svm.get_account(&self.agent).unwrap();
        Agent::try_deserialize(&mut &acc.data[..]).unwrap()
    }

    fn position_pda(&self, nonce: u64) -> (Pubkey, Pubkey) {
        let position = Pubkey::find_program_address(
            &[POSITION_SEED, self.agent.as_ref(), self.trader.pubkey().as_ref(), &nonce.to_le_bytes()],
            &self.program_id,
        )
        .0;
        let vault = Pubkey::find_program_address(&[POSITION_VAULT_SEED, position.as_ref()], &self.program_id).0;
        (position, vault)
    }

    fn position_state(&self, nonce: u64) -> Position {
        let acc = self.svm.get_account(&self.position_pda(nonce).0).unwrap();
        Position::try_deserialize(&mut &acc.data[..]).unwrap()
    }

    fn op(&self) -> Keypair {
        self.operator.insecure_clone()
    }

    // ---- operator ----

    fn create(&mut self, t: AgentTerms) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::CreateAgent {
                agent_id: self.agent_id,
                name: "Momentum Bot".into(),
                description: "SOL/USDC momentum".into(),
                terms: t,
            }
            .data(),
            proof_of_agent::accounts::CreateAgent {
                operator: self.operator.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let s = self.op();
        self.send(ix, &s)
    }

    fn update(&mut self, t: AgentTerms, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::UpdateAgent {
                name: "Momentum Bot v2".into(),
                description: "edited".into(),
                terms: t,
            }
            .data(),
            proof_of_agent::accounts::UpdateAgent { operator: signer.pubkey(), agent: self.agent }
                .to_account_metas(None),
        );
        self.send(ix, signer)
    }

    fn publish(&mut self) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::PublishAgent {}.data(),
            proof_of_agent::accounts::PublishAgent { operator: self.operator.pubkey(), agent: self.agent }
                .to_account_metas(None),
        );
        let s = self.op();
        self.send(ix, &s)
    }

    fn bind_executor(&mut self, executor: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::SetExecutor { executor }.data(),
            proof_of_agent::accounts::SetExecutor { operator: signer.pubkey(), agent: self.agent }
                .to_account_metas(None),
        );
        self.send(ix, signer)
    }

    fn set_accepting(&mut self, accepting: bool) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::SetAccepting { accepting }.data(),
            proof_of_agent::accounts::SetAccepting { operator: self.operator.pubkey(), agent: self.agent }
                .to_account_metas(None),
        );
        let s = self.op();
        self.send(ix, &s)
    }

    fn deposit(&mut self, amount: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::DepositCollateral { amount }.data(),
            proof_of_agent::accounts::DepositCollateral {
                operator: self.operator.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let s = self.op();
        self.send(ix, &s)
    }

    fn withdraw(&mut self, amount: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::WithdrawCollateral { amount }.data(),
            proof_of_agent::accounts::WithdrawCollateral {
                operator: self.operator.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let s = self.op();
        self.send(ix, &s)
    }

    /// Standard setup: 30% ratio, 15% fee, 20% tolerance, 1 SOL bond, published.
    fn launched() -> Self {
        let mut env = Env::new();
        env.create(terms(3_000, 1_500, 2_000)).unwrap();
        env.deposit(SOL).unwrap();
        env.publish().unwrap();
        env
    }

    // ---- trading key ----

    fn draw(&mut self, nonce: u64, signer: &Keypair) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::DrawFunds {}.data(),
            proof_of_agent::accounts::DrawFunds {
                executor: signer.pubkey(),
                agent: self.agent,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer)
    }

    fn settle(&mut self, nonce: u64, returned: u64, signer: &Keypair) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::SettlePosition { returned }.data(),
            proof_of_agent::accounts::SettlePosition {
                executor: signer.pubkey(),
                operator: self.operator.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                position,
                position_vault,
                trader: self.trader.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer)
    }

    // ---- trader ----

    fn open(&mut self, nonce: u64, amount: u64, duration: i64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::OpenPosition { nonce, amount, duration_secs: duration }.data(),
            proof_of_agent::accounts::OpenPosition {
                trader: self.trader.pubkey(),
                agent: self.agent,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let s = self.trader.insecure_clone();
        self.send(ix, &s)
    }

    fn claim_default(&mut self, nonce: u64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::ClaimDefault {}.data(),
            proof_of_agent::accounts::ClaimDefault {
                trader: self.trader.pubkey(),
                agent: self.agent,
                agent_vault: self.agent_vault,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let s = self.trader.insecure_clone();
        self.send(ix, &s)
    }

    fn cancel(&mut self, nonce: u64) -> Result<(), String> {
        let (position, position_vault) = self.position_pda(nonce);
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::CancelPosition {}.data(),
            proof_of_agent::accounts::CancelPosition {
                trader: self.trader.pubkey(),
                agent: self.agent,
                position,
                position_vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let s = self.trader.insecure_clone();
        self.send(ix, &s)
    }
}

fn assert_err(res: Result<(), String>, code: u32) {
    let err = res.expect_err("expected failure");
    let needle = format!("Custom({code})");
    assert!(err.contains(&needle), "expected {needle}, got {err}");
}

// Error codes, in declaration order.
const E_RATIO: u32 = 6000;
const E_INSUFFICIENT: u32 = 6005;
const E_OPERATOR: u32 = 6006;
const E_STATUS: u32 = 6008;
const E_DURATION: u32 = 6009;
const E_NOT_REACHED: u32 = 6010;
const E_DEADLINE_PASSED: u32 = 6011;
const E_NOT_ACCEPTING: u32 = 6012;
const E_FEE: u32 = 6014;
const E_WINDOW: u32 = 6015;
const E_ASSETS: u32 = 6016;
const E_RULES: u32 = 6017;
const E_LOCKED: u32 = 6018;
const E_NOT_PUBLISHED: u32 = 6019;
const E_ALREADY: u32 = 6020;
const E_NO_COLLATERAL: u32 = 6021;
const E_EXECUTOR: u32 = 6022;

// ---------- publishing ----------

#[test]
fn create_starts_as_draft_with_published_terms_stored() {
    let mut env = Env::new();
    let t = terms(3_000, 1_000, 2_000);
    env.create(t.clone()).unwrap();
    let a = env.agent_state();
    assert_eq!(a.status, AgentStatus::Draft);
    assert_eq!(a.operator, env.operator.pubkey());
    assert_eq!(a.executor, env.operator.pubkey());
    assert_eq!(a.agent_id, env.agent_id);
    assert_eq!(a.terms, t);
    assert_eq!(a.published_at, 0);
}

#[test]
fn terms_are_validated() {
    let mut env = Env::new();
    assert_err(env.create(terms(500, 0, 1_000)), E_RATIO);
    assert_err(env.create(terms(3_000, 1_501, 1_000)), E_FEE); // cap is ratio / 2
    let mut t = terms(3_000, 1_500, 1_000);
    t.min_duration_secs = 7200;
    t.max_duration_secs = 3600;
    assert_err(env.create(t), E_WINDOW);
    let mut t = terms(3_000, 1_500, 1_000);
    t.allowed_assets = vec![];
    assert_err(env.create(t), E_ASSETS);
    let mut t = terms(3_000, 1_500, 1_000);
    let dup = Pubkey::new_unique();
    t.allowed_assets = vec![dup, dup];
    assert_err(env.create(t), E_ASSETS);
    let mut t = terms(3_000, 1_500, 1_000);
    t.rules = "   ".into();
    assert_err(env.create(t), E_RULES);
    env.create(terms(3_000, 1_500, 1_000)).unwrap(); // fee exactly at the cap is fine
}

#[test]
fn draft_cannot_take_positions_and_publish_needs_collateral() {
    let mut env = Env::new();
    env.create(terms(3_000, 1_500, 2_000)).unwrap();
    assert_err(env.open(0, SOL / 10, 3_600), E_NOT_ACCEPTING);
    assert_err(env.set_accepting(true), E_NOT_PUBLISHED);
    assert_err(env.publish(), E_NO_COLLATERAL);
    env.deposit(SOL).unwrap();
    env.publish().unwrap();
    let a = env.agent_state();
    assert_eq!(a.status, AgentStatus::Active);
    assert!(a.published_at > 0);
    assert_err(env.publish(), E_ALREADY);
    env.open(0, SOL / 10, 3_600).unwrap();
}

#[test]
fn terms_can_change_in_draft_and_are_locked_after_publish() {
    let mut env = Env::new();
    env.create(terms(3_000, 1_500, 2_000)).unwrap();
    let op = env.op();
    env.update(terms(5_000, 2_000, 1_000), &op).unwrap();
    let a = env.agent_state();
    assert_eq!(a.name, "Momentum Bot v2");
    assert_eq!(a.terms.collateral_ratio_bps, 5_000);
    assert_eq!(a.terms.fee_bps, 2_000);

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    assert_err(env.update(terms(5_000, 0, 0), &stranger), E_OPERATOR);

    env.deposit(SOL).unwrap();
    env.publish().unwrap();
    assert_err(env.update(terms(1_000, 0, 5_000), &op), E_LOCKED);
}

#[test]
fn pause_and_resume_after_publish() {
    let mut env = Env::launched();
    env.set_accepting(false).unwrap();
    assert_eq!(env.agent_state().status, AgentStatus::Paused);
    assert_err(env.open(0, SOL / 10, 3_600), E_NOT_ACCEPTING);
    env.set_accepting(true).unwrap();
    env.open(0, SOL / 10, 3_600).unwrap();
}

#[test]
fn trader_deadline_must_fit_the_published_window() {
    let mut env = Env::launched();
    assert_err(env.open(0, SOL / 10, 30), E_DURATION);
    assert_err(env.open(1, SOL / 10, 8 * 24 * 3600), E_DURATION);
    env.open(2, SOL / 10, 7 * 24 * 3600).unwrap();
}

// ---------- capacity ----------

#[test]
fn positions_reserve_collateral_up_to_capacity() {
    let mut env = Env::launched();
    // 1 SOL bond at 30% backs at most 3.33 SOL.
    assert_err(env.open(0, 4 * SOL, 3_600), E_INSUFFICIENT);
    env.open(0, SOL, 3_600).unwrap();
    let a = env.agent_state();
    assert_eq!(a.locked_collateral, 300_000_000);
    assert_eq!(a.free_collateral(), 700_000_000);
    assert_err(env.withdraw(800_000_000), E_INSUFFICIENT);
    env.withdraw(700_000_000).unwrap();
    assert_eq!(env.agent_state().total_collateral, 300_000_000);
}

// ---------- trading key ----------

#[test]
fn bound_trading_key_can_draw_and_settle_but_strangers_cannot() {
    let mut env = Env::launched();
    let executor = env.executor.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 10 * SOL).unwrap();

    assert_err(env.bind_executor(executor.pubkey(), &stranger), E_OPERATOR);
    let op = env.op();
    env.bind_executor(executor.pubkey(), &op).unwrap();
    assert_eq!(env.agent_state().executor, executor.pubkey());

    env.open(0, SOL, 3_600).unwrap();
    assert_err(env.draw(0, &stranger), E_EXECUTOR);
    let before = env.balance(&executor.pubkey());
    env.draw(0, &executor).unwrap();
    assert_eq!(env.balance(&executor.pubkey()) - before + TX_FEE, SOL);

    assert_err(env.settle(0, SOL, &stranger), E_EXECUTOR);
    // Profit: 1.2 SOL back, 15% of 0.2 goes to the operator, not the executor.
    let op_before = env.balance(&env.operator.pubkey());
    env.settle(0, 1_200_000_000, &executor).unwrap();
    assert_eq!(env.balance(&env.operator.pubkey()) - op_before, 30_000_000);
    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Settled);
    assert_eq!(p.fee_paid, 30_000_000);
    assert_eq!(p.breach, Breach::None);
}

#[test]
fn operator_can_still_execute_after_binding_a_key() {
    let mut env = Env::launched();
    let op = env.op();
    let key = env.executor.pubkey();
    env.bind_executor(key, &op).unwrap();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    env.settle(0, SOL, &op).unwrap();
}

// ---------- settlement ----------

#[test]
fn profitable_settlement_pays_trader_and_fee() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    let trader_before = env.balance(&env.trader.pubkey());
    env.settle(0, 1_200_000_000, &op).unwrap();
    let rent = env.rent_floor();
    assert_eq!(env.balance(&env.trader.pubkey()) - trader_before, 1_170_000_000 + rent);
    let a = env.agent_state();
    assert_eq!(a.fees_earned, 30_000_000);
    assert_eq!(a.settled_positions, 1);
    assert_eq!(a.breach_count, 0);
    assert_eq!(a.locked_collateral, 0);
}

#[test]
fn loss_within_tolerance_is_not_a_breach() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    env.settle(0, 850_000_000, &op).unwrap(); // -15%, tolerance 20%
    let p = env.position_state(0);
    assert_eq!(p.slashed, 0);
    assert_eq!(p.breach, Breach::None);
    assert_eq!(env.agent_state().breach_count, 0);
}

#[test]
fn loss_beyond_tolerance_is_a_breach_and_slashes_up_to_the_bond() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    let trader_before = env.balance(&env.trader.pubkey());
    env.settle(0, 500_000_000, &op).unwrap(); // floor 0.8, shortfall 0.3 = full bond
    let p = env.position_state(0);
    assert_eq!(p.slashed, 300_000_000);
    assert_eq!(p.breach, Breach::Drawdown);
    let rent = env.rent_floor();
    assert_eq!(env.balance(&env.trader.pubkey()) - trader_before, 800_000_000 + rent);
    let a = env.agent_state();
    assert_eq!(a.breach_count, 1);
    assert_eq!(a.slashed_total, 300_000_000);
    assert_eq!(a.total_collateral, 700_000_000);

    env.open(1, SOL, 3_600).unwrap();
    env.draw(1, &op).unwrap();
    env.settle(1, 0, &op).unwrap(); // shortfall 0.8, capped at 0.3
    assert_eq!(env.position_state(1).slashed, 300_000_000);
    assert_eq!(env.agent_state().breach_count, 2);
}

#[test]
fn missed_deadline_is_a_breach_and_pays_the_whole_reservation() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    assert_err(env.claim_default(0), E_NOT_REACHED);
    env.advance_time(3_601);
    let before = env.balance(&env.trader.pubkey());
    env.claim_default(0).unwrap();
    let rent = env.rent_floor();
    assert_eq!(env.balance(&env.trader.pubkey()) - before + TX_FEE, 300_000_000 + rent);
    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Defaulted);
    assert_eq!(p.breach, Breach::MissedDeadline);
    let a = env.agent_state();
    assert_eq!(a.breach_count, 1);
    assert_eq!(a.defaulted_positions, 1);
    assert_err(env.settle(0, SOL, &op), E_STATUS);
}

#[test]
fn cannot_draw_after_deadline_and_cancel_refunds() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 60).unwrap();
    env.advance_time(61);
    assert_err(env.draw(0, &op), E_DEADLINE_PASSED);
    let before = env.balance(&env.trader.pubkey());
    env.cancel(0).unwrap();
    let rent = env.rent_floor();
    assert_eq!(env.balance(&env.trader.pubkey()) - before + TX_FEE, SOL + rent);
    assert_eq!(env.position_state(0).status, PositionStatus::Cancelled);
    assert_eq!(env.agent_state().locked_collateral, 0);
    assert_err(env.cancel(0), E_STATUS);
}
