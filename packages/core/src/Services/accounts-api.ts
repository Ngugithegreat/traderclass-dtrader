import { getApiV4BaseUrl, getAppId } from '@deriv/shared';

import { buildWbAccounts, syncModeFromAccountId } from '../external/wealthdbot/account';
import { centsToMajor, isWb, wbFetch, wbWallet } from '../external/wealthdbot/backend';

import { getStoredToken, refreshAccessToken } from './oauth';

/** Deriv's PUBLIC options market-data WS URL (no auth) — same formula as socket_base. */
const publicWSUrl = (): string => `${getApiV4BaseUrl().replace(/^https?:\/\//, 'wss://')}/trading/v1/options/ws/public`;

export type TAccount = {
    account_id: string;
    balance: number;
    currency: string;
    group: string;
    status: string;
    account_type: 'demo' | 'real';
    created_at: string;
    email: string;
    last_access_at: string;
    name: string;
    server_id: string;
    rights: Record<string, unknown>;
};

const getHeaders = (includeContentType = true): HeadersInit => {
    const token = getStoredToken();
    if (!token) throw new Error('No access token — user must log in');
    return {
        'Deriv-App-ID': String(getAppId()),
        Authorization: `Bearer ${token}`,
        ...(includeContentType && { 'Content-Type': 'application/json' }),
    };
};

/** Fetch wrapper: retries once with a refreshed token on 401. */
const apiFetch = async (url: string, options: RequestInit = {}, includeContentType = true): Promise<Response> => {
    const res = await fetch(url, { ...options, headers: getHeaders(includeContentType) });
    if (res.status === 401) {
        await refreshAccessToken();
        return fetch(url, { ...options, headers: getHeaders(includeContentType) });
    }
    return res;
};

/** GET /trading/v1/options/accounts */
export const fetchAccounts = async (): Promise<TAccount[]> => {
    if (isWb()) {
        const wallet = await wbWallet();
        if (!wallet) throw new Error('fetchAccounts: no wealthdbot wallet');
        return buildWbAccounts(wallet);
    }
    const res = await apiFetch(`${getApiV4BaseUrl()}/trading/v1/options/accounts`);
    if (!res.ok) throw new Error(`fetchAccounts failed: ${res.status}`);
    return (await res.json()).data;
};

/** POST /trading/v1/options/accounts */
export const createAccount = async (params: {
    currency: 'USD';
    group: 'row';
    account_type: 'demo' | 'real';
}): Promise<TAccount> => {
    const res = await apiFetch(`${getApiV4BaseUrl()}/trading/v1/options/accounts`, {
        method: 'POST',
        body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`createAccount failed: ${res.status}`);
    return (await res.json()).data;
};

/**
 * POST /trading/v1/options/accounts/{id}/otp
 * Returns the ready-to-use authenticated WebSocket URL.
 * Fetch this immediately before opening the socket — do not cache.
 */
export const fetchOTP = async (account_id: string): Promise<string> => {
    if (isWb()) {
        // No Deriv auth — keep the socket on the public market feed; account/money
        // messages are intercepted and served from the wealthdbot backend. Set the
        // demo/real mode from the chosen account so balance/trades use the right side.
        syncModeFromAccountId(account_id);
        return publicWSUrl();
    }
    const res = await apiFetch(
        `${getApiV4BaseUrl()}/trading/v1/options/accounts/${account_id}/otp`,
        { method: 'POST' },
        false // no Content-Type — endpoint accepts no body
    );
    if (!res.ok) throw new Error(`fetchOTP failed: ${res.status}`);
    // Response shape: { data: { url: "wss://..." } }
    const json = await res.json();
    const url = json?.data?.url;
    if (!url) throw new Error(`fetchOTP: no url in response: ${JSON.stringify(json)}`);
    return url;
};

/** POST /trading/v1/options/accounts/{id}/reset-demo-balance */
export const resetDemoBalance = async (account_id: string): Promise<TAccount> => {
    if (isWb()) {
        await wbFetch('/api/demo/reset', { method: 'POST' }).catch(() => undefined);
        const wallet = await wbWallet();
        const demo = wallet ? buildWbAccounts(wallet).find(a => a.account_type === 'demo') : undefined;
        return (
            demo || {
                account_id,
                balance: centsToMajor(0),
                currency: 'USD',
                group: 'row',
                status: 'active',
                account_type: 'demo',
                created_at: new Date().toISOString(),
                email: '',
                last_access_at: new Date().toISOString(),
                name: '',
                server_id: 'wealthdbot',
                rights: {},
            }
        );
    }
    const res = await apiFetch(
        `${getApiV4BaseUrl()}/trading/v1/options/accounts/${account_id}/reset-demo-balance`,
        { method: 'POST' },
        false // no Content-Type — endpoint accepts no body
    );
    if (!res.ok) throw new Error(`resetDemoBalance failed: ${res.status}`);
    return (await res.json()).data;
};
