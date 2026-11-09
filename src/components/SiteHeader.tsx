import { Link } from "@tanstack/react-router";
import { DonateButton } from "~/components/DonateButton";
import { UserMenu } from "~/components/UserMenu";

/** Top bar: brand on the left, account on the right. Add nav links inside `.nav__links` later. */
export function SiteHeader() {
  return (
    <header className="nav">
      <div className="container nav__inner">
        <Link to="/" className="nav__brand" aria-label="RomLingo">
          <img className="brand-logo" src="/logo.png" alt="" width={65} height={44} />
          RomLingo
        </Link>
        <nav className="nav__links" aria-label="Chính">
          <DonateButton />
          <UserMenu />
        </nav>
      </div>
    </header>
  );
}
