let token = "";
export const setSessionToken = (value: string) => {
  token = value;
};
export async function api<T>(
  url: string,
  body?: unknown,
  options: { method?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(url, {
    method,
    signal: options.signal,
    headers:
      method === "GET"
        ? {}
        : { "Content-Type": "application/json", "X-Well-Token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message ?? "The local server could not complete this request.",
    );
  return data as T;
}
