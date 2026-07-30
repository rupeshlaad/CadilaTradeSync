const stateStore = new Map<string, string>();

export function setTradingAccountId(
  sessionId: string,
  tradingAccountId: string,
) {
  stateStore.set(sessionId, tradingAccountId);
}

export function getTradingAccountId(sessionId: string) {
  return stateStore.get(sessionId);
}

export function clearTradingAccountId(sessionId: string) {
  stateStore.delete(sessionId);
}