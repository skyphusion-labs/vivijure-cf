/** Bearer for the fleet media containers (video-finish / audio-mix / audio-beat-sync). */

export type MediaFinishSecret = { get(): Promise<string> } | string | undefined;

export async function mediaFinishToken(raw: MediaFinishSecret): Promise<string> {
  if (typeof raw === "string") return raw.trim();
  if (!raw) return "";
  try {
    return (await raw.get()).trim();
  } catch {
    return "";
  }
}

export async function mediaFinishHeaders(
  raw: MediaFinishSecret,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  const token = await mediaFinishToken(raw);
  if (token) headers.authorization = "Bearer " + token;
  return headers;
}
