export { default } from "./JsonPane.jsx";
// Keys that matter in THIS lab's payloads, on top of JsonPane's defaults (sub, act, aud, scope, client_id, iss, cnf, grant_type, tokens):
// the HTTP status, the two signed headers (session, delegation) and who the Company says the caller is.
export const POPPY_HOT = ["status", "session", "poppy-session", "delegation", "agent_id", "session_id", "user_id", "scopes"];
