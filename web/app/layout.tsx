import "./globals.css";
import Link from "next/link";

// Title template: each page sets its own title (e.g. "Agents") and the tab reads "Agents · iam-engine",
// so people can tell pages apart from the title bar / tab strip.
export const metadata = {
  title: { default: "iam-engine", template: "%s · iam-engine" },
  description: "IAM lifecycle automation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <Link href="/clients" className="brand" style={{ textDecoration: "none" }}>
            iam-engine
          </Link>
          <Link href="/clients" className="muted" style={{ textDecoration: "none" }}>Clients</Link>
          <Link href="/cases" className="muted" style={{ textDecoration: "none" }}>Cases</Link>
          <Link href="/agents" className="muted" style={{ textDecoration: "none" }}>Agents</Link>
          <Link href="/health" className="muted" style={{ textDecoration: "none" }}>Health</Link>
        </header>
        {children}
      </body>
    </html>
  );
}
