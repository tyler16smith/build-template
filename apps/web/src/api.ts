import { createApiClient } from "@template/api-client";
import { onApiError, organization } from "./organization";

/**
 * The web app's client: same origin, the session cookie, no base URL. The signed-in screens use
 * `appApi` (`agents.ts`), the same client plus the agents' sockets, which loads with them.
 */
export const api = createApiClient({ organization, onError: onApiError });
