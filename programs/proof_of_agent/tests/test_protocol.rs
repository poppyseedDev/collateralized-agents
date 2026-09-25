use {
    anchor_lang::{
        prelude::{Clock, Pubkey, Rent},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, AccountSerialize, Discriminator, Event, InstructionData, ToAccountMetas,
    },
    proof_of_agent::{
        constants::*,
        events::{AcceptingChanged, FundsDrawn, PositionDeclined},
        instructions::compute_settlement,
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

    /// Like `send`, but returns the program logs on success.
    fn send_logs(&mut self, ix: Instruction, signer: &Keypair) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm.send_transaction(tx).map(|m| m.logs).map_err(|e| format!("{:?}", e.err))
    }

    /// Point the helpers at another agent owned by the same operator.
    fn switch_agent(&mut self, agent_id: u64) {
        self.agent_id = agent_id;
        self.agent = Pubkey::find_program_address(
            &[AGENT_SEED, self.operator.pubkey().as_ref(), &agent_id.to_le_bytes()],
            &self.program_id,
        )
        .0;
        self.agent_vault =
            Pubkey::find_program_address(&[AGENT_VAULT_SEED, self.agent.as_ref()], &self.program_id).0;
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn set_time(&mut self, t: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = t;
        self.svm.set_sysvar(&clock);
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

    fn settle_accounts(&self, nonce: u64, signer: &Keypair) -> proof_of_agent::accounts::SettlePosition {
        let (position, position_vault) = self.position_pda(nonce);
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
    }

    fn settle_with(
        &mut self,
        accounts: proof_of_agent::accounts::SettlePosition,
        returned: u64,
        signer: &Keypair,
    ) -> Result<Vec<String>, String> {
        let ix = Instruction::new_with_bytes(
            self.program_id,
            &proof_of_agent::instruction::SettlePosition { returned }.data(),
            accounts.to_account_metas(None),
        );
        self.send_logs(ix, signer)
    }

    fn settle(&mut self, nonce: u64, returned: u64, signer: &Keypair) -> Result<(), String> {
        let accounts = self.settle_accounts(nonce, signer);
        self.settle_with(accounts, returned, signer).map(|_| ())
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

// ---------- audit fixes ----------

const E_TRADER: u32 = 6007;
const E_RATIO_DRAWDOWN: u32 = 6023;
/// Anchor's ConstraintSeeds.
const E_SEEDS: u32 = 2006;

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn has_event<E: Event>(logs: &[String], event: &E) -> bool {
    let needle = format!("Program data: {}", base64(&event.data()));
    logs.iter().any(|l| *l == needle)
}

fn has_event_prefix(logs: &[String], discriminator: &[u8]) -> bool {
    // The discriminator is 8 bytes; its first 6 map to exactly 8 base64 chars.
    let prefix = format!("Program data: {}", &base64(discriminator)[..8]);
    logs.iter().any(|l| l.starts_with(&prefix))
}

fn assert_counters(a: &Agent, open: u32, settled: u32, defaulted: u32, breaches: u32) {
    assert_eq!(
        (a.open_positions, a.settled_positions, a.defaulted_positions, a.breach_count),
        (open, settled, defaulted, breaches),
        "(open, settled, defaulted, breach_count)"
    );
}

#[test]
fn validate_rejects_ratio_plus_drawdown_above_100_percent() {
    let mut env = Env::new();
    assert_err(env.create(terms(6_000, 0, 5_000)), E_RATIO_DRAWDOWN);
    assert_err(env.create(terms(10_000, 0, 1)), E_RATIO_DRAWDOWN);
    assert_err(env.create(terms(5_001, 0, 5_000)), E_RATIO_DRAWDOWN);
    // Exactly 100% is allowed.
    env.create(terms(5_000, 2_500, 5_000)).unwrap();
    // Update enforces the bound too.
    let op = env.op();
    assert_err(env.update(terms(9_000, 0, 1_001), &op), E_RATIO_DRAWDOWN);
    env.update(terms(10_000, 0, 0), &op).unwrap();
    env.update(terms(9_000, 0, 1_000), &op).unwrap();

    // Pure-function view of the same bound.
    assert!(AgentTerms::ratio_and_drawdown_fit(5_000, 5_000));
    assert!(!AgentTerms::ratio_and_drawdown_fit(5_000, 5_001));
    assert!(AgentTerms::ratio_and_drawdown_fit(10_000, 0));
    assert!(!AgentTerms::ratio_and_drawdown_fit(u16::MAX, u16::MAX));
}

#[test]
fn open_position_refuses_legacy_terms_that_break_the_bound() {
    let mut env = Env::launched();
    // Simulate an agent published before the bound existed: rewrite its
    // stored terms in place (same size, same field order).
    let mut acc = env.svm.get_account(&env.agent).unwrap();
    let mut a = Agent::try_deserialize(&mut &acc.data[..]).unwrap();
    a.terms.collateral_ratio_bps = 6_000;
    a.terms.max_drawdown_bps = 5_000;
    let mut data = Vec::new();
    a.try_serialize(&mut data).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(env.agent, acc).unwrap();

    assert_err(env.open(0, SOL / 10, 3_600), E_RATIO_DRAWDOWN);
}

#[test]
fn settle_zero_after_draw_costs_the_full_bond_at_the_100_percent_boundary() {
    let mut env = Env::new();
    env.create(terms(5_000, 2_500, 5_000)).unwrap();
    env.deposit(2 * SOL).unwrap();
    env.publish().unwrap();
    let op = env.op();

    // Round principal.
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    let before = env.balance(&env.trader.pubkey());
    env.settle(0, 0, &op).unwrap();
    let p = env.position_state(0);
    assert_eq!(p.locked_collateral, 500_000_000);
    assert_eq!(p.slashed, p.locked_collateral);
    assert_eq!(p.breach, Breach::Drawdown);
    assert_eq!(env.balance(&env.trader.pubkey()) - before, 500_000_000 + env.rent_floor());

    // Odd principal: the bond rounds up and the tolerated loss rounds down,
    // so the slash still equals the whole bond.
    let principal = 1_000_000_001;
    env.open(1, principal, 3_600).unwrap();
    env.draw(1, &op).unwrap();
    env.settle(1, 0, &op).unwrap();
    let p = env.position_state(1);
    assert_eq!(p.locked_collateral, 500_000_001);
    assert_eq!(p.slashed, 500_000_001);

    let a = env.agent_state();
    assert_eq!(a.locked_collateral, 0);
    assert_eq!(a.slashed_total, 1_000_000_001);
    assert_eq!(a.total_collateral, 2 * SOL - 1_000_000_001);
}

#[test]
fn declining_an_open_position_refunds_without_counting_as_a_settle() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    let trader_before = env.balance(&env.trader.pubkey());
    let op_before = env.balance(&op.pubkey());

    let accounts = env.settle_accounts(0, &op);
    let (position, _) = env.position_pda(0);
    // `returned` is ignored on a decline; the executor sends nothing.
    let logs = env.settle_with(accounts, 5 * SOL, &op).unwrap();

    assert_eq!(env.balance(&env.trader.pubkey()) - trader_before, SOL + env.rent_floor());
    assert_eq!(op_before - env.balance(&op.pubkey()), TX_FEE);
    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Settled);
    assert_eq!(p.breach, Breach::None);
    assert_eq!(p.drawn_at, 0);
    assert_eq!(p.returned, SOL);
    assert_eq!((p.fee_paid, p.slashed), (0, 0));
    let a = env.agent_state();
    assert_eq!(a.locked_collateral, 0);
    assert_eq!(a.capital_managed, 0);
    assert_eq!(a.total_collateral, SOL);
    assert_counters(&a, 0, 0, 0, 0);
    assert!(has_event(
        &logs,
        &PositionDeclined { position, agent: env.agent, trader: env.trader.pubkey(), principal: SOL }
    ));

    // A normal settle does not emit PositionDeclined.
    env.open(1, SOL, 3_600).unwrap();
    env.draw(1, &op).unwrap();
    let accounts = env.settle_accounts(1, &op);
    let logs = env.settle_with(accounts, SOL, &op).unwrap();
    assert!(!has_event_prefix(&logs, PositionDeclined::DISCRIMINATOR));
    assert_counters(&env.agent_state(), 0, 1, 0, 0);
}

#[test]
fn draw_deadline_boundary_is_exact() {
    let mut env = Env::launched();
    let op = env.op();
    let t0 = env.now();
    env.open(0, SOL / 10, 3_600).unwrap();
    env.open(1, SOL / 10, 3_600).unwrap();
    let deadline = env.position_state(0).deadline;
    assert_eq!(deadline, t0 + 3_600);

    env.set_time(deadline - 1);
    env.draw(0, &op).unwrap();
    env.set_time(deadline);
    assert_err(env.draw(1, &op), E_DEADLINE_PASSED);
}

#[test]
fn claim_default_deadline_boundary_is_exact() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    let deadline = env.position_state(0).deadline;

    env.set_time(deadline - 1);
    assert_err(env.claim_default(0), E_NOT_REACHED);
    env.set_time(deadline);
    env.claim_default(0).unwrap();

    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Defaulted);
    assert_eq!(p.closed_at, deadline);
    let a = env.agent_state();
    assert_counters(&a, 0, 0, 1, 1);
    assert_eq!(a.locked_collateral, 0);
    assert_eq!(a.capital_managed, 0);
    assert_eq!(a.slashed_total, 300_000_000);
    assert_eq!(a.total_collateral, 700_000_000);
    assert_eq!(a.fees_earned, 0);
    // Claimed once only; the agent cannot settle afterwards either.
    assert_err(env.claim_default(0), E_STATUS);
    assert_err(env.settle(0, SOL, &op), E_STATUS);
}

#[test]
fn settling_late_before_the_trader_claims_records_a_missed_deadline() {
    let mut env = Env::launched();
    let op = env.op();

    // Settle one second before the deadline: clean.
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    let deadline = env.position_state(0).deadline;
    env.set_time(deadline - 1);
    env.settle(0, SOL, &op).unwrap();
    assert_eq!(env.position_state(0).breach, Breach::None);

    // Settle exactly at the deadline with a profit: paid normally, but a breach.
    env.open(1, SOL, 3_600).unwrap();
    env.draw(1, &op).unwrap();
    let deadline = env.position_state(1).deadline;
    env.set_time(deadline);
    let before = env.balance(&env.trader.pubkey());
    env.settle(1, 1_200_000_000, &op).unwrap();
    let p = env.position_state(1);
    assert_eq!(p.status, PositionStatus::Settled);
    assert_eq!(p.breach, Breach::MissedDeadline);
    assert_eq!(p.fee_paid, 30_000_000);
    assert_eq!(p.slashed, 0);
    assert_eq!(env.balance(&env.trader.pubkey()) - before, 1_170_000_000 + env.rent_floor());
    assert_counters(&env.agent_state(), 0, 2, 0, 1);
    // The trader can no longer claim a default on it.
    assert_err(env.claim_default(1), E_STATUS);

    // Settle long after the deadline with nothing returned: full bond, one breach.
    env.open(2, SOL, 3_600).unwrap();
    env.draw(2, &op).unwrap();
    env.advance_time(10 * 3_600);
    env.settle(2, 0, &op).unwrap();
    let p = env.position_state(2);
    assert_eq!(p.breach, Breach::MissedDeadline);
    assert_eq!(p.slashed, p.locked_collateral);
    let a = env.agent_state();
    assert_counters(&a, 0, 3, 0, 2);
    assert_eq!(a.slashed_total, 300_000_000);
    assert_eq!(a.locked_collateral, 0);
}

#[test]
fn cancel_updates_every_counter_correctly() {
    let mut env = Env::launched();
    env.open(0, SOL, 3_600).unwrap();
    env.open(1, SOL, 3_600).unwrap();
    assert_counters(&env.agent_state(), 2, 0, 0, 0);
    env.cancel(0).unwrap();
    let a = env.agent_state();
    assert_counters(&a, 1, 0, 0, 0);
    assert_eq!(a.locked_collateral, 300_000_000);
    assert_eq!(a.capital_managed, SOL);
    assert_eq!(a.total_collateral, SOL);
    assert_eq!((a.slashed_total, a.fees_earned), (0, 0));
    let p = env.position_state(0);
    assert_eq!(p.status, PositionStatus::Cancelled);
    assert_eq!(p.breach, Breach::None);
    // Once drawn, cancel is no longer possible.
    let op = env.op();
    env.draw(1, &op).unwrap();
    assert_err(env.cancel(1), E_STATUS);
}

#[test]
fn a_position_cannot_be_used_with_another_agent() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    let (pos_a, vault_a) = env.position_pda(0);
    let (agent_a, agent_vault_a) = (env.agent, env.agent_vault);

    // Agent B: same operator, another id, published and funded.
    env.switch_agent(8);
    env.create(terms(3_000, 1_500, 2_000)).unwrap();
    env.deposit(SOL).unwrap();
    env.publish().unwrap();
    let (agent_b, agent_vault_b) = (env.agent, env.agent_vault);
    assert_ne!(agent_a, agent_b);

    let draw_b = Instruction::new_with_bytes(
        env.program_id,
        &proof_of_agent::instruction::DrawFunds {}.data(),
        proof_of_agent::accounts::DrawFunds {
            executor: op.pubkey(),
            agent: agent_b,
            position: pos_a,
            position_vault: vault_a,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert_err(env.send(draw_b, &op), E_SEEDS);

    let cancel_b = Instruction::new_with_bytes(
        env.program_id,
        &proof_of_agent::instruction::CancelPosition {}.data(),
        proof_of_agent::accounts::CancelPosition {
            trader: env.trader.pubkey(),
            agent: agent_b,
            position: pos_a,
            position_vault: vault_a,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let trader = env.trader.insecure_clone();
    assert_err(env.send(cancel_b, &trader), E_SEEDS);

    // Draw it properly on A, then try to settle / claim it through B.
    env.switch_agent(7);
    env.draw(0, &op).unwrap();
    let mut accounts = env.settle_accounts(0, &op);
    accounts.agent = agent_b;
    accounts.agent_vault = agent_vault_b;
    assert_err(env.settle_with(accounts, 0, &op).map(|_| ()), E_SEEDS);
    // Agent A's vault with agent B's account also fails.
    let mut accounts = env.settle_accounts(0, &op);
    accounts.agent = agent_b;
    accounts.agent_vault = agent_vault_a;
    assert!(env.settle_with(accounts, 0, &op).is_err());

    env.advance_time(3_600);
    let claim_b = Instruction::new_with_bytes(
        env.program_id,
        &proof_of_agent::instruction::ClaimDefault {}.data(),
        proof_of_agent::accounts::ClaimDefault {
            trader: env.trader.pubkey(),
            agent: agent_b,
            agent_vault: agent_vault_b,
            position: pos_a,
            position_vault: vault_a,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert_err(env.send(claim_b, &trader), E_SEEDS);

    // Agent B is untouched and A's position is still claimable on A.
    env.switch_agent(8);
    let b = env.agent_state();
    assert_eq!((b.total_collateral, b.locked_collateral), (SOL, 0));
    assert_counters(&b, 0, 0, 0, 0);
    env.switch_agent(7);
    env.claim_default(0).unwrap();
}

#[test]
fn settle_rejects_a_wrong_trader_or_operator_recipient() {
    let mut env = Env::launched();
    let op = env.op();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();

    let mut accounts = env.settle_accounts(0, &op);
    accounts.trader = stranger.pubkey();
    assert_err(env.settle_with(accounts, 0, &op).map(|_| ()), E_TRADER);

    let mut accounts = env.settle_accounts(0, &op);
    accounts.operator = stranger.pubkey();
    assert_err(env.settle_with(accounts, 1_200_000_000, &op).map(|_| ()), E_OPERATOR);

    // Someone other than the trader cannot claim the default or cancel.
    env.advance_time(3_600);
    let (position, position_vault) = env.position_pda(0);
    let claim = Instruction::new_with_bytes(
        env.program_id,
        &proof_of_agent::instruction::ClaimDefault {}.data(),
        proof_of_agent::accounts::ClaimDefault {
            trader: stranger.pubkey(),
            agent: env.agent,
            agent_vault: env.agent_vault,
            position,
            position_vault,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(env.send(claim, &stranger).is_err());
    assert_eq!(env.position_state(0).status, PositionStatus::Trading);
    env.claim_default(0).unwrap();
}

#[test]
fn dust_profit_pays_no_fee() {
    // Pure function.
    let s = compute_settlement(SOL, SOL + 1, 1_500, 2_000, 300_000_000).unwrap();
    assert_eq!((s.fee, s.slash), (0, 0));
    let s = compute_settlement(1, 2, 5_000, 0, 1).unwrap();
    assert_eq!((s.fee, s.slash), (0, 0));

    // On chain.
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    env.draw(0, &op).unwrap();
    let before = env.balance(&env.trader.pubkey());
    env.settle(0, SOL + 1, &op).unwrap();
    let p = env.position_state(0);
    assert_eq!(p.fee_paid, 0);
    assert_eq!(p.returned, SOL + 1);
    assert_eq!(env.balance(&env.trader.pubkey()) - before, SOL + 1 + env.rent_floor());
    assert_eq!(env.agent_state().fees_earned, 0);
}

#[test]
fn draw_and_set_accepting_emit_events() {
    let mut env = Env::launched();
    let op = env.op();
    env.open(0, SOL, 3_600).unwrap();
    let (position, position_vault) = env.position_pda(0);
    let deadline = env.position_state(0).deadline;
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &proof_of_agent::instruction::DrawFunds {}.data(),
        proof_of_agent::accounts::DrawFunds {
            executor: op.pubkey(),
            agent: env.agent,
            position,
            position_vault,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let logs = env.send_logs(ix, &op).unwrap();
    assert!(has_event(
        &logs,
        &FundsDrawn {
            position,
            agent: env.agent,
            trader: env.trader.pubkey(),
            executor: op.pubkey(),
            principal: SOL,
            deadline,
        }
    ));

    for accepting in [false, true] {
        let ix = Instruction::new_with_bytes(
            env.program_id,
            &proof_of_agent::instruction::SetAccepting { accepting }.data(),
            proof_of_agent::accounts::SetAccepting { operator: op.pubkey(), agent: env.agent }
                .to_account_metas(None),
        );
        let logs = env.send_logs(ix, &op).unwrap();
        assert!(has_event(
            &logs,
            &AcceptingChanged { agent: env.agent, operator: op.pubkey(), accepting }
        ));
    }
}
