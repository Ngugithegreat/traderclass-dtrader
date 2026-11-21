/**
 * Wealthdbot login/signup modal for the DTrader.
 *
 * Mounted globally; opens when any login trigger dispatches `wb:open-auth`
 * (see shared/login.ts + core/oauth.ts). On success it stores the JWT and reloads
 * so client-store.init() bootstraps the session from the token. Self-contained
 * (inline styles) so it needs no extra build wiring. Inert unless isWb().
 */
import React from 'react';

import { isWb, wbLogin, wbRegister, wbSendSignupOtp, wbForgot } from './backend';

type Mode = 'login' | 'signup' | 'forgot';
const COUNTRIES = [
    { code: 'KE', name: 'Kenya' },
    { code: 'UG', name: 'Uganda' },
    { code: 'TZ', name: 'Tanzania' },
    { code: 'NG', name: 'Nigeria' },
    { code: 'OTHER', name: 'Other' },
];

const C = {
    overlay: {
        position: 'fixed' as const,
        inset: 0,
        background: 'rgba(3,8,15,0.72)',
        backdropFilter: 'blur(4px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
    },
    card: {
        width: '100%',
        maxWidth: 380,
        background: '#0b1f33',
        border: '1px solid rgba(201,162,39,0.25)',
        borderRadius: 16,
        padding: 24,
        boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
        color: '#fff',
        fontFamily: 'inherit',
    },
    title: { margin: '0 0 4px', fontSize: 20, fontWeight: 700 } as const,
    sub: { margin: '0 0 18px', fontSize: 13, color: 'rgba(255,255,255,0.6)' } as const,
    label: { display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.7)', margin: '10px 0 4px' } as const,
    input: {
        width: '100%',
        boxSizing: 'border-box' as const,
        padding: '11px 12px',
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(255,255,255,0.05)',
        color: '#fff',
        fontSize: 14,
        outline: 'none',
    },
    btn: {
        width: '100%',
        marginTop: 18,
        padding: '12px 16px',
        borderRadius: 10,
        border: 'none',
        background: 'linear-gradient(135deg,#e0b43a,#c9a227)',
        color: '#231504',
        fontSize: 15,
        fontWeight: 700,
        cursor: 'pointer',
    },
    link: { color: '#e0b43a', cursor: 'pointer', fontWeight: 600 } as const,
    foot: { marginTop: 16, fontSize: 13, color: 'rgba(255,255,255,0.65)', textAlign: 'center' as const },
    err: {
        marginTop: 12,
        fontSize: 13,
        color: '#ff8080',
        background: 'rgba(236,63,63,0.12)',
        padding: '8px 10px',
        borderRadius: 8,
    },
    ok: {
        marginTop: 12,
        fontSize: 13,
        color: '#9be7a0',
        background: 'rgba(34,197,94,0.12)',
        padding: '8px 10px',
        borderRadius: 8,
    },
    close: {
        position: 'absolute' as const,
        top: 14,
        right: 16,
        cursor: 'pointer',
        color: 'rgba(255,255,255,0.5)',
        fontSize: 22,
        lineHeight: 1,
    },
};

const LoginModal: React.FC = () => {
    const [open, setOpen] = React.useState(false);
    const [mode, setMode] = React.useState<Mode>('login');
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState('');
    const [msg, setMsg] = React.useState('');

    // fields
    const [name, setName] = React.useState('');
    const [email, setEmail] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [country, setCountry] = React.useState('KE');
    const [phone, setPhone] = React.useState('');
    const [code, setCode] = React.useState('');
    const [otpStep, setOtpStep] = React.useState(false);

    React.useEffect(() => {
        if (!isWb()) return undefined;
        const onOpen = (e: Event) => {
            const detail = (e as CustomEvent).detail || {};
            setMode(detail.mode === 'signup' ? 'signup' : 'login');
            setErr('');
            setMsg('');
            setOtpStep(false);
            setOpen(true);
        };
        window.addEventListener('wb:open-auth', onOpen as EventListener);
        return () => window.removeEventListener('wb:open-auth', onOpen as EventListener);
    }, []);

    if (!isWb() || !open) return null;

    const reset = (m: Mode) => {
        setMode(m);
        setErr('');
        setMsg('');
        setOtpStep(false);
    };

    const doLogin = async () => {
        setBusy(true);
        setErr('');
        const r = await wbLogin(email, password);
        setBusy(false);
        if (r.ok) window.location.reload();
        else setErr(r.error || 'Login failed.');
    };

    const doSignup = async () => {
        setBusy(true);
        setErr('');
        // Step 1: ask whether this country needs phone OTP.
        if (!otpStep) {
            const otp = await wbSendSignupOtp({ email, country, phone });
            if (otp.ok && otp.required) {
                setBusy(false);
                setOtpStep(true);
                setMsg('We sent a code to your phone. Enter it to finish.');
                return;
            }
            // Not required → register straight away.
        }
        const r = await wbRegister({ name, email, password, country, phone, code });
        setBusy(false);
        if (r.ok) window.location.reload();
        else setErr(r.error || 'Could not create your account.');
    };

    const doForgot = async () => {
        setBusy(true);
        setErr('');
        const r = await wbForgot(email);
        setBusy(false);
        if (r.ok) setMsg(r.message || 'If that email exists, a reset link is on its way.');
        else setErr(r.error || 'Could not send the reset email.');
    };

    const needPhone = ['KE', 'UG', 'TZ'].includes(country);

    return (
        <div style={C.overlay} onClick={() => setOpen(false)}>
            <div style={{ ...C.card, position: 'relative' }} onClick={e => e.stopPropagation()}>
                <span style={C.close} onClick={() => setOpen(false)}>
                    ×
                </span>

                {mode === 'login' && (
                    <>
                        <h2 style={C.title}>Welcome back</h2>
                        <p style={C.sub}>Log in to your Wealthdbot account</p>
                        <label style={C.label}>Email</label>
                        <input
                            style={C.input}
                            type='email'
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            autoFocus
                        />
                        <label style={C.label}>Password</label>
                        <input
                            style={C.input}
                            type='password'
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && doLogin()}
                        />
                        {err && <div style={C.err}>{err}</div>}
                        <button style={C.btn} disabled={busy} onClick={doLogin}>
                            {busy ? 'Logging in…' : 'Log in'}
                        </button>
                        <div style={C.foot}>
                            <span style={C.link} onClick={() => reset('forgot')}>
                                Forgot password?
                            </span>
                        </div>
                        <div style={C.foot}>
                            New here?{' '}
                            <span style={C.link} onClick={() => reset('signup')}>
                                Create an account
                            </span>
                        </div>
                    </>
                )}

                {mode === 'signup' && (
                    <>
                        <h2 style={C.title}>Create your account</h2>
                        <p style={C.sub}>Trade with Wealthdbot</p>
                        {!otpStep && (
                            <>
                                <label style={C.label}>Full name</label>
                                <input style={C.input} value={name} onChange={e => setName(e.target.value)} />
                                <label style={C.label}>Email</label>
                                <input
                                    style={C.input}
                                    type='email'
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                />
                                <label style={C.label}>Password</label>
                                <input
                                    style={C.input}
                                    type='password'
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                />
                                <label style={C.label}>Country</label>
                                <select style={C.input} value={country} onChange={e => setCountry(e.target.value)}>
                                    {COUNTRIES.map(c => (
                                        <option key={c.code} value={c.code} style={{ color: '#000' }}>
                                            {c.name}
                                        </option>
                                    ))}
                                </select>
                                {needPhone && (
                                    <>
                                        <label style={C.label}>Phone number</label>
                                        <input
                                            style={C.input}
                                            value={phone}
                                            onChange={e => setPhone(e.target.value)}
                                            placeholder='2547…'
                                        />
                                    </>
                                )}
                            </>
                        )}
                        {otpStep && (
                            <>
                                <label style={C.label}>Verification code</label>
                                <input
                                    style={C.input}
                                    value={code}
                                    onChange={e => setCode(e.target.value)}
                                    placeholder='6-digit code'
                                    autoFocus
                                />
                            </>
                        )}
                        {msg && <div style={C.ok}>{msg}</div>}
                        {err && <div style={C.err}>{err}</div>}
                        <button style={C.btn} disabled={busy} onClick={doSignup}>
                            {busy ? 'Please wait…' : otpStep ? 'Verify & create account' : 'Create account'}
                        </button>
                        <div style={C.foot}>
                            Have an account?{' '}
                            <span style={C.link} onClick={() => reset('login')}>
                                Log in
                            </span>
                        </div>
                    </>
                )}

                {mode === 'forgot' && (
                    <>
                        <h2 style={C.title}>Reset password</h2>
                        <p style={C.sub}>We will email you a reset link</p>
                        <label style={C.label}>Email</label>
                        <input
                            style={C.input}
                            type='email'
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            autoFocus
                        />
                        {msg && <div style={C.ok}>{msg}</div>}
                        {err && <div style={C.err}>{err}</div>}
                        <button style={C.btn} disabled={busy} onClick={doForgot}>
                            {busy ? 'Sending…' : 'Send reset link'}
                        </button>
                        <div style={C.foot}>
                            <span style={C.link} onClick={() => reset('login')}>
                                Back to login
                            </span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default LoginModal;
