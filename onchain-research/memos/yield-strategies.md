# Yield strategies — stable sleeve

Our $8.7M USDC sleeve is laddered across three sources. Target blended
yield: **5.8% net of fees**. Risk-bucketed below.

## 1. T-bill backed (45% of sleeve)

USDC parked in tokenized t-bill products from regulated issuers.
Boring on purpose. Currently yielding ~5.1%.

## 2. Onchain lending (35% of sleeve)

Supplied to blue-chip lending markets on Ethereum mainnet. Variable
rate, currently 6.4% net. We cap any single market at $1.5M.

## 3. Liquidity provision (20% of sleeve)

Concentrated stable-stable pairs on Base (cheap fees, fast rebalance).
Targeting 7-9% but accepting the impermanent-loss tail. Auto-compound
into USDC weekly.

## What we don't touch

- Looped/recursive leverage strategies. Liquidation cascade risk is
  not worth the extra ~3% APR.
- Algorithmic stablecoins. Always.
