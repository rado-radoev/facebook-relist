import { useCallback, useEffect, useState } from "react";
import type { CurrentUser, Listing, SessionStatus, TabId, View } from "./types";
import {
  disconnectFacebook,
  fetchFacebookStatus,
  fetchMe,
  logout,
  type ApiUser,
} from "./lib/api";
import { initialsOf } from "./lib/user";
import TabBar from "./components/TabBar";
import AuthScreen from "./screens/AuthScreen";
import ListingsScreen from "./screens/ListingsScreen";
import DetailScreen from "./screens/DetailScreen";
import ProgressScreen from "./screens/ProgressScreen";
import HistoryScreen from "./screens/HistoryScreen";
import ConnectScreen from "./screens/ConnectScreen";

type AuthState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; user: ApiUser };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [facebookStatus, setFacebookStatus] = useState<SessionStatus>("not_connected");
  const [tab, setTab] = useState<TabId>("listings");
  const [view, setView] = useState<View>({ kind: "tabs" });
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const refreshFacebookStatus = useCallback(async () => {
    try {
      const status = await fetchFacebookStatus();
      setFacebookStatus(status);
    } catch {
      // Backend unreachable — keep the last known status on screen.
    }
  }, []);

  useEffect(() => {
    async function loadSession() {
      try {
        const user = await fetchMe();
        setAuth({ kind: "signedIn", user });
        await refreshFacebookStatus();
      } catch {
        setAuth({ kind: "signedOut" });
      }
    }
    void loadSession();
  }, [refreshFacebookStatus]);

  const handleStatusChange = useCallback((status: SessionStatus) => {
    setFacebookStatus(status);
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
      setFacebookStatus("not_connected");
      setView({ kind: "tabs" });
      setTab("listings");
      setAuth({ kind: "signedOut" });
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Could not sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  async function handleDisconnect() {
    try {
      const status = await disconnectFacebook();
      setFacebookStatus(status);
    } catch {
      await refreshFacebookStatus();
    }
  }

  function handleSignedIn(user: ApiUser) {
    setAuth({ kind: "signedIn", user });
    void refreshFacebookStatus();
  }

  function openConnect() {
    setView({ kind: "connect" });
  }

  function openListing(listing: Listing) {
    setView({ kind: "detail", listing });
  }

  function startRecreate(listing: Listing, jobId?: string) {
    setView({ kind: "progress", listing, jobId });
  }

  function backToTabs(nextTab: TabId) {
    setTab(nextTab);
    setView({ kind: "tabs" });
    void refreshFacebookStatus();
  }

  if (auth.kind === "loading") {
    return (
      <div className="phone">
        <header className="app-header">
          <span className="app-logo" aria-hidden="true">
            🔁
          </span>
          <span className="app-name">Relist</span>
        </header>
        <main className="app-main">
          <div className="screen">
            <p className="empty-note">Loading…</p>
          </div>
        </main>
      </div>
    );
  }

  if (auth.kind === "signedOut") {
    return (
      <div className="phone">
        <header className="app-header">
          <span className="app-logo" aria-hidden="true">
            🔁
          </span>
          <span className="app-name">Relist</span>
        </header>
        <main className="app-main">
          <AuthScreen onSignedIn={handleSignedIn} />
          {signOutError ? <p role="alert" className="alert-note">Could not sign out: {signOutError}</p> : null}
        </main>
      </div>
    );
  }

  const currentUser: CurrentUser = {
    id: auth.user.id,
    displayName: auth.user.name,
    initials: initialsOf(auth.user.name),
    facebookStatus,
  };

  let body = (
    <ListingsScreen
      user={currentUser}
      onConnect={openConnect}
      onDisconnect={handleDisconnect}
      onOpen={openListing}
    />
  );
  if (view.kind === "detail") {
    body = (
      <DetailScreen
        listing={view.listing}
        facebookConnected={facebookStatus === "connected"}
        onBack={() => setView({ kind: "tabs" })}
        onRecreate={startRecreate}
      />
    );
  }
  if (view.kind === "progress") {
    body = (
      <ProgressScreen
        listing={view.listing}
        jobId={view.jobId}
        onDone={() => backToTabs("history")}
      />
    );
  }
  if (view.kind === "connect") {
    body = (
      <ConnectScreen
        facebookStatus={facebookStatus}
        onStatusChange={handleStatusChange}
        onBack={() => backToTabs("listings")}
      />
    );
  }
  if (view.kind === "tabs" && tab === "history") {
    body = <HistoryScreen />;
  }

  const showTabs = view.kind === "tabs";

  return (
    <div className="phone">
      <header className="app-header">
        <span className="app-logo" aria-hidden="true">
          🔁
        </span>
        <span className="app-name">Relist</span>
        <span className="preview-badge">Sprint 3</span>
      </header>

      <main className="app-main">
        {body}
        <div className="session-actions">
          {signOutError ? <p role="alert" className="alert-note">Could not sign out: {signOutError}</p> : null}
          <button
            type="button"
            className="edit-button"
            aria-label="Sign out of Relist"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
          >
            {signingOut ? "Signing out…" : "Sign out of Relist"}
          </button>
        </div>
      </main>

      {showTabs ? <TabBar active={tab} onChange={setTab} /> : null}
    </div>
  );
}
