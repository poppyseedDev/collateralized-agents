use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Collateral ratio must be between MIN and MAX collateral ratio bps")]
    InvalidCollateralRatio,
    #[msg("Max drawdown exceeds the protocol limit")]
    InvalidDrawdown,
    #[msg("Name is empty or too long")]
    InvalidName,
    #[msg("Strategy description is too long")]
    InvalidStrategy,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Agent does not have enough free collateral to guarantee this position")]
    InsufficientFreeCollateral,
    #[msg("Only the agent authority may perform this action")]
    UnauthorizedAgent,
    #[msg("Only the position trader may perform this action")]
    UnauthorizedTrader,
    #[msg("Position is not in the expected status")]
    InvalidStatus,
    #[msg("Position duration is out of bounds")]
    InvalidDuration,
    #[msg("Position deadline has not been reached yet")]
    DeadlineNotReached,
    #[msg("Position deadline has passed; the trader may claim default")]
    DeadlinePassed,
    #[msg("Agent is not accepting new positions")]
    AgentPaused,
    #[msg("Arithmetic overflow")]
    Overflow,
}
