import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { useReviewCount } from "./lib/useReviewCount";
import { CameraIcon, CheckIcon, HomeIcon, ReceiptIcon, SettingsIcon, UploadIcon } from "./components/Icons";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Welcome from "./pages/Welcome";
import Home from "./pages/Home";
import Receipts from "./pages/Receipts";
import ReceiptDetail from "./pages/ReceiptDetail";
import Review from "./pages/Review";
import Reports from "./pages/Reports";
import Add from "./pages/Add";
import Import from "./pages/Import";
import Settings from "./pages/Settings";
import OAuthConsent from "./pages/OAuthConsent";
import Privacy from "./pages/Privacy";
import Invite from "./pages/Invite";
import MfaChallenge from "./pages/MfaChallenge";
import { ConfirmIdentityProvider } from "./components/ConfirmIdentity";
import { needsSecondStep } from "./lib/mfa";
import { AccountProvider, PENDING_INVITE_KEY, useAccount, type Area } from "./lib/account";

function hasPendingInvite(): boolean {
  try {
    return !!localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return false;
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // Whether this session still has to enter the two-step code (undefined while checking).
  const [secondStep, setSecondStep] = useState<boolean | undefined>(undefined);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Clicked the link in a password-reset email: Supabase signs in just to let them pick a new password.
      if (event === "PASSWORD_RECOVERY") navigate("/reset-password", { replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const token = session?.access_token;
  const recheckSecondStep = useCallback(() => {
    if (!token) return setSecondStep(false);
    needsSecondStep().then(setSecondStep);
  }, [token]);
  useEffect(() => { recheckSecondStep(); }, [recheckSecondStep]);

  if (pathname === "/privacy") return <Privacy />;
  if (session === undefined || (session && secondStep === undefined)) return <div className="center muted">Loading…</div>;
  if (session && secondStep) return <MfaChallenge email={session.user.email ?? ""} onDone={recheckSecondStep} />;
  // An invite link, or coming back from sign-up / sign-in with one still waiting to be accepted.
  if (pathname === "/invite" || (session && hasPendingInvite() && pathname !== "/reset-password" && pathname !== "/oauth/authorize")) {
    return <Invite userId={session?.user.id} email={session?.user.email ?? undefined} />;
  }
  if (!session) {
    return <Auth initialMode={pathname === "/signup" ? "signup" : pathname === "/reset-password" ? "forgot" : "signin"} />;
  }
  if (pathname === "/reset-password") return <ResetPassword />;
  const email = session.user.email ?? "";
  if (pathname === "/oauth/authorize") {
    return <ConfirmIdentityProvider email={email}><OAuthConsent email={email} /></ConfirmIdentityProvider>;
  }
  return (
    <ConfirmIdentityProvider email={email}>
      <AccountProvider userId={session.user.id} email={email}>
        <Shell userId={session.user.id} email={email} />
      </AccountProvider>
    </ConfirmIdentityProvider>
  );
}

/** Sends people who can't open a page back home instead of showing them an empty or failing screen. */
function Allowed({ area, level = "view", children }: { area: Area; level?: "view" | "edit"; children: JSX.Element }) {
  const { can } = useAccount();
  if (can(area, level)) return children;
  return <Navigate to="/" replace state={{ notice: "You don't have access to that page in this account." }} />;
}

function AccountBar() {
  const { account, accounts, switchTo } = useAccount();
  if (accounts.length < 2) return null;
  return (
    <div className={`account-bar${account.own ? "" : " shared"}`}>
      <label className="inline-select">
        <span>Account</span>
        <select value={account.ownerId} onChange={(e) => switchTo(e.target.value)} aria-label="Switch account">
          {accounts.map((a) => (
            <option key={a.ownerId} value={a.ownerId}>{a.own ? `Mine (${a.ownerEmail})` : a.ownerEmail}</option>
          ))}
        </select>
      </label>
      {!account.own && <span className="small">You're working in {account.ownerEmail}'s account</span>}
    </div>
  );
}

function Shell({ userId, email }: { userId: string; email: string }) {
  const { account, can, needsTwoStep } = useAccount();
  const reviewCount = useReviewCount(can("receipts", "edit"));
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const badge = reviewCount > 0 && <span className="badge">{reviewCount}</span>;

  // First visit after sign-up: send them through the setup guide once.
  useEffect(() => {
    if (location.pathname !== "/" || !account.own) return;
    supabase.from("profiles").select("onboarded_at").eq("user_id", userId).maybeSingle().then(({ data }) => {
      if (data && !data.onboarded_at) navigate("/welcome", { replace: true });
    });
  }, [userId, account.own, location.pathname, navigate]);

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">Receipt Catcher</NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>Home</NavLink>
          {can("receipts") && <NavLink to="/receipts">Receipts</NavLink>}
          {can("receipts", "edit") && <NavLink to="/review">Review{badge}</NavLink>}
          {can("reports") && <NavLink to="/reports">Reports</NavLink>}
          <NavLink to="/settings">Settings</NavLink>
          {can("receipts", "edit") && <NavLink to="/add" className="snap-pill"><CameraIcon size={18} />Snap</NavLink>}
          {can("receipts", "edit") && <NavLink to="/import" className="import-pill"><UploadIcon size={18} />Import</NavLink>}
        </nav>
      </header>
      <AccountBar />

      <main>
        {notice && <p className="banner ok" role="status">{notice}</p>}
        {needsTwoStep && location.pathname !== "/settings" && (
          <div className="banner warn" role="alert">
            <b>{account.ownerEmail} requires two-step sign-in.</b> Their receipts stay hidden until you turn it on.{" "}
            <Link to="/settings#two-step">Set it up in Settings</Link>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/welcome" element={<Welcome userId={userId} />} />
          <Route path="/receipts" element={<Allowed area="receipts"><Receipts /></Allowed>} />
          <Route path="/receipts/:id" element={<Allowed area="receipts"><ReceiptDetail /></Allowed>} />
          <Route path="/review" element={<Allowed area="receipts" level="edit"><Review /></Allowed>} />
          <Route path="/reports" element={<Allowed area="reports"><Reports /></Allowed>} />
          <Route path="/add" element={<Allowed area="receipts" level="edit"><Add /></Allowed>} />
          <Route path="/import" element={<Allowed area="receipts" level="edit"><Import /></Allowed>} />
          <Route path="/settings" element={<Settings userId={userId} email={email} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end><HomeIcon />Home</NavLink>
        {can("receipts") && <NavLink to="/receipts"><ReceiptIcon />Receipts</NavLink>}
        {can("receipts", "edit") && <NavLink to="/add" className="snap" aria-label="Snap a receipt"><CameraIcon /></NavLink>}
        {can("receipts", "edit") && <NavLink to="/import"><UploadIcon />Import</NavLink>}
        {can("receipts", "edit") && <NavLink to="/review"><CheckIcon />Review{badge}</NavLink>}
        <NavLink to="/settings"><SettingsIcon />Settings</NavLink>
      </nav>
    </div>
  );
}
