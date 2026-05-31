import { redirect } from "next/navigation";

// Phase 1 home = the clients list.
export default function Home() {
  redirect("/clients");
}
