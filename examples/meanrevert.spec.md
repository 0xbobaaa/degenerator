# Mean Revert Degen

venue: dydx
pairs: ETH, ARB
stop_loss: 2%
cash: 2500

author: bob
notes: paper only until the funding math is checked by someone else

rules:
- fade anything more than two standard deviations from the 20 period mean
- never hold through a funding print
- flatten the book at 03:00 utc
