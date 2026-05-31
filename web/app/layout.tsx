import "./globals.css";
import Link from "next/link";

export const metadata = { title: "iam-engine", description: "IAM lifecycle automation" };

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
        </header>
        {children}
      </body>
    </html>
  );
}
