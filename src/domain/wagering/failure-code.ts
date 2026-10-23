/** Stable, machine-readable reasons persisted on REJECTED and FAILED transactions. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotReversible = 'REFERENCE_KIND_NOT_REVERSIBLE',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ProcessingFailed = 'PROCESSING_FAILED',
}
