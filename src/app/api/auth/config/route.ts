import { NextResponse } from "next/server";
import { authReady } from "@/lib/auth";
import { publicRoute } from "@/lib/http";

/** What the welcome screen needs to know before anyone signs in. */
export const GET = publicRoute(async () =>
  NextResponse.json({
    ready: authReady(),
    signupsOpen: process.env.SIGNUPS_CLOSED !== "1",
    inviteOnly: Boolean(process.env.SIGNUP_CODE?.trim()),
  }),
);
