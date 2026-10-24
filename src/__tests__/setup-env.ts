/**
 * Test environment defaults.
 *
 * The extension tests drive the real extension code with a mocked pi API. That
 * code appends to the metrics log (bd-140), and without this the suite writes
 * thousands of fixture events into the operator's real state directory. Tests
 * that assert on metrics set their own BELAYD_METRICS_DIR.
 */
process.env.BELAYD_METRICS = "0";
