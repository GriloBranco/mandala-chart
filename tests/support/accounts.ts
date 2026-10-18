import { createUser } from "@/server/users";

/** A new account with a unique email. The password hash is never checked by these tests. */
export function newAccount(name = "person") {
  return createUser(`${name}-${crypto.randomUUID()}@example.com`, "not-a-real-hash");
}
