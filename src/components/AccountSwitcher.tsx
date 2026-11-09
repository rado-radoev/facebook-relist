import type { Account } from "../types";
import { firstName, SESSION_META } from "../lib/accounts";

interface Props {
  accounts: Account[];
  activeId: string;
  onSelect: (account: Account) => void;
  onAdd: () => void;
}

export default function AccountSwitcher({ accounts, activeId, onSelect, onAdd }: Props) {
  return (
    <div className="account-row" role="group" aria-label="Household accounts">
      {accounts.map((account) => {
        let className = "account-chip";
        if (account.id === activeId) {
          className += " account-chip-active";
        }
        const meta = SESSION_META[account.sessionStatus];
        return (
          <button
            key={account.id}
            type="button"
            className={className}
            onClick={() => onSelect(account)}
            aria-pressed={account.id === activeId}
          >
            <span className="account-chip-avatar" aria-hidden="true">
              {account.initials}
            </span>
            <span className="account-chip-name">{firstName(account.displayName)}</span>
            <span className="account-chip-dot" style={{ background: meta.color }} aria-hidden="true" />
          </button>
        );
      })}
      <button type="button" className="account-chip account-chip-add" onClick={onAdd}>
        ＋ Add person
      </button>
    </div>
  );
}
