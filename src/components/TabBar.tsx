import type { TabId } from "../types";

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: "listings", label: "Listings", icon: "🗂️" },
  { id: "history", label: "History", icon: "🕘" },
];

interface Props {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export default function TabBar({ active, onChange }: Props) {
  return (
    <nav className="tab-bar" aria-label="Main">
      {TABS.map((tab) => {
        let className = "tab-button";
        if (tab.id === active) {
          className += " tab-button-active";
        }
        return (
          <button key={tab.id} type="button" className={className} onClick={() => onChange(tab.id)}>
            <span className="tab-icon" aria-hidden="true">
              {tab.icon}
            </span>
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
