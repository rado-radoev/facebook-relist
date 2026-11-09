import type { Listing } from "../types";
import StatusPill from "./StatusPill";

interface Props {
  listing: Listing;
  onOpen: (listing: Listing) => void;
}

function photoBadge(listing: Listing): string | null {
  if (listing.photoCount === null) {
    return null;
  }
  let badge = `${listing.photoCount} photos`;
  if (listing.videoCount > 0) {
    badge += ` + ${listing.videoCount} video`;
  }
  return badge;
}

export default function ListingRow({ listing, onOpen }: Props) {
  const badge = photoBadge(listing);
  const title = listing.title.replace(/\s+/g, " ").trim();

  return (
    <button type="button" className="listing-row" onClick={() => onOpen(listing)}>
      <img className="listing-thumb" src={listing.photo} alt="" loading="lazy" />
      <span className="listing-main">
        <span className="listing-title">{title}</span>
        <span className="listing-meta">
          <span className="listing-price">{listing.price}</span>
          <StatusPill status={listing.status} />
          {badge ? <span className="photo-badge">📷 {badge}</span> : null}
        </span>
      </span>
      <span className="listing-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
