// Worker tests reach the database through the TEST_SQL proxy, never `pg`; vitest.config.ts
// aliases `pg` here because its CommonJS build doesn't load in the test runtime.
export default {
  Client: class {
    constructor() {
      throw new Error("pg isn't available in Worker tests; use the TEST_SQL proxy");
    }
  },
};
