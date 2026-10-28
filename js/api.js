// Thin JSON API client. Every request relies on the server-issued HttpOnly
// session cookie; the browser never stores tokens or account data.
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.code;
    error.data = data;
    throw error;
  }
  return data;
}

export const get = path => api(path);
export const post = (path, body, headers) => api(path, { method: 'POST', body, headers });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
