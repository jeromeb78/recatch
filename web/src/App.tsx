import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { useReviewCount } from "./lib/useReviewCount";
import { CameraIcon, CheckIcon, HomeIcon, ReceiptIcon, SettingsIcon } from "./components/Icons";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Receipts from "./pages/Receipts";
import ReceiptDetail from "./pages/ReceiptDetail";
import Review from "./pages/Review";
import Add from "./pages/Add";
import Settings from "./pages/Settings";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) return <Login />;
  return <Shell userId={session.user.id} />;
}

function Shell({ userId }: { userId: string }) {
  const reviewCount = useReviewCount();
  const badge = reviewCount > 0 && <span className="badge">{reviewCount}</span>;

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">Receipt Catcher</NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/receipts">Receipts</NavLink>
          <NavLink to="/review">Review{badge}</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/add" className="snap-pill"><CameraIcon size={18} />Snap</NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/receipts" element={<Receipts />} />
          <Route path="/receipts/:id" element={<ReceiptDetail />} />
          <Route path="/review" element={<Review />} />
          <Route path="/add" element={<Add />} />
          <Route path="/settings" element={<Settings userId={userId} />} />
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
