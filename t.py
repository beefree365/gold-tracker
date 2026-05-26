import yfinance as yf

gold = yf.download(
    "GC=F",
    interval="1m",
    period="5d"
)

print(gold)