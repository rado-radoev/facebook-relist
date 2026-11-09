import type { Listing } from "../types";
import StatusPill from "../components/StatusPill";
import CloneCheckList from "../components/CloneCheckList";

interface Props {
  listing: Listing;
  onBack: () => void;
  onRecreate: (listing: Listing) => void;
}

export default function DetailScreen({ listing, onBack, onRecreate }: Props) {
  const title = listing.title.replace(/\s+/g, " ").trim();

  return (
    <div className="screen">
      <button type="button" className="back-button" onClick={onBack}>
        ‹ Listings
      </button>

      <img className="detail-photo" src={listing.photo} alt={title} />
      <h1 className="detail-title">{title}</h1>
      <div className="detail-meta">
        <span className="detail-price">{listing.price}</span>
        <StatusPill status={listing.status} />
        <span className="detail-location">{listing.location}</span>
      </div>

      <CloneCheckList listing={listing} />

      <button type="button" className="primary-button" onClick={() => onRecreate(listing)}>
        Recreate listing
      </button>
      <p className="screen-footnote">
        Recreating makes a brand-new copy first. The old listing stays up until the new one is live.
      </p>
      <a className="external-link" href={listing.product_url} target="_blank" rel="noreferrer">
        View on Facebook ↗
      </a>
    </div>
  );
}
