/**
 * Embed auth bridge (white-label addition — not part of upstream dtrader-template).
 *
 * Lets a trusted parent site that iframes this DTrader hand over the Deriv OAuth token
 * of its already-signed-in user, so the user doesn't log in twice.
 *
 * Trust model
 *  - Parents are listed in brand.config.json → embed.allowed_parent_origins (exact origins).
 *  - Incoming messages are accepted ONLY when event.origin exactly matches an allowed origin
 *    AND event.source is our direct parent window. Everything else is ignored.
 *  - Outgoing messages are posted with an explicit targetOrigin per allowed origin (never "*"),
 *    and never contain the token.
 *  - Framing itself is restricted by `Content-Security-Policy: frame-ancestors` (vercel.json)
 *    and by the anti-clickjack check in index.html.
 *  - If the allow-list is empty or the page is not framed, this module does nothing.
 *
 * Protocol
 *   child  -> parent  { type: 'DTRADER_READY', logged_in: boolean }
 *   parent -> child   { type: 'DTRADER_AUTH', token: string, expires_at?: number, loginid?: string }
 *   parent -> child   { type: 'DTRADER_LOGOUT' }
 *
 * The session is stored exactly like the template's own OAuth login (Services/oauth.ts
 * storeTokens → sessionStorage `auth_info`; preferred account in sessionStorage
 * `active_loginid`), then the app reloads so ClientStore boots with it — the same thing
 * app.jsx does after a normal OAuth callback.
 */
// eslint-disable-next-line import/no-relative-packages
import config_data from '../../../../brand.config.json';

import { clearTokens, getStoredToken, storeTokens } from './oauth';

const MAX_TOKEN_LENGTH = 8192;
const LOGINID_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

export const getAllowedParentOrigins = (): string[] => {
    const embed = (config_data as Record<string, unknown>).embed as { allowed_parent_origins?: unknown } | undefined;
    const list = embed?.allowed_parent_origins;
    if (!Array.isArray(list)) return [];
    return list.filter((o): o is string => typeof o === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o));
};

export const isEmbedded = (): boolean => {
    try {
        return window.top !== window.self;
    } catch {
        return true; // cross-origin access to window.top throws → we are framed
    }
};

const postToParent = (allowed: string[], message: Record<string, unknown>) => {
    // The browser drops a message whose targetOrigin doesn't match the real parent,
    // so posting once per allowed origin reaches only the genuine one.
    allowed.forEach(origin => {
        try {
            window.parent.postMessage(message, origin);
        } catch {
            /* ignore */
        }
    });
};

const clearSession = () => {
    clearTokens();
    sessionStorage.removeItem('active_loginid');
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('account_type');
    localStorage.removeItem('account_id');
};

export const initEmbedBridge = (): void => {
    if (typeof window === 'undefined' || !isEmbedded()) return;
    const allowed = getAllowedParentOrigins();
    if (!allowed.length) return;

    window.addEventListener('message', (event: MessageEvent) => {
        if (!allowed.includes(event.origin)) return;
        if (event.source !== window.parent) return;
        const data = event.data as Record<string, unknown> | null;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'DTRADER_AUTH') {
            const { token, expires_at, loginid } = data;
            if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return;

            const had_token = getStoredToken();
            const expires_in =
                typeof expires_at === 'number' && expires_at > Date.now()
                    ? Math.floor((expires_at - Date.now()) / 1000)
                    : undefined;

            const prev_loginid = sessionStorage.getItem('active_loginid');
            const next_loginid = typeof loginid === 'string' && LOGINID_PATTERN.test(loginid) ? loginid : null;
            const account_changed = !!next_loginid && next_loginid !== prev_loginid;

            if (had_token === token && !account_changed) return; // nothing new

            storeTokens(token, undefined, expires_in);
            if (next_loginid) sessionStorage.setItem('active_loginid', next_loginid);

            // First login, or the parent switched account → reboot like after an OAuth callback.
            // A plain token refresh for the same account just updates storage.
            if (!had_token || account_changed) window.location.reload();
            return;
        }

        if (data.type === 'DTRADER_LOGOUT') {
            if (!getStoredToken()) return;
            clearSession();
            window.location.reload();
        }
    });

    postToParent(allowed, { type: 'DTRADER_READY', logged_in: !!getStoredToken() });
};
