/**
 * Maps a wealthdbot wallet to the DTrader's Deriv-shaped accounts, and resolves
 * which demo/real mode an account_id corresponds to. The DTrader shows a demo +
 * real account; both are backed by the single wealthdbot wallet (demo_balance vs
 * balance). Switching account => switching tl_account_mode (which the trade +
 * balance interceptors read).
 */
import type { TAccount } from '../../Services/accounts-api';

import { centsToMajor, setWbMode, wbLoginId, type WbWallet } from './backend';

const demoId = (userId: number): string => `VRW${String(90000000 + Number(userId || 0))}`;

/** real-account loginid for a user id (ROT9… — matches the live wealthdbot site). */
export const realId = (userId: number): string => wbLoginId(userId);

/** Build [demo, real] accounts from the wallet. */
export function buildWbAccounts(wallet: WbWallet): TAccount[] {
    const id = Number(wallet.user.id || 0);
    const now = new Date().toISOString();
    const base = {
        currency: 'USD',
        group: 'row',
        status: 'active',
        created_at: now,
        email: wallet.user.email || '',
        last_access_at: now,
        name: wallet.user.name || '',
        server_id: 'wealthdbot',
        rights: {},
    };
    const demo: TAccount = {
        ...base,
        account_id: demoId(id),
        account_type: 'demo',
        balance: centsToMajor(Number(wallet.user.demo_balance ?? 0)),
    };
    const real: TAccount = {
        ...base,
        account_id: realId(id),
        account_type: 'real',
        balance: centsToMajor(Number(wallet.user.balance ?? 0)),
    };
    return [demo, real];
}

/** Set tl_account_mode from the chosen account_id (real ids start with ROT). */
export function syncModeFromAccountId(account_id: string): void {
    setWbMode(String(account_id).startsWith('ROT') ? 'real' : 'demo');
}
