import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireSupabaseUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null;

  if (error || !userId) {
    throw new Error("UNAUTHORIZED");
  }

  return { supabase, userId };
}
