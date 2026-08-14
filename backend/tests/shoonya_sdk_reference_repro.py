"""
Faithful reproduction of the official NorenRestApiPy 0.0.37 OAuth SDK request
for the IDENTICAL order (BUY / NSE / TATASTEEL-EQ / MIS / MARKET / qty 1).

Lines replicated verbatim from the installed package:
  NorenApi.injectOAuthHeader()  (lines 250-254)  -> headers
  NorenApi.place_order()        (lines 577-617)  -> values / payload / post
Host for the OAuth wrapper (Shoonya_API_OAuth): 'https://api.shoonya.com/NorenWClientAPI/'
route 'placeorder' = '/PlaceOrder'  (line 74)
"""
import json
import urllib.parse

HOST = "https://api.shoonya.com/NorenWClientAPI/"
ROUTE_PLACEORDER = "/PlaceOrder"

access_token = "ACCESS_TOKEN_DEMO"
UID = "FA12345"
AID = "FA12345"

# injectOAuthHeader (lines 251-254)
headers = {
    "Authorization": f"Bearer {access_token}",
    "Content-Type": "application/json; charset=utf-8",
}

# place_order arguments for our order (mirrors example_market.py defaults):
buy_or_sell   = "B"        # BUY
product_type  = "I"        # MIS
exchange      = "NSE"
tradingsymbol = "TATASTEEL-EQ"
quantity      = 1
discloseqty   = 0
price_type    = "MKT"      # MARKET
price         = 0.0
trigger_price = None
retention     = "DAY"
amo           = None       # default -> field omitted
remarks       = None       # example_market passes remarks='some remarks'; default None
algo_id       = None

# place_order body (lines 577-613)
values = {"ordersource": "API"}
values["uid"]      = UID
values["actid"]    = AID
values["trantype"] = buy_or_sell
values["prd"]      = product_type
values["exch"]     = exchange
values["tsym"]     = urllib.parse.quote_plus(tradingsymbol)
values["qty"]      = str(quantity)
values["dscqty"]   = str(discloseqty)
values["prctyp"]   = price_type
values["prc"]      = str(price)
values["trgprc"]   = str(trigger_price)
values["ret"]      = retention
values["remarks"]  = remarks
values["algo_id"]  = algo_id
if amo is not None:
    values["amo"] = amo

payload = "jData=" + json.dumps(values)   # NOTE: NO &jKey= in the OAuth SDK
url = f"{HOST}{ROUTE_PLACEORDER}"

print("================ OFFICIAL OAuth SDK REQUEST ================")
print("METHOD  : POST")
print("URL     :", url)
print("HEADERS :", json.dumps(headers, indent=2))
print("BODY    :", payload)
print("===========================================================")
