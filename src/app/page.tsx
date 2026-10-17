import { MandalaApp } from "@/components/shell/MandalaApp";

// The whole app is one client page. The proxy has already checked the session cookie.
export default function Home() {
  return <MandalaApp />;
}
