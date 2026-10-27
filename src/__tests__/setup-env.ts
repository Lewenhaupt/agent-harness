/**
 * Test environment defaults.
 *
 * The extension tests drive the real extension code with a mocked pi API. That
 * code appends to the metrics log (bd-140), and without this the suite writes
 * thousands of fixture events into the operator's real state directory. Tests
 * that assert on metrics set their own BELAYD_METRICS_DIR.
 */
process.env.BELAYD_METRICS = "0";

/**
 * No test may reach the operator's live pi-web.
 *
 * The fleet supervisor pins its own session through the pi-web web server, and a
 * session's environment carries PI_WEB_PORT — so an inherited value would make
 * `pnpm test` read and write the real navigation preferences of whoever ran it.
 * Clearing it here turns pinning into the documented no-op (the same shape as a
 * plain `pi` CLI run, which has no web server at all).
 */
process.env.PI_WEB_PORT = "";
