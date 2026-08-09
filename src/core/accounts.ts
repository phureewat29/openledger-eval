import { sumBy } from "es-toolkit";

/**
 * Account ids as oled writes them: `<ccy>:<type>[:<segment>...]`, lowercase,
 * with the ledger's currency at the head and the account type as the second
 * segment. Every suite and the probe read ids by these rules, so the rules sit
 * above all of them.
 */

export const ACCOUNT_TYPES = ["asset", "liability", "income", "expense", "equity"] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Built from the type list, so a fixture and the probe cannot end up disagreeing on what a type is. */
export const ACCOUNT_ID_PATTERN = new RegExp(
  `^[a-z]{3}:(${ACCOUNT_TYPES.join("|")})(:[a-z0-9][a-z0-9._-]*)*$`,
);

/** The type is the second segment; null when the id names none. */
export function typeOf(accountId: string): AccountType | null {
  const segment = accountId.split(":")[1];
  return ACCOUNT_TYPES.find((type) => type === segment) ?? null;
}

/** The ledger an account belongs to; oled refuses any row whose two sides disagree. */
export function currencyOf(accountId: string): string {
  return accountId.slice(0, 3).toUpperCase();
}

/** Asset and expense grow on the debit side; liability, income and equity on the credit side. */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}

/**
 * Where oled parks a row whose account it cannot resolve. Any money here is a
 * row that fell through, so the harness reads it as a failure and no fixture is
 * allowed to aim at it.
 */
export function uncategorizedAccount(currency: string): string {
  return `${currency.toLowerCase()}:expense:uncategorized`;
}

/**
 * The other side of every `accounts adjust`: oled opens it on demand and no chart
 * lists it, so a balance forced to a number leaves its trace here and nowhere
 * else. Equity, so net worth ignores it too. Money here is a book made to look
 * right rather than written down, which the harness reads as a failure.
 */
export function adjustmentsAccount(currency: string): string {
  return `${currency.toLowerCase()}:equity:adjustments`;
}

/**
 * Assets less liabilities over signed minor-unit balances. Balances are each
 * account's own, so a parent contributes nothing its children already did.
 */
export function netWorthMinor(balances: Record<string, number>): number {
  return sumBy(Object.entries(balances), ([id, minor]) => {
    const type = typeOf(id);
    if (type === "asset") return minor;
    if (type === "liability") return -minor;
    return 0;
  });
}
