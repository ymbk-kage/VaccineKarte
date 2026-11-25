// Worker entry point (Design §6). The logic lives in App.js; only the default handler is exported here
// because the Workers runtime rejects non-handler named exports (e.g. constants) in the main module.
import { createApp } from "./App.js";

// Isolate-wide app instance (holds the JWKS, token and sheet caches)
const app = createApp();

export default {
  /**
   * Workers fetch entry point.
   */
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
