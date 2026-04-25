// Collaboration room discovery, verified against the installed
// jupyter_server_ydoc/jupyter_server_fileid stack on 2026-04-25:
// - GET /api/contents/<path>?content=0 returns the standard contents model.
//   In this stack, the file id is not exposed there.
// - PUT /api/collaboration/session/<path> with body
//   {"format":"json","type":"notebook"} returns:
//   {"format":"json","type":"notebook","fileId":"<uuid>","sessionId":"<uuid>"}
// - The Yjs room name is "json:notebook:<fileId>". The WebSocket query must
//   carry sessionId so the server accepts reconnect/session compatibility.

export interface CollabSession {
  fileId: string;
  sessionId: string;
  serverPath: string;
  roomName: string;
  roomUrl: string;
}

interface CollabSessionResponse {
  format?: unknown;
  type?: unknown;
  fileId?: unknown;
  sessionId?: unknown;
}

export function toJupyterServerPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const driveMatch = trimmed.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    return `mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return trimmed.replace(/^\/+/, '');
}

export function getCollabRoomName(fileId: string): string {
  return `json:notebook:${fileId}`;
}

export function getCollabRoomServerUrl(baseUrl: string): string {
  const url = new URL('api/collaboration/room', ensureTrailingSlash(baseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}

export function getCollabRoomUrl(baseUrl: string, fileId: string, sessionId?: string): string {
  const url = new URL(`${getCollabRoomServerUrl(baseUrl)}/${getCollabRoomName(fileId)}`);
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId);
  }
  return url.toString();
}

export async function getFileId(baseUrl: string, path: string): Promise<string> {
  const session = await resolveCollabSession(baseUrl, path);
  return session.fileId;
}

export async function resolveCollabSession(
  baseUrl: string,
  path: string,
  token = ''
): Promise<CollabSession> {
  const serverPath = toJupyterServerPath(path);
  const url = new URL(
    `api/collaboration/session/${encodeJupyterApiPath(serverPath)}`,
    ensureTrailingSlash(baseUrl)
  );
  if (token) {
    url.searchParams.set('token', token);
  }

  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'json', type: 'notebook' }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Failed to resolve notebook collaboration room for ${serverPath}: ` +
        `${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`
    );
  }

  const data = (await response.json()) as CollabSessionResponse;
  if (
    typeof data.fileId !== 'string' ||
    typeof data.sessionId !== 'string' ||
    data.format !== 'json' ||
    data.type !== 'notebook'
  ) {
    throw new Error(`Unexpected collaboration session response: ${JSON.stringify(data)}`);
  }

  return {
    fileId: data.fileId,
    sessionId: data.sessionId,
    serverPath,
    roomName: getCollabRoomName(data.fileId),
    roomUrl: getCollabRoomUrl(baseUrl, data.fileId, data.sessionId),
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function encodeJupyterApiPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}
