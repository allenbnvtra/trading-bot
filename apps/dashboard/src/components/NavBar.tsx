"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/research", label: "Research" },
  { href: "/strategies", label: "Strategies" },
  { href: "/backtests", label: "Backtests" },
  { href: "/market-data", label: "Market Data" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="nav-bar">
      <div className="nav-bar__brand">
        <Link href="/">Trading Copilot</Link>
      </div>
      <ul className="nav-bar__links">
        {LINKS.map((link) => {
          const isActive =
            link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={isActive ? "nav-bar__link nav-bar__link--active" : "nav-bar__link"}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
