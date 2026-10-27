import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { deletePushDevice, savePushDevice } from "@/server/repo";
import { pushDeviceSchema, pushEndpointSchema } from "@/domain/validators";

/** Turns notifications on for this device, or brings its time zone up to date. */
export const POST = route(async (request, _context, user) => {
  const { endpoint, keys, timeZone } = await readJson(request, pushDeviceSchema);
  const reminders = await savePushDevice(user.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth, timeZone });
  return NextResponse.json({ reminders });
});

/** Turns notifications off for this device. */
export const DELETE = route(async (request, _context, user) => {
  const { endpoint } = await readJson(request, pushEndpointSchema);
  await deletePushDevice(user.id, endpoint);
  return NextResponse.json({ ok: true });
});
