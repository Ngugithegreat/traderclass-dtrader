/**
 * Trade execution on wealthdbot's OWN engine (replaces Deriv buy/sell/proposal
 * for the DTrader). Ported from the bot's src/external/traderslink/trade.ts.
 * The DTrader still speaks Deriv's vocabulary (contract_type CALL/PUT/DIGIT*,
 * stake in dollars, duration + unit, barrier); this translates it into the
 * backend's /api/trade body and maps the response back. Market data stays on
 * Deriv's public feed — only money movements run here.
 */
/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { wbFetch } from './backend';

type BackendType = { kind: 'rise_fall' | 'mult' | 'digit'; direction: string; subtype?: string };
const TYPE_MAP: Record<string, BackendType> = {
    CALL: { kind: 'rise_fall', direction: 'rise' },
    PUT: { kind: 'rise_fall', direction: 'fall' },
    MULTUP: { kind: 'mult', direction: 'up' },
    MULTDOWN: { kind: 'mult', direction: 'down' },
    DIGITOVER: { kind: 'digit', direction: 'over', subtype: 'over_under' },
    DIGITUNDER: { kind: 'digit', direction: 'under', subtype: 'over_under' },
    DIGITMATCH: { kind: 'digit', direction: 'matches', subtype: 'matches_differs' },
    DIGITDIFF: { kind: 'digit', direction: 'differs', subtype: 'matches_differs' },
    DIGITEVEN: { kind: 'digit', direction: 'even', subtype: 'even_odd' },
    DIGITODD: { kind: 'digit', direction: 'odd', subtype: 'even_odd' },
};

/** Reverse of TYPE_MAP: a stored backend trade → its Deriv contract_type. */
export function derivContractType(trade: Record<string, any>): string {
    const kind = trade.kind;
    const dir = trade.direction;
    const sub = trade.subtype;
    if (kind === 'rise_fall') return dir === 'fall' ? 'PUT' : 'CALL';
    if (kind === 'mult') return dir === 'down' ? 'MULTDOWN' : 'MULTUP';
    if (sub === 'over_under') return dir === 'under' ? 'DIGITUNDER' : 'DIGITOVER';
    if (sub === 'matches_differs') return dir === 'differs' ? 'DIGITDIFF' : 'DIGITMATCH';
    if (sub === 'even_odd') return dir === 'odd' ? 'DIGITODD' : 'DIGITEVEN';
    return 'CALL';
}

/** Backend cents → major units. */
export const majorFromCents = (cents: unknown): number => Math.round(Number(cents || 0)) / 100;

const DURATIONS = [15, 30, 60, 120, 300]; // seconds
const MULTIPLIERS = [100, 200, 400, 1000];
const DIGIT_HOUSE_EDGE = 0.05;
const MIN_PAYOUT_MULT = 1.05;

export interface WbBuyParams {
    symbol: string;
    contract_type: string;
    amount: number; // stake, dollars
    currency?: string;
    duration?: number;
    duration_unit?: string;
    barrier?: string | number;
    barrier2?: string | number;
    multiplier?: number;
    growth_rate?: number;
}
export interface WbBuyResult {
    success: boolean;
    contract_id?: number;
    buy_price?: number;
    payout?: number;
    longcode?: string;
    transaction_id?: number;
    balance_after?: number;
    entry_spot?: number;
    entry_epoch?: number;
    expiry_epoch?: number;
    symbol?: string;
    error?: string;
    status?: number;
}
export interface WbSettlement {
    profit: number;
    exit_spot?: number;
    exit_epoch?: number;
    exit_digit?: number | null;
    status?: string;
}

const DECIMALS: Record<string, number> = {
    R_10: 3,
    R_25: 3,
    R_50: 4,
    R_75: 4,
    R_100: 2,
    '1HZ10V': 2,
    '1HZ25V': 2,
    '1HZ50V': 2,
    '1HZ75V': 2,
    '1HZ100V': 2,
};
export function decimalsFor(symbol: string): number {
    if (DECIMALS[symbol] != null) return DECIMALS[symbol];
    if (/^1HZ\d+V$/.test(symbol)) return 2;
    if (/^R_\d+$/.test(symbol)) return 3;
    if (/^JD\d+$/.test(symbol)) return 2;
    if (/^(BOOM|CRASH)\d+N?$/.test(symbol)) return 2;
    if (/^stpRNG\d*$/.test(symbol)) return 1;
    if (/^RB\d+$/.test(symbol)) return 3;
    if (symbol === 'RDBULL' || symbol === 'RDBEAR') return 4;
    return 2;
}
export function fmtSpot(price: number | null | undefined, symbol: string): string | undefined {
    if (price == null || !Number.isFinite(Number(price))) return undefined;
    return Number(price).toFixed(decimalsFor(symbol));
}

const nearest = (v: number, allowed: number[]) =>
    allowed.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), allowed[0]);
const toCents = (dollars: number) => Math.round(Number(dollars) * 100);
const toMajor = (cents: number) => Math.round(Number(cents || 0)) / 100;

function resolveSeconds(p: WbBuyParams): number {
    const n = Number(p.duration ?? 0);
    const unit = p.duration_unit || 't';
    let seconds: number;
    if (unit === 'm') seconds = n * 60;
    else if (unit === 's') seconds = n;
    else seconds = n * 2;
    return nearest(seconds || 60, DURATIONS);
}
function resolveTicks(p: WbBuyParams): number {
    const unit = p.duration_unit || 't';
    const n = unit === 't' ? Number(p.duration ?? 1) : 1;
    return Math.min(5, Math.max(1, Math.round(n || 1)));
}

export function toTradeBody(p: WbBuyParams): Record<string, any> {
    const t = TYPE_MAP[String(p.contract_type).toUpperCase()];
    if (!t) throw new Error(`Unsupported contract type: ${p.contract_type}`);

    let demo = true;
    try {
        demo = localStorage.getItem('tl_account_mode') !== 'real';
    } catch {
        /* default demo */
    }

    const body: Record<string, any> = {
        kind: t.kind,
        symbol: p.symbol,
        direction: t.direction,
        stake: toCents(p.amount),
        demo,
    };

    if (t.kind === 'rise_fall') {
        body.duration = resolveSeconds(p);
    } else if (t.kind === 'mult') {
        body.multiplier = nearest(Number(p.multiplier ?? MULTIPLIERS[0]), MULTIPLIERS);
    } else {
        body.subtype = t.subtype;
        body.ticks = resolveTicks(p);
        if (t.subtype === 'over_under') {
            let b = Math.round(Number(p.barrier ?? 5));
            b = t.direction === 'over' ? Math.min(8, Math.max(0, b)) : Math.min(9, Math.max(1, b));
            body.barrier = b;
        } else if (t.subtype === 'matches_differs') {
            body.barrier = Math.min(9, Math.max(0, Math.round(Number(p.barrier ?? 0))));
        }
    }
    return body;
}

export function describe(body: Record<string, any>): string {
    if (body.kind === 'rise_fall')
        return `${body.direction === 'rise' ? 'Rise' : 'Fall'} on ${body.symbol} (${body.duration}s)`;
    if (body.kind === 'mult') return `Multiplier ${body.direction} x${body.multiplier} on ${body.symbol}`;
    return `Digit ${body.direction}${body.barrier != null ? ` ${body.barrier}` : ''} on ${body.symbol} (${body.ticks} ticks)`;
}

export async function wbBuy(p: WbBuyParams): Promise<WbBuyResult> {
    let body: Record<string, any>;
    try {
        body = toTradeBody(p);
    } catch (e: any) {
        return { success: false, error: e?.message || 'Unsupported trade' };
    }
    try {
        const res = await wbFetch('/api/trade', { method: 'POST', body: JSON.stringify(body) });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok)
            return { success: false, error: json?.error || `Trade rejected (${res.status})`, status: res.status };
        const trade = json.trade || {};
        return {
            success: true,
            contract_id: trade.id,
            transaction_id: trade.id,
            buy_price: toMajor(trade.stake),
            payout: toMajor(trade.payout),
            balance_after: toMajor(json.balance),
            longcode: describe(body),
            entry_spot: trade.entry_price != null ? Number(trade.entry_price) : undefined,
            entry_epoch: trade.entry_epoch != null ? Number(trade.entry_epoch) : undefined,
            symbol: trade.symbol || body.symbol,
        };
    } catch (e: any) {
        return { success: false, error: e?.message || 'Could not reach Wealthdbot.', status: 0 };
    }
}

function payoutFromProb(prob: number, edge = DIGIT_HOUSE_EDGE) {
    const m = (1 / prob) * (1 - edge);
    return Math.max(MIN_PAYOUT_MULT, Math.round(m * 100) / 100);
}
function riseFallMult(edge = DIGIT_HOUSE_EDGE) {
    return Math.max(MIN_PAYOUT_MULT, Math.round(2 * (1 - edge) * 100) / 100);
}
function digitMult(subtype: string, direction: string, barrier: number) {
    let prob: number;
    if (subtype === 'even_odd') prob = 0.5;
    else if (subtype === 'matches_differs') prob = direction === 'matches' ? 0.1 : 0.9;
    else prob = direction === 'over' ? (9 - barrier) / 10 : barrier / 10;
    if (!prob || prob <= 0) return MIN_PAYOUT_MULT;
    return payoutFromProb(prob);
}

/** Estimate ask price + payout for the ticket, computed locally (no backend quote). */
export function wbQuote(p: WbBuyParams): { ask_price?: number; payout?: number; error?: string } {
    let body: Record<string, any>;
    try {
        body = toTradeBody(p);
    } catch (e: any) {
        return { error: e?.message || 'No quote' };
    }
    const stake = Number(p.amount);
    if (body.kind === 'rise_fall') return { ask_price: stake, payout: Math.round(stake * riseFallMult() * 100) / 100 };
    if (body.kind === 'mult') return { ask_price: stake };
    const mult = digitMult(body.subtype, body.direction, Number(body.barrier ?? 0));
    return { ask_price: stake, payout: Math.round(stake * mult * 100) / 100 };
}

export async function wbClose(
    id: number
): Promise<{ success: boolean; sold_for?: number; balance?: number; error?: string }> {
    for (const path of ['/api/trade/close', '/api/trade/settle']) {
        try {
            const res = await wbFetch(path, { method: 'POST', body: JSON.stringify({ id }) });
            const json: any = await res.json().catch(() => ({}));
            const trade = json?.trade;
            if (res.ok && trade && trade.status && trade.status !== 'open') {
                const soldFor = trade.status === 'won' ? toMajor(trade.payout) : 0;
                return {
                    success: true,
                    sold_for: soldFor,
                    balance: json.balance != null ? Number(json.balance) : undefined,
                };
            }
        } catch {
            /* try next */
        }
    }
    return { success: false, error: 'This trade can’t be closed yet — it settles automatically when it expires.' };
}

/** Poll until a trade settles; resolve with the settlement (profit in dollars). */
/* eslint-disable no-await-in-loop, no-restricted-syntax */
export async function wbWaitForSettlement(id: number, timeoutMs = 180000): Promise<WbSettlement | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await wbFetch('/api/trade/settle', { method: 'POST', body: JSON.stringify({ id }) });
            const json: any = await res.json().catch(() => ({}));
            const trade = json?.trade;
            if (res.ok && trade && trade.status && trade.status !== 'open') {
                const stake = toMajor(trade.stake);
                const payout = toMajor(trade.payout);
                return {
                    profit: trade.status === 'won' ? payout - stake : -stake,
                    exit_spot: trade.exit_price != null ? Number(trade.exit_price) : undefined,
                    exit_epoch: trade.expiry_epoch != null ? Number(trade.expiry_epoch) : undefined,
                    exit_digit: trade.exit_digit != null ? Number(trade.exit_digit) : null,
                    status: trade.status,
                };
            }
        } catch {
            /* keep polling */
        }
        await new Promise<void>(resolve => {
            setTimeout(resolve, 700);
        });
    }
    return null;
}
/* eslint-enable no-await-in-loop, no-restricted-syntax */
