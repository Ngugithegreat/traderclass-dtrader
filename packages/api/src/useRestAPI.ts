import React from 'react';

import { getAppId } from '@deriv/shared';

import { APIContext } from './APIProvider';

const AUTH_INFO_KEY = 'auth_info';

const getStoredToken = (): string | null => {
    try {
        const info = JSON.parse(sessionStorage.getItem(AUTH_INFO_KEY) ?? 'null');
        if (!info) return null;
        if (info.expires_at && Date.now() >= info.expires_at) {
            sessionStorage.removeItem(AUTH_INFO_KEY);
            return null;
        }
        return info.access_token ?? null;
    } catch {
        return null;
    }
};

/**
 * Hook to access REST API configuration from APIProvider
 * Provides centralized REST API base URL and fetch helper
 */
export const useRestAPI = () => {
    const context = React.useContext(APIContext);

    if (!context) {
        throw new Error('useRestAPI must be used within APIProvider');
    }

    const { restAPIConfig } = context;

    /**
     * Generic fetch wrapper with auth headers
     * @param endpoint - API endpoint path (e.g., '/trading/v1/options/accounts')
     * @param options - Optional fetch options
     * @returns Promise with typed response
     */
    const fetchREST = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
        // Wealthdbot own-backend: the derivatives-accounts list comes from our
        // wallet, not Deriv (api cannot import core, so map inline). The switch +
        // base URL are provided at runtime by core via globalThis.__WB (env vars
        // are not reliably inlined into this package). Everything else → Deriv.
        const wb = (globalThis as unknown as { __WB?: { on: boolean; api: string } }).__WB;
        if (wb?.on && endpoint.startsWith('/trading/v1/options/accounts') && (options?.method || 'GET') === 'GET') {
            const base = wb.api || '';
            let tok: string | null = null;
            try {
                tok = localStorage.getItem('tl_token');
            } catch {
                /* noop */
            }
            const res = await fetch(`${base}/api/wallet`, {
                headers: tok ? { Authorization: `Bearer ${tok}` } : {},
                cache: 'no-store',
            });
            if (!res.ok)
                throw Object.assign(new Error('wallet failed'), {
                    status: res.status,
                    isAuthError: res.status === 401,
                });
            const j = await res.json();
            const u = j.user || {};
            const id = Number(u.id || 0);
            const now = new Date().toISOString();
            const mk = (account_type: 'demo' | 'real', cents: unknown, pfx: string) => ({
                account_id: pfx + String(90000000 + id),
                account_type,
                balance: Math.round(Number(cents || 0)) / 100,
                currency: 'USD',
                group: 'row',
                status: 'active',
                created_at: now,
                email: u.email || '',
                last_access_at: now,
                name: u.name || '',
                server_id: 'wealthdbot',
                rights: {},
            });
            return { data: [mk('demo', u.demo_balance, 'VRW'), mk('real', u.balance, 'ROT')] } as T;
        }

        const url = `${restAPIConfig.baseUrl}${endpoint}`;

        // Determine the method (default to GET if not specified)
        const method = options?.method || 'GET';

        // Only set Content-Type for methods that have a body
        const shouldSetContentType = ['POST', 'PUT', 'PATCH'].includes(method);

        const token = getStoredToken();
        const authHeaders: Record<string, string> = token
            ? { Authorization: `Bearer ${token}`, 'Deriv-App-ID': String(getAppId()) }
            : {};

        const response = await fetch(url, {
            ...options,
            method,
            headers: {
                ...authHeaders,
                ...(shouldSetContentType && { 'Content-Type': 'application/json' }),
                ...options?.headers,
            },
        });

        if (!response.ok) {
            // Try to parse error body for more detailed error information
            let errorBody;
            try {
                errorBody = await response.json();
            } catch {
                // If response body is not JSON, use generic error
                errorBody = null;
            }

            // Extract error message from API response if available
            const errorMessage =
                errorBody?.errors?.[0]?.message || `REST API Error: ${response.status} ${response.statusText}`;
            const errorCode = errorBody?.errors?.[0]?.code;

            // Create enhanced error with additional properties
            const error = new Error(errorMessage) as Error & {
                status: number;
                statusText: string;
                code?: string;
                body?: unknown;
                isAuthError: boolean;
            };

            error.status = response.status;
            error.statusText = response.statusText;
            error.code = errorCode;
            error.body = errorBody;
            error.isAuthError = response.status === 401 || response.status === 403;

            throw error;
        }

        const data = await response.json();

        return data;
    };

    return {
        baseUrl: restAPIConfig.baseUrl,
        fetchREST,
    };
};
