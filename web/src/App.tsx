import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Receipts from "./pages/Receipts";
import ReceiptDetail from "./pages/ReceiptDetail";
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

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">🧾 Receipt Catcher</NavLink>
        <nav>
          <NavLink to="/" end>Receipts</NavLink>
          <NavLink to="/add">Add</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Receipts />} />
          <Route path="/receipts/:id" element={<ReceiptDetail />} />
          <Route path="/add" element={<Add />} />
          <Route path="/settings" element={<Settings userId={session.user.id} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
