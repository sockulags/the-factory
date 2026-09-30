/** Sent by every client request so the server can reject outdated clients. */
export const CLIENT_VERSION_HEADER = "x-factory-client-version";

/** HTTP status the server answers with when the client is below the minimum version. */
export const CLIENT_TOO_OLD_STATUS = 426;
