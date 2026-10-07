import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { useReviewCount } from "./lib/useReviewCount";
import { CameraIcon, CheckIcon, HomeIcon, ReceiptIcon, SettingsIcon } from "./components/Icons";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Welcome from "./pages/Welcome";
import Home from "./pages/Home";
import Receipts from "./pages/Receipts";
import ReceiptDetail from "./pages/ReceiptDetail";
import Review from "./pages/Review";
import Reports from "./pages/Reports";
import Add from "./pages/Add";
import Settings from "./pages/Settings";
import OAuthConsent from "./pages/OAuthConsent";
import Privacy from "./pages/Privacy";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
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

  if (pathname === "/privacy") return <Privacy />;
  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) {
    return <Auth initialMode={pathname === "/signup" ? "signup" : pathname === "/reset-password" ? "forgot" : "signin"} />;
  }
  if (pathname === "/reset-password") return <ResetPassword />;
  if (pathname === "/oauth/authorize") return <OAuthConsent email={session.user.email ?? ""} />;
  return <Shell userId={session.user.id} email={session.user.email ?? ""} />;
}

function Shell({ userId, email }: { userId: string; email: string }) {
  const reviewCount = useReviewCount();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const badge = reviewCount > 0 && <span className="badge">{reviewCount}</span>;

  // First visit after sign-up: send them through the setup guide once.
  useEffect(() => {
    if (location.pathname !== "/") return;
    supabase.from("profiles").select("onboarded_at").eq("user_id", userId).maybeSingle().then(({ data }) => {
      if (data && !data.onboarded_at) navigate("/welcome", { replace: true });
    });
  }, [userId, location.pathname, navigate]);

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">Receipt Catcher</NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/receipts">Receipts</NavLink>
          <NavLink to="/review">Review{badge}</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/add" className="snap-pill"><CameraIcon size={18} />Snap</NavLink>
        </nav>
      </header>

      <main>
        {notice && <p className="banner ok" role="status">{notice}</p>}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/welcome" element={<Welcome userId={userId} />} />
          <Route path="/receipts" element={<Receipts />} />
          <Route path="/receipts/:id" element={<ReceiptDetail />} />
          <Route path="/review" element={<Review />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/add" element={<Add />} />
          <Route path="/settings" element={<Settings userId={userId} email={email} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end><HomeIcon />Home</NavLink>
        <NavLink to="/receipts"><ReceiptIcon />Receipts</NavLink>
        <NavLink to="/add" className="snap" aria-label="Snap a receipt"><CameraIcon /></NavLink>
        <NavLink to="/review"><CheckIcon />Review{badge}</NavLink>
        <NavLink to="/settings"><SettingsIcon />Settings</NavLink>
      </nav>
    </div>
  );
}
