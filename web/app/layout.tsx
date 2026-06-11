import "./globals.css";
import Link from "next/link";
import { Nav } from "./_components/nav";

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
          <Link href="/clients" className="brand">iam-engine</Link>
          <Nav />
        </header>
        {children}
      </body>
    </html>
  );
}
