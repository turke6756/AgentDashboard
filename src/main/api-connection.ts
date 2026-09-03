import type { ApiConnection } from '../shared/types';
import { getApiToken } from './security/api-auth';

export interface ApiConnectionGate {
  ready: Promise<ApiConnection>;
  publish(connection: ApiConnection): void;
}

export function createApiConnectionGate(): ApiConnectionGate {
  let publish!: (connection: ApiConnection) => void;
  const ready = new Promise<ApiConnection>((resolve) => {
    publish = resolve;
  });
  return { ready, publish };
}

interface StartableApiServer {
  start(): Promise<number>;
}

interface ApiPortPublisher {
  setApiServerPort(port: number): void;
}

export async function startApiAndPublishPort(
  apiServer: StartableApiServer,
  supervisor: ApiPortPublisher,
  gate: ApiConnectionGate,
): Promise<ApiConnection> {
  const port = await apiServer.start();
  supervisor.setApiServerPort(port);
  const connection = { port, token: getApiToken() };
  gate.publish(connection);
  return connection;
}
