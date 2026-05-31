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
          <span className="muted">Clients</span>
        </header>
        {children}
      </body>
    </html>
  );
}
