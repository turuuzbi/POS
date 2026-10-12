import { redirect } from "next/navigation";
import { hasPermission } from "@/domain/permissions";
import { readDeviceToken } from "@/server/auth/device";
import { getCurrentUser } from "@/server/auth/session";

/** Entry point: route each role to its home screen. */
export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect((await readDeviceToken()) ? "/pin" : "/login");
  redirect(hasPermission(user.role, "reports.view") ? "/dashboard" : "/register");
}
