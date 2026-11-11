export function customEndpoint(base: string): URL {
  const u = new URL(base);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !u.hostname ||
    u.hostname === "localhost" ||
    /^[\d.]+$/.test(u.hostname) ||
    u.hostname.startsWith("[")
  )
    throw new Error(
      "Use a public HTTPS base URL without credentials, query or fragment.",
    );
  u.pathname = u.pathname.replace(/\/+$/, "") + "/chat/completions";
  return u;
}
