// Compatibility shim — the implementation lives in session-log-dispatcher.ts and
// per-provider readers under log-readers/. This re-export keeps existing call
// sites working during the multi-provider chat refactor. To be deleted in
// phase 7 once callers are renamed.
export { SessionLogDispatcher as SessionLogReader } from './session-log-dispatcher';
