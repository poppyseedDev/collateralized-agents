//! Property-style checks of the pure settlement maths, driven by a seeded
//! PRNG (no proptest dependency is available offline).

mod common;

use {
    common::*,
    proof_of_agent::instructions::{compute_settlement, required_collateral},
};

const CASES: usize = 50_000;

/// Random terms that `AgentTerms::validate` would accept.
struct Case {
    principal: u64,
    ratio: u16,
    fee: u16,
    drawdown: u16,
    locked: u64,
}

fn random_case(rng: &mut Rng) -> Case {
    let ratio = rng.range(MIN_COLLATERAL_RATIO_BPS as u64, MAX_COLLATERAL_RATIO_BPS as u64) as u16;
    let fee = rng.range(0, AgentTerms::max_fee_bps(ratio) as u64) as u16;
    let max_dd = (MAX_DRAWDOWN_BPS as u64).min(BPS_DENOMINATOR - ratio as u64);
    let drawdown = rng.range(0, max_dd) as u16;
    // Mix dust, everyday and near-u64::MAX principals.
    let principal = match rng.range(0, 3) {
        0 => rng.range(1, 100),
        1 => rng.range(1, 1_000 * SOL),
        2 => rng.range(u64::MAX / 2, u64::MAX),
        _ => rng.next_u64().max(1) >> rng.range(0, 63),
    };
    let locked = required_collateral(principal, ratio).unwrap();
    assert!(AgentTerms::ratio_and_drawdown_fit(ratio, drawdown));
    Case { principal, ratio, fee, drawdown, locked }
}

fn random_returned(rng: &mut Rng, principal: u64) -> u64 {
    match rng.range(0, 5) {
        0 => 0,
        1 => principal,
        2 => rng.range(0, principal),
        3 => rng.range(principal, principal.saturating_mul(2)),
        4 => principal.saturating_sub(rng.range(0, 3)),
        _ => rng.next_u64(),
    }
}

fn settle(c: &Case, returned: u64) -> (u64, u64) {
    let s = compute_settlement(c.principal, returned, c.fee, c.drawdown, c.locked)
        .unwrap_or_else(|_| panic!("overflow: p={} r={returned}", c.principal));
    (s.fee, s.slash)
}

#[test]
fn slash_never_exceeds_the_lock() {
    let mut rng = Rng::new(1);
    for _ in 0..CASES {
        let c = random_case(&mut rng);
        let returned = random_returned(&mut rng, c.principal);
        let (_, slash) = settle(&c, returned);
        assert!(slash <= c.locked, "slash {slash} > locked {} (p={} r={returned})", c.locked, c.principal);
        // Also holds for an arbitrary lock, even one smaller than the ratio implies.
        let lock = rng.range(0, c.locked);
        let s = compute_settlement(c.principal, returned, c.fee, c.drawdown, lock).unwrap();
        assert!(s.slash <= lock);
    }
}

#[test]
fn fee_never_exceeds_the_profit_and_losses_pay_no_fee() {
    let mut rng = Rng::new(2);
    for _ in 0..CASES {
        let c = random_case(&mut rng);
        let returned = random_returned(&mut rng, c.principal);
        let (fee, slash) = settle(&c, returned);
        if returned >= c.principal {
            let profit = returned - c.principal;
            assert!(fee <= profit, "fee {fee} > profit {profit}");
            // The cap is half the ratio, so at most 50% of profit.
            assert!(fee as u128 * 2 <= profit as u128);
            assert_eq!(fee as u128, profit as u128 * c.fee as u128 / 10_000);
            assert_eq!(slash, 0, "a profit never slashes");
        } else {
            assert_eq!(fee, 0, "a loss never pays a fee");
        }
    }
}

#[test]
fn slash_matches_the_reference_formula() {
    let mut rng = Rng::new(3);
    for _ in 0..CASES {
        let c = random_case(&mut rng);
        let returned = random_returned(&mut rng, c.principal);
        let (_, slash) = settle(&c, returned);
        let loss = c.principal.saturating_sub(returned) as u128;
        let tolerated = c.principal as u128 * c.drawdown as u128 / 10_000;
        let expected = loss.saturating_sub(tolerated).min(c.locked as u128) as u64;
        assert_eq!(slash, expected);
        // A loss inside the tolerance is never slashed.
        if loss <= tolerated {
            assert_eq!(slash, 0);
        }
    }
}

#[test]
fn returning_nothing_slashes_the_whole_lock_when_ratio_plus_drawdown_fit() {
    let mut rng = Rng::new(4);
    for _ in 0..CASES {
        let c = random_case(&mut rng);
        let (fee, slash) = settle(&c, 0);
        assert_eq!(fee, 0);
        assert_eq!(
            slash, c.locked,
            "p={} ratio={} dd={}: walking away must cost the whole bond",
            c.principal, c.ratio, c.drawdown
        );
    }
    // Exhaustive over small principals at the 100% boundary, where rounding bites.
    for ratio in [1_000u16, 3_333, 5_000, 6_667, 9_999, 10_000] {
        let drawdown = (MAX_DRAWDOWN_BPS as u64).min(BPS_DENOMINATOR - ratio as u64) as u16;
        for principal in 1..=20_000u64 {
            let locked = required_collateral(principal, ratio).unwrap();
            let s = compute_settlement(principal, 0, 0, drawdown, locked).unwrap();
            assert_eq!(s.slash, locked, "p={principal} ratio={ratio} dd={drawdown}");
        }
    }
}

#[test]
fn settlement_is_monotonic_in_returned() {
    let mut rng = Rng::new(5);
    for _ in 0..CASES / 5 {
        let c = random_case(&mut rng);
        let mut rs: Vec<u64> = (0..8).map(|_| random_returned(&mut rng, c.principal)).collect();
        rs.extend([0, c.principal.saturating_sub(1), c.principal, c.principal.saturating_add(1)]);
        rs.sort_unstable();
        let mut prev: Option<(u64, u64, u128)> = None;
        for r in rs {
            let (fee, slash) = settle(&c, r);
            // What the trader walks away with (excluding rent).
            let payout = r as u128 - fee as u128 + slash as u128;
            if let Some((pf, ps, pp)) = prev {
                assert!(fee >= pf, "fee decreased as returned grew (r={r})");
                assert!(slash <= ps, "slash increased as returned grew (r={r})");
                assert!(payout >= pp, "trader payout decreased as returned grew (r={r})");
            }
            prev = Some((fee, slash, payout));
        }
    }
}

#[test]
fn trader_is_made_whole_up_to_the_tolerance_while_the_bond_lasts() {
    let mut rng = Rng::new(6);
    for _ in 0..CASES {
        let c = random_case(&mut rng);
        let returned = rng.range(0, c.principal);
        let (_, slash) = settle(&c, returned);
        let floor = c.principal - (c.principal as u128 * c.drawdown as u128 / 10_000) as u64;
        let payout = returned as u128 + slash as u128;
        if slash < c.locked {
            // Bond not exhausted: the trader gets at least principal minus tolerance.
            assert!(payout >= floor as u128, "p={} r={returned}", c.principal);
        }
        assert!(payout <= c.principal.max(floor) as u128);
    }
}

#[test]
fn extreme_inputs_do_not_overflow() {
    for (p, r, fee, dd, locked) in [
        (u64::MAX, u64::MAX, 5_000u16, 5_000u16, u64::MAX),
        (u64::MAX, 0, 5_000, 5_000, u64::MAX),
        (1, u64::MAX, 5_000, 0, 1),
        (u64::MAX, 0, 0, 0, u64::MAX),
    ] {
        compute_settlement(p, r, fee, dd, locked).unwrap();
    }
    // Bps above 100% (never accepted by `validate`) can push an intermediate
    // past u64; that surfaces as an error instead of wrapping.
    assert!(compute_settlement(u64::MAX, 0, 0, u16::MAX, u64::MAX).is_err());
    assert!(compute_settlement(1, u64::MAX, u16::MAX, 0, 0).is_err());
    let s = compute_settlement(1, u64::MAX, 5_000, 0, 1).unwrap();
    assert_eq!(s.fee, (u64::MAX - 1) / 2);
    let s = compute_settlement(u64::MAX, 0, 0, 0, u64::MAX).unwrap();
    assert_eq!(s.slash, u64::MAX);
}
