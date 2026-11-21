/**
 * Wealthdbot own-backend layer for the DTrader.
 *
 * The DTrader normally logs in via Deriv OAuth2-PKCE and trades on Deriv's
 * options API. When WB_OWN_BACKEND_API is set, we instead authenticate against
 * wealthdbot's OWN backend (traderslink) with email/password, keep the socket on
 * Deriv's PUBLIC market feed (ticks/active_symbols/charts), and route
 * account + balance + trades to the backend. This mirrors the bot's
 * src/external/traderslink layer, adapted to the DTrader's REST/WS architecture.
 *
 * Master switch: process.env.WB_OWN_BACKEND_API (the backend origin). When
 * empty/unset the whole layer is inert and the DTrader behaves exactly as the
 * stock Deriv build — so the other brands (TraderClass/dbtraders/…) are untouched.
 */

// Master switch. Set WB_OWN_BACKEND_API to enable the own-backend layer:
//  - an absolute URL (https://traderslink.site) → call the backend DIRECTLY
//    (requires CORS on the backend for this origin), or
//  - any non-URL value (e.g. "1" / "same-origin") → call SAME-ORIGIN relative
//    /api/* and let a proxy/rewrite forward it to the backend (no CORS needed).
//    Local dev uses the webpack devServer proxy; prod uses a Vercel rewrite.
const RAW = String(process.env.WB_OWN_BACKEND_API || '').trim();
const API = /^https?:\/\//i.test(RAW) ? RAW.replace(/\/$/, '') : '';
const TOKEN_KEY = 'tl_token';
const MODE_KEY = 'tl_account_mode'; // 'real' | anything else = demo

/** Is the own-backend layer active? */
export const isWb = (): boolean => !!RAW;

/** Backend origin ('' = same-origin relative /api/*). */
export const wbApi = (): string => API;

// Runtime bridge so other packages (e.g. @deriv/api, which cannot import core and
// may not get env vars inlined) can read the WB switch + base URL at runtime.
try {
    (globalThis as unknown as { __WB?: { on: boolean; api: string } }).__WB = { on: !!RAW, api: API };
} catch {
    /* non-browser */
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
export const getWbToken = (): string | null => {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
};
export const setWbToken = (t: string): void => {
    try {
        localStorage.setItem(TOKEN_KEY, t);
    } catch {
        /* storage blocked — session won't persist, still works this tab */
    }
};
export const clearWbToken = (): void => {
    try {
        localStorage.removeItem(TOKEN_KEY);
    } catch {
        /* noop */
    }
};
export const isWbLoggedIn = (): boolean => isWb() && !!getWbToken();

export const getWbMode = (): 'real' | 'demo' => {
    try {
        return localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'demo';
    } catch {
        return 'demo';
    }
};
export const setWbMode = (mode: 'real' | 'demo'): void => {
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        /* noop */
    }
};

// ---------------------------------------------------------------------------
// Authenticated fetch (Bearer token + timeout)
// ---------------------------------------------------------------------------
export async function wbFetch(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
    const token = getWbToken();
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store', signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Auth endpoints (mirror the backend contract used by the bot)
// ---------------------------------------------------------------------------
export async function wbLogin(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch(`${API}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: String(email).trim(), password }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok && json?.token) {
            setWbToken(json.token);
            return { ok: true };
        }
        return { ok: false, error: json?.error || 'Invalid email or password.' };
    } catch (e: any) {
        return { ok: false, error: e?.message || 'Could not reach Wealthdbot. Check your connection.' };
    }
}

export type WbSignupFields = {
    name: string;
    email: string;
    password: string;
    country?: string;
    phone?: string;
    code?: string;
};

export async function wbRegister(fields: WbSignupFields): Promise<{ ok: boolean; error?: string; needOtp?: boolean }> {
    try {
        const res = await fetch(`${API}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: String(fields.name).trim(),
                email: String(fields.email).trim(),
                password: fields.password,
                country: fields.country,
                phone: fields.phone,
                code: fields.code,
            }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok && json?.token) {
            setWbToken(json.token);
            return { ok: true };
        }
        return { ok: false, error: json?.error || 'Could not create your account.', needOtp: !!json?.needOtp };
    } catch (e: any) {
        return { ok: false, error: e?.message || 'Could not reach Wealthdbot.' };
    }
}

export async function wbSendSignupOtp(fields: {
    email: string;
    country?: string;
    phone?: string;
}): Promise<{ ok: boolean; required?: boolean; phone?: string; error?: string }> {
    try {
        const res = await fetch(`${API}/api/auth/otp/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ country: fields.country, phone: fields.phone, email: String(fields.email).trim() }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok && json?.ok) return { ok: true, required: !!json.required, phone: json.phone };
        return { ok: false, error: json?.error || 'Could not send the code.' };
    } catch (e: any) {
        return { ok: false, error: e?.message || 'Could not reach Wealthdbot.' };
    }
}

export async function wbForgot(email: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    try {
        const res = await fetch(`${API}/api/auth/forgot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: String(email).trim() }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok) return { ok: true, message: json?.message };
        return { ok: false, error: json?.error || 'Could not send the reset email.' };
    } catch (e: any) {
        return { ok: false, error: e?.message || 'Could not reach Wealthdbot.' };
    }
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
export type WbUser = { id: number; name: string; email: string; balance: number; demo_balance?: number };
export type WbWallet = { user: WbUser } & Record<string, any>;

export async function wbWallet(): Promise<WbWallet | null> {
    if (!getWbToken()) return null;
    try {
        const res = await wbFetch('/api/wallet');
        if (!res.ok) return null;
        return (await res.json()) as WbWallet;
    } catch {
        return null;
    }
}

export async function wbLogout(): Promise<void> {
    try {
        await wbFetch('/api/auth/logout', { method: 'POST' });
    } catch {
        /* ignore */
    }
    clearWbToken();
    try {
        ['active_loginid', 'account_type', 'accountsList', 'clientAccounts'].forEach(k => localStorage.removeItem(k));
        sessionStorage.removeItem('auth_info');
        sessionStorage.removeItem('active_loginid');
    } catch {
        /* noop */
    }
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------
/** Backend balance is whole cents; the UI works in major USD units. */
export const centsToMajor = (cents: number): number => Math.round(Number(cents || 0)) / 100;

/** A Deriv-style loginid for a wealthdbot account (matches the live site: ROT9…). */
export const wbLoginId = (userId: number): string => `ROT${String(90000000 + Number(userId || 0))}`;

/** Current balance (in major USD) for the active demo/real mode. */
export const wbBalanceMajor = (wallet: WbWallet): number => {
    const isDemo = getWbMode() !== 'real';
    const cents = isDemo ? Number(wallet.user.demo_balance ?? 0) : Number(wallet.user.balance ?? 0);
    return centsToMajor(cents);
};
