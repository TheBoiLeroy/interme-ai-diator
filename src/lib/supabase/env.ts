/** Strips paste debris from dashboard-entered values: whitespace, quotes, trailing commas or slashes. */
function clean(value: string | undefined) {
  return value?.trim().replace(/^["']|["']$/g, "").replace(/[,;\s]+$/, "") || undefined;
}

export function supabaseEnv() {
  const url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/+$/, "");
  const key = clean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local.",
    );
  }
  return { url, key };
}
