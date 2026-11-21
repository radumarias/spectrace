import type { ReactNode } from "react";
import { useMe } from "../api/queries";
import { SignIn } from "../pages/SignIn";

/** Renders children only for a signed-in user; the sign-in page otherwise. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <div className="signin" role="status">Loading…</div>;
  if (me.isError) return <div className="signin" role="alert">Cannot reach the server. Try again in a moment.</div>;
  if (me.data === null) return <SignIn />;
  return <>{children}</>;
}
