import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import crypto from "crypto";

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get("pc_rental_auth")?.value;

  if (token) {
    const secret = process.env.AUTH_SECRET;
    const username = process.env.ADMIN_USERNAME;
    if (secret && username) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(username)
        .digest("hex");
      if (
        token.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      ) {
        redirect("/dashboard");
      }
    }
  }

  redirect("/login");
}
