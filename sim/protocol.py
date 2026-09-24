"""A faithful port of the on-chain settlement maths.

Mirrors programs/proof_of_agent/src/instructions/settle_position.rs
(compute_settlement) and open_position.rs (required_collateral).
Everything is denominated in SOL, exactly as the program is.
"""

from dataclasses import dataclass

BPS = 10_000

# Bounds the program enforces (constants.rs).
MIN_COLLATERAL_RATIO_BPS = 1_000
MAX_COLLATERAL_RATIO_BPS = 10_000
MAX_DRAWDOWN_BPS = 5_000
FEE_CAP_DIVISOR = 2


def max_fee_bps(collateral_ratio_bps: int) -> int:
    """An agent may charge at most ratio/2 of profit."""
    return collateral_ratio_bps // FEE_CAP_DIVISOR


def required_collateral(principal: float, ratio_bps: int) -> float:
    """Collateral locked for a position (the program rounds up; irrelevant here)."""
    return principal * ratio_bps / BPS


@dataclass
class Settlement:
    principal: float
    returned: float
    locked: float
    fee: float
    slash: float
    breached: bool

    @property
    def trader_payout(self) -> float:
        return self.returned - self.fee + self.slash

    @property
    def trader_return(self) -> float:
        """Trader's SOL return over the position, as a fraction of principal."""
        return self.trader_payout / self.principal - 1.0

    @property
    def operator_pnl(self) -> float:
        return self.fee - self.slash


def settle(principal: float, returned: float, fee_bps: int,
           max_drawdown_bps: int, locked: float) -> Settlement:
    if returned >= principal:
        profit = returned - principal
        fee = profit * fee_bps / BPS
        slash = 0.0
    else:
        loss = principal - returned
        allowed = principal * max_drawdown_bps / BPS
        shortfall = max(0.0, loss - allowed)
        fee = 0.0
        slash = min(shortfall, locked)
    return Settlement(principal, returned, locked, fee, slash, slash > 0)


def default(principal: float, locked: float) -> Settlement:
    """Operator drew the funds and never came back (claim_default.rs).

    The trader recovers only the locked bond, not the principal.
    """
    return Settlement(principal, 0.0, locked, 0.0, locked, True)
