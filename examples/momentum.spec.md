# Momentum Degen

venue: hyperliquid
pairs: BTC, SOL, HYPE
timeframe: 5m
max_position: 5%
stop_loss: 3%
leverage: 3x
cash: 1000

rules:
- long when the 20 period average crosses above the 50
- close anything down 3%
- flat before funding
