import { useState } from "react";
import type { Listing, TabId, View } from "./types";
import { currentUser } from "./data/currentUser";
import TabBar from "./components/TabBar";
import ListingsScreen from "./screens/ListingsScreen";
import DetailScreen from "./screens/DetailScreen";
import ProgressScreen from "./screens/ProgressScreen";
import HistoryScreen from "./screens/HistoryScreen";
import SettingsScreen from "./screens/SettingsScreen";
import ConnectScreen from "./screens/ConnectScreen";

export default function App() {
  const [tab, setTab] = useState<TabId>("listings");
  const [view, setView] = useState<View>({ kind: "tabs" });

  function openConnect() {
    setView({ kind: "connect" });
  }

  function openListing(listing: Listing) {
    setView({ kind: "detail", listing });
  }

  function startRecreate(listing: Listing) {
    setView({ kind: "progress", listing });
  }

  function backToTabs(nextTab: TabId) {
    setTab(nextTab);
    setView({ kind: "tabs" });
  }

  let body = <ListingsScreen user={currentUser} onConnect={openConnect} onOpen={openListing} />;
  if (view.kind === "detail") {
    body = (
      <DetailScreen listing={view.listing} onBack={() => setView({ kind: "tabs" })} onRecreate={startRecreate} />
    );
  }
  if (view.kind === "progress") {
    body = <ProgressScreen listing={view.listing} onDone={() => backToTabs("history")} />;
  }
  if (view.kind === "connect") {
    body = <ConnectScreen onBack={() => setView({ kind: "tabs" })} />;
  }
  if (view.kind === "tabs" && tab === "history") {
    body = <HistoryScreen />;
  }
  if (view.kind === "tabs" && tab === "settings") {
    body = <SettingsScreen user={currentUser} />;
  }

  const showTabs = view.kind === "tabs";

  return (
    <div className="phone">
      <header className="app-header">
        <span className="app-logo" aria-hidden="true">
          🔁
        </span>
        <span className="app-name">Relist</span>
        <span className="preview-badge">Preview</span>
        <span className="user-identity">
          <span className="user-avatar" aria-hidden="true">
            {currentUser.initials}
          </span>
          <span className="user-name">{currentUser.displayName}</span>
          <button type="button" className="sign-out-button" disabled title="Preview only">
            Sign out
          </button>
        </span>
      </header>

      <main className="app-main">{body}</main>

      {showTabs ? <TabBar active={tab} onChange={setTab} /> : null}
    </div>
  );
}
