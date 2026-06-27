import { redirect } from "next/navigation";
import { getSessionEmail } from "@/lib/auth";

export default async function Home() {
  const email = await getSessionEmail();
  redirect(email ? "/dashboard" : "/login");
}
