import { NextResponse } from "next/server";
import { HttpError, readJson, route } from "@/server/http";
import { sendPush } from "@/server/push";
import { deletePushDevice, getPushDevice } from "@/server/repo";
import { pushEndpointSchema } from "@/domain/validators";

/** Sends a test notification to this device. */
export const POST = route(async (request, _context, user) => {
  const { endpoint } = await readJson(request, pushEndpointSchema);
  const device = await getPushDevice(user.id, endpoint);
  if (!device) throw new HttpError(404, "Notifications are off on this device. Turn them on again.");
  const result = await sendPush(
    device,
    { title: "Notifications are working", body: "Your reminders will look like this.", tag: "test", url: "/" },
    request.nextUrl.origin,
  );
  if (result === "gone") {
    await deletePushDevice(user.id, endpoint);
    throw new HttpError(410, "This device stopped notifications. Turn them on again.");
  }
  if (result === "failed") throw new HttpError(502, "Could not send it. Try again in a moment.");
  return NextResponse.json({ ok: true });
});
