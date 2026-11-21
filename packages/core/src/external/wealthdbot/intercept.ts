/**
 * Wealthdbot WS interceptor for the DTrader.
 *
 * Wraps the single DerivAPIBasic instance's `send` + `subscribe` so ACCOUNT/MONEY
 * messages are served from the wealthdbot backend while MARKET DATA (ticks,
 * active_symbols, ticks_history, contracts_for, time, …) still flows to Deriv's
 * public WebSocket.
 *
 * Unlike the bot (which funnels everything through onMessage), the DTrader's
 * stores consume proposal / proposal_open_contract / transaction / balance via
 * the SUBSCRIBE CALLBACK. So we keep a small registry of the callbacks the app
 * registers and invoke them directly when a trade happens.
 *
 *   proposal           → local price quote (no backend quote endpoint)
 *   buy                → POST /api/trade, then emit transaction(buy) + POC(open),
 *                        poll /api/trade/settle → POC(sold) + balance refresh
 *   sell               → POST /api/trade/close, emit POC(sold) + balance refresh
 *   balance            → inject from the wallet (also refreshed after each trade)
 *   portfolio/profit_table/statement → empty (Layer 3)
 */
import { getWbMode, wbBalanceMajor, wbWallet, type WbWallet } from './backend';
import { fmtSpot, wbBuy, wbClose, wbQuote, wbWaitForSettlement, type WbBuyParams, type WbSettlement } from './trade';

type AnyObj = Record<string, any>;
type Cb = (v: AnyObj) => void;
type GetSocket = () => WebSocket | null | undefined;

const nowSec = () => Math.floor(Date.now() / 1000);

const activeLoginId = (wallet: WbWallet): string => {
    try {
        const stored = localStorage.getItem('active_loginid');
        if (stored) return stored;
    } catch {
        /* noop */
    }
    const id = Number(wallet.user.id || 0);
    return (getWbMode() === 'real' ? 'ROT' : 'VRW') + String(90000000 + id);
};

/** Dispatch a Deriv-shaped message into the app's global onMessage pipeline. */
const inject = (getSocket: GetSocket, msg: AnyObj): void => {
    const sock = getSocket();
    if (!sock) return;
    try {
        sock.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
    } catch {
        /* ignore */
    }
};

const pushBalance = async (getSocket: GetSocket): Promise<void> => {
    const wallet = await wbWallet();
    if (!wallet) return;
    inject(getSocket, {
        msg_type: 'balance',
        echo_req: { balance: 1, subscribe: 1 },
        balance: {
            loginid: activeLoginId(wallet),
            balance: wbBalanceMajor(wallet),
            currency: 'USD',
            email: wallet.user.email || '',
            user_id: String(wallet.user.id || ''),
        },
    });
};

const fakeSub = (run?: (cb?: Cb) => void) => ({
    subscribe: (next?: Cb, _err?: Cb) => {
        try {
            run?.(next);
        } catch {
            /* ignore */
        }
        return { unsubscribe: () => {} };
    },
});

const requestType = (req: AnyObj): string => {
    if (!req || typeof req !== 'object') return '';
    if (req.balance !== undefined) return 'balance';
    if (req.proposal !== undefined) return 'proposal';
    if (req.proposal_open_contract !== undefined) return 'proposal_open_contract';
    if (req.buy !== undefined) return 'buy';
    if (req.sell !== undefined) return 'sell';
    if (req.portfolio !== undefined) return 'portfolio';
    if (req.transaction !== undefined) return 'transaction';
    if (req.profit_table !== undefined) return 'profit_table';
    if (req.statement !== undefined) return 'statement';
    return '';
};

const paramsFromProposal = (p: AnyObj): WbBuyParams => ({
    symbol: p.symbol || p.underlying_symbol,
    contract_type: p.contract_type,
    amount: Number(p.amount),
    currency: p.currency || 'USD',
    duration: p.duration,
    duration_unit: p.duration_unit,
    barrier: p.barrier,
    multiplier: p.multiplier,
});

/** Deriv-style shortcode so the purchase handler's extractInfoFromShortcode works. */
const buildShortcode = (params: WbBuyParams, res: AnyObj): string => {
    const ct = String(params.contract_type).toUpperCase();
    const sym = res.symbol || params.symbol;
    const payout = Math.round(Number(res.payout || 0) * 100) / 100;
    const start = res.entry_epoch || nowSec();
    const dur = Number(params.duration || 5);
    const unit = (params.duration_unit || 't').toUpperCase();
    return `${ct}_${sym}_${payout}_${start}_${dur}${unit}_S0P_0`;
};

function buildPoc(
    res: AnyObj,
    params: WbBuyParams,
    opts: { sold: boolean; profit?: number; settlement?: WbSettlement | null }
) {
    const buy_price = Number(res.buy_price);
    const profit = opts.profit ?? 0;
    const sell_price = opts.sold ? (profit >= 0 ? buy_price + profit : 0) : 0;
    const sym = res.symbol || params.symbol;
    const entrySpot = res.entry_spot != null ? Number(res.entry_spot) : undefined;
    const entryEpoch = res.entry_epoch != null ? Number(res.entry_epoch) : nowSec();
    const s = opts.settlement;
    const exitSpot = s?.exit_spot != null ? Number(s.exit_spot) : undefined;
    const exitEpoch = s?.exit_epoch != null ? Number(s.exit_epoch) : undefined;
    const poc: AnyObj = {
        contract_id: res.contract_id,
        transaction_ids: { buy: res.transaction_id, sell: opts.sold ? res.transaction_id : undefined },
        buy_price,
        sell_price: opts.sold ? sell_price : undefined,
        bid_price: opts.sold ? sell_price : buy_price,
        payout: Number(res.payout),
        profit: opts.sold ? profit : 0,
        profit_percentage: opts.sold && buy_price ? Math.round((profit / buy_price) * 10000) / 100 : 0,
        currency: 'USD',
        is_sold: opts.sold ? 1 : 0,
        is_expired: opts.sold ? 1 : 0,
        is_valid_to_sell: opts.sold ? 0 : 1,
        status: opts.sold ? (profit >= 0 ? 'won' : 'lost') : 'open',
        underlying: sym,
        display_name: sym,
        contract_type: String(params.contract_type).toUpperCase(),
        shortcode: buildShortcode(params, res),
        entry_tick: entrySpot,
        entry_spot: entrySpot,
        entry_tick_display_value: fmtSpot(entrySpot, sym),
        entry_tick_time: entryEpoch,
        entry_spot_time: entryEpoch,
        current_spot: opts.sold ? (exitSpot ?? entrySpot) : entrySpot,
        current_spot_display_value: fmtSpot(opts.sold ? (exitSpot ?? entrySpot) : entrySpot, sym),
        date_start: entryEpoch,
        longcode: res.longcode,
    };
    if (opts.sold) {
        poc.exit_tick = exitSpot;
        poc.exit_spot = exitSpot;
        poc.exit_tick_display_value = fmtSpot(exitSpot, sym);
        if (exitEpoch) {
            poc.exit_tick_time = exitEpoch;
            poc.exit_spot_time = exitEpoch;
            poc.date_expiry = exitEpoch;
        }
    }
    return poc;
}

export function installWbInterceptor(deriv_api: AnyObj, getSocket: GetSocket): void {
    if (!deriv_api || (deriv_api as AnyObj).__wb_wrapped) return;
    (deriv_api as AnyObj).__wb_wrapped = true;

    const origSubscribe = deriv_api.subscribe.bind(deriv_api);
    const origSend = deriv_api.send.bind(deriv_api);

    // Registry of the app's subscribe callbacks.
    const transactionCbs = new Set<Cb>();
    const pocAllCbs = new Set<Cb>();
    const pocByIdCbs = new Map<number, Set<Cb>>();
    const proposalParams = new Map<string, WbBuyParams>();
    const lastPoc = new Map<number, AnyObj>();
    let seq = 1;

    const emitTransaction = (tx: AnyObj) => {
        transactionCbs.forEach(cb => {
            try {
                cb({ msg_type: 'transaction', echo_req: { transaction: 1 }, transaction: tx });
            } catch {
                /* ignore */
            }
        });
    };
    const emitPoc = (poc: AnyObj) => {
        lastPoc.set(poc.contract_id, poc);
        const msg = {
            msg_type: 'proposal_open_contract',
            echo_req: { proposal_open_contract: 1, contract_id: poc.contract_id },
            proposal_open_contract: poc,
        };
        pocAllCbs.forEach(cb => {
            try {
                cb(msg);
            } catch {
                /* ignore */
            }
        });
        (pocByIdCbs.get(poc.contract_id) || new Set()).forEach(cb => {
            try {
                cb(msg);
            } catch {
                /* ignore */
            }
        });
    };

    deriv_api.subscribe = (request: AnyObj) => {
        switch (requestType(request)) {
            case 'balance':
                return fakeSub(() => {
                    pushBalance(getSocket).catch(() => {});
                });
            case 'proposal': {
                const params = paramsFromProposal(request);
                const q = wbQuote(params);
                const id = `wbp_${seq++}`;
                if (!q.error) proposalParams.set(id, params);
                return fakeSub(next => {
                    if (!next) return;
                    setTimeout(() => {
                        if (q.error) {
                            next({
                                echo_req: request,
                                msg_type: 'proposal',
                                req_id: request.req_id,
                                error: { code: 'ProposalError', message: q.error },
                            });
                            return;
                        }
                        const ask = q.ask_price ?? Number(request.amount);
                        next({
                            echo_req: request,
                            msg_type: 'proposal',
                            req_id: request.req_id,
                            subscription: request.subscribe ? { id } : undefined,
                            proposal: {
                                id,
                                ask_price: ask,
                                payout: q.payout ?? 0,
                                spot: 0,
                                spot_time: nowSec(),
                                date_start: nowSec(),
                                date_expiry:
                                    nowSec() +
                                    Number(params.duration || 5) *
                                        (params.duration_unit === 'm' ? 60 : params.duration_unit === 's' ? 1 : 2),
                                display_value: String(ask),
                                longcode: '',
                            },
                        });
                    }, 0);
                });
            }
            case 'transaction':
                return fakeSub(next => {
                    if (next) transactionCbs.add(next);
                });
            case 'proposal_open_contract': {
                const cid = request.contract_id ? Number(request.contract_id) : null;
                return fakeSub(next => {
                    if (!next) return;
                    if (cid) {
                        if (!pocByIdCbs.has(cid)) pocByIdCbs.set(cid, new Set());
                        pocByIdCbs.get(cid)!.add(next);
                        const known = lastPoc.get(cid);
                        if (known)
                            setTimeout(
                                () =>
                                    next({
                                        msg_type: 'proposal_open_contract',
                                        echo_req: request,
                                        proposal_open_contract: known,
                                    }),
                                0
                            );
                    } else {
                        pocAllCbs.add(next);
                    }
                });
            }
            default:
                return origSubscribe(request);
        }
    };

    deriv_api.send = (request: AnyObj) => {
        const type = requestType(request);
        switch (type) {
            case 'buy': {
                const params = request.parameters
                    ? paramsFromProposal(request.parameters)
                    : proposalParams.get(request.buy);
                if (!params) {
                    return Promise.resolve({
                        echo_req: request,
                        msg_type: 'buy',
                        error: { code: 'InvalidBuy', message: 'No trade parameters for buy.' },
                    });
                }
                const buyParams = params;
                return wbBuy(buyParams).then(res => {
                    if (!res.success) {
                        return {
                            echo_req: request,
                            msg_type: 'buy',
                            error: { code: 'BuyError', message: res.error || 'Trade rejected' },
                        };
                    }
                    // Position appears, then open POC, then settlement + balance refresh.
                    setTimeout(() => {
                        emitTransaction({
                            contract_id: res.contract_id,
                            action: 'buy',
                            longcode: res.longcode,
                            amount: res.buy_price,
                            balance: res.balance_after,
                        });
                        emitPoc(buildPoc(res, buyParams, { sold: false }));
                        pushBalance(getSocket).catch(() => {});
                    }, 20);
                    wbWaitForSettlement(res.contract_id!).then(settlement => {
                        emitPoc(buildPoc(res, buyParams, { sold: true, profit: settlement?.profit ?? 0, settlement }));
                        pushBalance(getSocket).catch(() => {});
                    });
                    return {
                        echo_req: request,
                        msg_type: 'buy',
                        buy: {
                            contract_id: res.contract_id,
                            transaction_id: res.transaction_id,
                            buy_price: res.buy_price,
                            payout: res.payout,
                            longcode: res.longcode,
                            balance_after: res.balance_after,
                            start_time: nowSec(),
                            purchase_time: nowSec(),
                            shortcode: buildShortcode(buyParams, res),
                        },
                    };
                });
            }
            case 'sell': {
                const contract_id = Number(request.sell);
                return wbClose(contract_id).then(r => {
                    if (!r.success) {
                        return {
                            echo_req: request,
                            msg_type: 'sell',
                            error: {
                                code: 'ContractNotSellable',
                                message: r.error || 'This contract can’t be sold yet.',
                            },
                        };
                    }
                    const poc = lastPoc.get(contract_id);
                    const sold_for = r.sold_for ?? (poc ? Number(poc.bid_price) : 0);
                    if (poc)
                        emitPoc({
                            ...poc,
                            is_sold: 1,
                            is_expired: 1,
                            status: poc.status === 'open' ? 'sold' : poc.status,
                            sell_price: sold_for,
                            bid_price: sold_for,
                        });
                    pushBalance(getSocket).catch(() => {});
                    return {
                        echo_req: request,
                        msg_type: 'sell',
                        sell: {
                            contract_id,
                            sold_for,
                            transaction_id: Date.now(),
                            balance_after: r.balance != null ? r.balance / 100 : undefined,
                        },
                    };
                });
            }
            case 'portfolio':
                return Promise.resolve({ echo_req: request, msg_type: 'portfolio', portfolio: { contracts: [] } });
            case 'profit_table':
                return Promise.resolve({
                    echo_req: request,
                    msg_type: 'profit_table',
                    profit_table: { transactions: [] },
                });
            case 'statement':
                return Promise.resolve({
                    echo_req: request,
                    msg_type: 'statement',
                    statement: { transactions: [], count: 0 },
                });
            default:
                return origSend(request);
        }
    };
}
