import type { Metadata } from "next";
import { LoginScreen } from "./LoginScreen";

export const metadata: Metadata = { title: "Sign in · Mandala" };

export default function LoginPage() {
  return <LoginScreen />;
}
