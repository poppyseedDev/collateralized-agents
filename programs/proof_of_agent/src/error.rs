use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Collateral ratio must be between the protocol minimum and maximum")]
    InvalidCollateralRatio,
    #[msg("Max drawdown exceeds the protocol limit")]
    InvalidDrawdown,
    #[msg("Name is empty or too long")]
    InvalidName,
    #[msg("Description is too long")]
    InvalidDescription,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Agent does not have enough free collateral to guarantee this position")]
    InsufficientFreeCollateral,
    #[msg("Only the agent operator may perform this action")]
    UnauthorizedOperator,
    #[msg("Only the position trader may perform this action")]
    UnauthorizedTrader,
    #[msg("Position is not in the expected status")]
    InvalidStatus,
    #[msg("Position duration is outside the agent's published trading window")]
    InvalidDuration,
    #[msg("Position deadline has not been reached yet")]
    DeadlineNotReached,
    #[msg("Position deadline has passed; the trader may claim default")]
    DeadlinePassed,
    #[msg("Agent is not accepting new positions")]
    AgentNotAccepting,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Fee exceeds the cap allowed by the collateral ratio")]
    FeeTooHigh,
    #[msg("Trading window is invalid")]
    InvalidTradingWindow,
    #[msg("Allowed assets must list between one and eight unique mints")]
    InvalidAllowedAssets,
    #[msg("Rules must be published and fit the size limit")]
    InvalidRules,
    #[msg("Terms can only be changed while the agent is a draft")]
    TermsLocked,
    #[msg("Agent has not been published")]
    NotPublished,
    #[msg("Agent is already published")]
    AlreadyPublished,
    #[msg("Deposit collateral before publishing the agent")]
    NoCollateral,
    #[msg("Signer is neither the agent's operator nor its bound trading key")]
    UnauthorizedExecutor,
}
