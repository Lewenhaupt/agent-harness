/**
 * Tests for the deterministic finding-sensitivity classifier (bd-183).
 *
 * The bead's AC is a classifier table with three explicit groups — sensitive,
 * not sensitive, borderline — plus an answer-parsing table. Every rule in
 * `src/finding-sensitivity.ts` has a row here in both directions, because the
 * failure mode of this module is not a throw: it is silently classifying a
 * credential as "not sensitive" and publishing it.
 */

import { describe, expect, it } from "vitest";

import { projectFindingText } from "../finding-publication.js";
import {
  classifyFindingSensitivity,
  FINDING_CREDENTIAL_ANCHORS,
  FINDING_DENY_PATH_PATTERNS,
  type FindingSensitivityReasonKind,
  FindingSensitivitySchema,
  PUBLICATION_WITHHELD_BY_DEFAULT,
  PUBLICATION_WITHHELD_BY_HUMAN,
  PUBLICATION_WITHHELD_CONDITIONAL,
  parsePublicationAnswer,
  redactFindingToOneLiner,
} from "../finding-sensitivity.js";

describe("classifyFindingSensitivity — sensitive rows", () => {
  // One row per rule family; the `match` text is not asserted (only the kind),
  // so rewording a rule does not force a table rewrite, but a rule that stops
  // firing does.
  it.each([
    ["auth topic", "the authorization check is bypassed on the reset route"],
    ["auth topic (authentication)", "authentication failure is swallowed"],
    ["bearer mention", "hand-copied `Bearer` headers are trusted"],
    ["crypto topic", "the HMAC comparison is not constant time"],
    ["crypto topic (encrypt)", "encrypting with a reused IV"],
    ["secrets topic", "secrets are written to stdout on startup"],
    ["token topic", "the access token is never rotated"],
    ["session topic", "the cookie is set without HttpOnly"],
    ["env topic", "process.env is read at module load"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY----- leaked into a fixture"],
    ["api key topic", "the api key is logged on every request"],
    ["github token", "committed ghp_16C7e42F292c6912E7710c838347Ae178B4a in a test"],
    [
      "jwt",
      "logged eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["url userinfo", "the error contains postgres://appuser:s3cr3t@db.internal/app"],
    ["deny path .env", "`/.env` is committed"],
    ["deny path .env.local", "`.env.local` is committed"],
    ["deny path src/auth", "`src/auth/session.ts:42` — the token is not rotated"],
    ["deny path secrets/", "`secrets/prod.yaml` is world readable"],
  ])("treats a %s finding as sensitive", (_label, finding) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });
});

describe("classifyFindingSensitivity — borderline rows are sensitive", () => {
  // "Borderline = sensitive" is the documented rule: each of these is arguable,
  // and the classifier must take the gate instead of guessing. The reason kind is
  // asserted so a row cannot pass for the wrong reason (e.g. a `deny-path` row
  // firing through a security topic).
  it.each<[string, string, FindingSensitivityReasonKind]>([
    ["a bare Bearer mention", "the `Bearer` scheme is accepted on every route", "security-topic"],
    ["a workflow file", "`.github/workflows/ci.yml` publishes on every tag", "deny-path"],
    [
      "an assignment-shaped token",
      "token = 8f14e45fceea167a5a36dedd4bea2543 in the fixture",
      "credential-shaped",
    ],
    ["an example env file", "`.env.example` documents every variable", "deny-path"],
    ["an ssh key file name", "`id_rsa` sits in the repository root", "deny-path"],
    ["a sk- key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx shipped in a test", "credential-shaped"],
    ["a slack token", "xoxb-1234567890-abcdefghijkl leaked in the log", "credential-shaped"],
    ["an aws key id", "config uses AKIAIOSFODNN7EXAMPLE in the sample", "credential-shaped"],
    ["a credentials file", "`credentials.json` is committed", "deny-path"],
    ["an npmrc", "`.npmrc` carries the registry token", "deny-path"],
  ])("treats %s as sensitive (%s)", (_label, finding, kind) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons.map((reason) => reason.kind)).toContain(kind);
  });

  it("represents every reason kind across the table", () => {
    const kinds = new Set(
      [
        "`src/auth/session.ts:42` — session token is stale",
        "token = 8f14e45fceea167a5a36dedd4bea2543",
        "`secrets/prod.yaml` is readable",
        "`src/prоof/x.png` is unreviewed",
      ].flatMap((finding) =>
        classifyFindingSensitivity(finding).reasons.map((reason) => reason.kind),
      ),
    );
    expect([...kinds].sort()).toEqual([
      "credential-shaped",
      "deny-path",
      "security-topic",
      "unclassifiable-text",
    ]);
  });
});

describe("classifyFindingSensitivity — normalisation and the refuse rule", () => {
  // A homoglyph spelling is still the word to every reader of the finding, so a
  // rule table that only sees raw code points publishes the very text it was
  // built to withhold. Each row below published raw before the normalisation
  // pass existed.
  it.each<[string, string, FindingSensitivityReasonKind]>([
    ["fullwidth deny path", "ｓｒｃ/ａｕｔｈ/ｓｅｓｓｉｏｎ.ts:42", "deny-path"],
    ["fullwidth topic", "ＡＵＴＨＯＲＩＺＡＴＩＯＮ handling is wrong", "security-topic"],
    ["fullwidth dot in a deny path", "．ｅｎｖ", "deny-path"],
    [
      "fullwidth credential assignment",
      "ｔｏｋｅｎ = 8f14e45fceea167a5a36dedd4bea2543",
      "credential-shaped",
    ],
    ["zero-width inside a credential key", "pass\u200Bword = hunter2hunter2", "credential-shaped"],
    ["zero-width inside a topic word", "au\u200Bth bypasses the admin route", "security-topic"],
  ])("classifies a %s as sensitive through normalisation (%s)", (_label, finding, kind) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    const kinds = verdict.reasons.map((reason) => reason.kind);
    expect(kinds).toContain(kind);
    // Normalisation must do the work: a `unclassifiable-text` reason here would
    // mean the fold regressed and the row only passed through the refuse rule.
    expect(kinds).not.toContain("unclassifiable-text");
  });

  it("records the normalised match, so the gate reason stays readable", () => {
    const verdict = classifyFindingSensitivity("ＡＵＴＨＯＲＩＺＡＴＩＯＮ handling is wrong");
    expect(verdict.reasons.map((reason) => reason.match)).toContain("AUTHORIZATION");
  });

  it.each([
    ["a Cyrillic lookalike in a path", "`src/prоof/x.png` is unreviewed", "\\u{043E}"],
    ["a Cyrillic lookalike in a topic word", "`src/аuth/x.ts` is unguarded", "\\u{0430}"],
  ])("refuses %s instead of guessing", (_label, finding, escaped) => {
    // NFKC has no fold for these, so the finding goes to the human with the code
    // point named: guessing which lookalike is harmless is the bypass.
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons).toContainEqual({ kind: "unclassifiable-text", match: escaped });
  });

  it.each([
    ["an em dash", "`src/a.ts:12` — off-by-one in the loop bound"],
    ["an en dash", "`src/a.ts:12` – off-by-one in the loop bound"],
    ["an ellipsis", "the retry loop … allocates on every iteration"],
    ["curly quotes", "the “quoted” symbol is never released"],
    ["a non-breaking space", "non\u00A0breaking space in the prose"],
    ["a middle dot and a bullet", "`src/a.ts:12` · the · list bullet"],
  ])("publishes ordinary typography (%s) without a human answer", (_label, finding) => {
    // Typography cannot hide a keyword: these characters are not letter
    // lookalikes, and the keyword rules already match across them. Refusing them
    // would ask a disclosure question about every ordinary finding and bury the
    // real security question in noise.
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it.each([
    ["a path", "`src/café.png` fixture is stale"],
    ["a lone accent", "the naïve retry wrapper is gone"],
  ])("still sends unlisted non-ASCII in %s to the human", (_label, finding) => {
    // The allowlist is enumerated typography, not "any accented letter": an
    // accent outside it is text the rules will not read, so it is refused.
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons.map((reason) => reason.kind)).toEqual(["unclassifiable-text"]);
  });

  // One row per exempted class, each carrying a lookalike in the same finding:
  // the exemption must not become a place to hide a homoglyph spelling.
  it.each([
    ["a dash", "prоof — x.png is unreviewed", "\\u{043E}"],
    ["quotation marks", "“tokеn” is logged in plain text", "\\u{0435}"],
    ["an exotic space", "аuth\u00A0check is skipped", "\\u{0430}"],
    ["an inline mark", "§ sеcret is world readable", "\\u{0435}"],
  ])("still refuses a lookalike next to %s", (_label, finding, escaped) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons).toContainEqual({ kind: "unclassifiable-text", match: escaped });
  });

  it("de-duplicates and caps the offending characters it records", () => {
    const repeated = classifyFindingSensitivity("ааααаα");
    expect(repeated.reasons).toEqual([
      { kind: "unclassifiable-text", match: "\\u{0430} \\u{03B1}" },
    ]);

    const many = classifyFindingSensitivity("абвгдежзик");
    const reason = many.reasons.find((entry) => entry.kind === "unclassifiable-text");
    expect(reason?.match.split(" ")).toHaveLength(9);
    expect(reason?.match.endsWith("…")).toBe(true);
  });

  it("round-trips an unclassifiable-text verdict through the record schema", () => {
    // The kinds are single-sourced from the zod schema: a kind the disk validator
    // does not know discards the whole record ("no record" publishes nothing).
    const verdict = classifyFindingSensitivity("`src/prоof/x.png` is unreviewed");
    expect(FindingSensitivitySchema.safeParse(verdict).success).toBe(true);
    const reread = FindingSensitivitySchema.safeParse(JSON.parse(JSON.stringify(verdict)));
    expect(reread.success ? reread.data : undefined).toEqual(verdict);
  });
});

describe("classifyFindingSensitivity — hidden joins (compact pass)", () => {
  // Each row is a fail-open probe from the round-7 review: one benign-typography
  // character or layout newline splits a keyword, path or credential key, and the
  // primary pass (which keeps the separator, so ordinary prose tokenises as
  // written) cannot see either half as the word. The compact pass deletes the
  // separators and the union classifies. Asserting the kind keeps a row from
  // passing through a family that has nothing to do with the probe.
  it.each<[string, string, FindingSensitivityReasonKind]>([
    [
      "a middle dot in a credential key",
      "pass·word = hunter2hunter2 is used in prod",
      "credential-shaped",
    ],
    ["an em dash in a topic word", "au—th bypasses the admin route", "security-topic"],
    ["a section sign in a topic word", "tok§en never rotates", "security-topic"],
    ["a middle dot in a home directory", "~/.ss·h is world readable", "deny-path"],
    ["a middle dot in an ssh key name", "`id_rs·a` sits in the repository root", "deny-path"],
    ["a middle dot in a key extension", "`legacy.p·fx` is committed", "deny-path"],
    ["a middle dot in an npmrc", "`.np·mrc` carries the registry token", "deny-path"],
    ["a middle dot in a secrets path", "`secrets·/prod.yaml` is world readable", "deny-path"],
    [
      "a layout newline in a credential key",
      "pass\nword = hunter2hunter2 is documented",
      "credential-shaped",
    ],
  ])("classifies %s as sensitive (%s)", (_label, finding, kind) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons.map((reason) => reason.kind)).toContain(kind);
  });

  it("records the joined span and says the separators were removed", () => {
    // The gate record has to explain itself: the match is not verbatim in the
    // finding, because the separator was deleted for the rule pass.
    expect(
      classifyFindingSensitivity("pass·word = hunter2hunter2 is used in prod").reasons,
    ).toEqual([
      { kind: "credential-shaped", match: "password = hunter2hunter2 (separators removed)" },
    ]);
  });

  it("does not repeat a reason the primary pass already reported", () => {
    // The compact pass is a union, not a second opinion: a reason both passes see
    // (an assignment the em dash sits *after*) is recorded once, verbatim.
    const verdict = classifyFindingSensitivity(
      "password = 8f14e45fceea167a5a36dedd4bea2543 — in the fixture",
    );
    expect(verdict.reasons).toEqual([
      { kind: "credential-shaped", match: "password = 8f14e45fceea167a5a36dedd4bea2543" },
    ]);
  });
});

describe("classifyFindingSensitivity — the anchor rule", () => {
  // The rule that replaced reconstructing a split credential: an anchor is
  // meaningless without a secret behind it, so its presence *alone* is the
  // disclosure question. Each row asserts the kind and that the recorded match
  // shows the anchor, so a row cannot pass through an unrelated family.
  it.each<[string, string, FindingSensitivityReasonKind, string]>([
    ["a bare GitHub prefix", "ghp_ alone", "credential-shaped", "ghp_"],
    ["a bare AWS key id prefix", "AKIA alone", "credential-shaped", "AKIA"],
    ["a bare JWT header", "eyJ alone", "credential-shaped", "eyJ"],
    ["a bare ssh key name", "id_rsa alone", "deny-path", "id_rsa"],
    ["a bare dot-directory", "the .ssh folder is world readable", "deny-path", ".ssh"],
    ["a dot-directory path", "the .aws/config file", "deny-path", ".aws"],
    [
      "a quoted credential header",
      "authorization: bearer abcdefgh",
      "credential-shaped",
      "authorization: bearer",
    ],
    [
      "an API key prefix",
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx shipped in a test",
      "credential-shaped",
      "sk-",
    ],
    ["a PEM header", "-----BEGIN PRIVATE KEY----- leaked", "credential-shaped", "-----BEGIN"],
    ["an env file name", "`.env` is committed", "deny-path", ".env"],
    ["a credentials file", "`credentials.json` is committed", "deny-path", "credentials"],
    ["an npmrc", "`.npmrc` carries the registry token", "deny-path", ".npmrc"],
    [
      "an ssh public key header",
      "the deploy key starts ssh-rsa AAAAB3NzaC1yc2E",
      "credential-shaped",
      "ssh-rsa",
    ],
    [
      "a GitHub fine-grained token",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz leaked",
      "credential-shaped",
      "github_pat_",
    ],
    [
      "an AWS secret env var name",
      "the lambda prints secret_access_key on boot",
      "credential-shaped",
      "secret_access_key",
    ],
    [
      "a live-mode API key",
      "sk_live_ABCDEFGHIJKLMNOP was pasted into the ticket",
      "credential-shaped",
      "sk_live_",
    ],
    ["a Slack token", "xoxp-1234567890-abcdefghijkl leaked", "credential-shaped", "xoxp-"],
  ])("classifies %s as sensitive through the anchor", (_label, finding, kind, anchor) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    const reasons = verdict.reasons.filter((reason) => reason.kind === kind);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.map((reason) => reason.match).join(" ")).toContain(anchor);
  });

  it.each([
    ["alone", "the prefix ghp_ is committed"],
    ["directly attached to a token", "committed ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["followed by one space", "committed ghp_ 16C7e42F292c6912E7710c838347Ae178B4a"],
    ["followed by four words", "committed ghp_ 16C7 42F2 92c6 912e7710c838347Ae178B4a"],
    ["torn from its body", "the prefix is ghp_. the body is 16C7e42F292c6912E7710c838347Ae178B4a"],
    ["split inside the anchor", "gh p_16C7e42F292c6912E7710c838347Ae178B4a"],
  ])("classifies a `ghp_` anchor %s", (_label, finding) => {
    // What the bead requires: `ghp_` followed by anything must gate. A whitespace
    // split of the anchor itself is also caught, because the whitespace-deleted
    // reading rejoins it; no rule has to count words.
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons.map((reason) => reason.kind)).toContain("credential-shaped");
  });

  it.each([
    ["a punctuation insertion inside the anchor", "gh-p_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["a punctuation insertion inside a path", "rotate `id_rs/a` keys"],
  ])("does not classify %s (documented boundary)", (_label, finding) => {
    // The stated limit: an ASCII *punctuation* insertion produces a different
    // string, not a spaced or decorated one. Making the anchor fuzzy would make
    // every short anchor match everything, so this is left to the human.
    expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
  });

  it.each([
    ["a documentation mask", "AKIAXXXX is a placeholder in the README"],
    ["an angle-bracket template", "ghp_<token> appears in the docs"],
    ["a shell expansion template", `AKIA\${KEY} is expanded by the script`],
  ])("keeps %s out of the gate", (_label, finding) => {
    // The placeholder exemption predates the anchor rule and still holds: a
    // documented mask is not a key. A *bare* anchor is not a placeholder.
    expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
  });

  it("reports the whole token, not the bare anchor behind it", () => {
    // The anchor is a prefix of the shape it heads, so both are candidates; the
    // record keeps the specific one and drops the anchor it contains.
    const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
    expect(classifyFindingSensitivity(`committed ${token} in a test`).reasons).toEqual([
      { kind: "credential-shaped", match: token },
    ]);
  });
});

describe("classifyFindingSensitivity — the whitespace-deleted reading", () => {
  // The split moved to the easiest separator — a plain space. The third reading
  // deletes every whitespace character and runs only the shape families, because
  // welding every space would fabricate topic words out of a sentence. Each row
  // is one fail-open probe from an earlier round; the kind is asserted because the
  // bead's prose mapping called the path probes "credential-shaped" when they are
  // deny paths.
  it.each<[string, string, FindingSensitivityReasonKind]>([
    ["a space inside an ssh key name", "rotate id_rs a keys", "deny-path"],
    ["a space inside a key extension", "moved legacy.p em to backup", "deny-path"],
    ["a space inside an npmrc name", "the .np mrc file", "deny-path"],
    ["a space inside a deny path", "the secrets /prod.yaml file", "deny-path"],
    [
      "four spaces inside a GitHub token",
      "committed ghp_ 16C7 42F2 92c6912e7710c838347Ae178B4a in a test",
      "credential-shaped",
    ],
    [
      "a space inside an assignment key",
      "passw ord = hunter2hunter2 is used in prod",
      "credential-shaped",
    ],
    [
      "a space inside an unknown assignment key",
      "myk ey = 8f14e45fceea167a5a36dedd4bea2543 is committed",
      "credential-shaped",
    ],
    [
      "a layout newline inside a PEM header",
      "-----BEGIN RSA\nPRIVATE KEY----- leaked into a fixture",
      "credential-shaped",
    ],
    [
      "a doubled space inside a PEM header",
      "-----BEGIN RSA  PRIVATE KEY----- leaked into a fixture",
      "credential-shaped",
    ],
  ])("classifies %s as sensitive (%s)", (_label, finding, kind) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    const reasons = verdict.reasons.filter((reason) => reason.kind === kind);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it.each([
    ["an ssh key name", "rotate id_rs a keys"],
    ["a key extension", "moved legacy.p em to backup"],
    ["an npmrc name", "the .np mrc file"],
    ["a deny directory", "the secrets /prod.yaml file"],
    ["an assignment key", "passw ord = hunter2hunter2 is used in prod"],
  ])("says which reading found the split in %s", (_label, finding) => {
    // Only the whitespace-deleted reading can see these, so the record says so:
    // the match is not verbatim in the finding, and a reason the human cannot find
    // looks fabricated. (The `ghp_` and PEM rows carry no note — their primary
    // pattern is already whitespace-tolerant.)
    const matches = classifyFindingSensitivity(finding).reasons.map((reason) => reason.match);
    expect(matches.some((match) => match.includes("(whitespace removed)"))).toBe(true);
  });

  it("catches a spaced-out topic word through the compact pass, not the third", () => {
    // `au — th` is typography plus the spaces framing it, so the compact pass's
    // framed-separator deletion joins it; the whitespace-deleted reading never
    // runs topic rules, because welding ordinary prose words would gate every
    // review.
    expect(classifyFindingSensitivity("the au — th bypass")).toEqual({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth (separators removed)" }],
    });
  });

  it("never welds the topic families across a plain space", () => {
    // The restriction that keeps the third reading usable: a prose sentence is not
    // a string of joined words, so the match stays the single word the topic rule saw.
    for (const [finding, match] of [
      ["secrets are handled elsewhere", "secrets"],
      ["the session cookie is fine — see notes", "session"],
    ] as const) {
      expect(classifyFindingSensitivity(finding)).toEqual({
        sensitive: true,
        reasons: [{ kind: "security-topic", match }],
      });
    }
  });

  it("does not turn a line number and a sentence into an assignment", () => {
    // Welding deletes the only break between `line 42:` and the sentence that
    // follows it, and findings quote `path:line` constantly; without the location
    // guard and the entropy test those read as assignments.
    for (const finding of [
      "line 42: the loop allocates on every iteration",
      "src/a.ts:12 - off-by-one in the loop bound",
      "src/a.ts:12:3 - the loop allocates on every iteration",
    ]) {
      expect(classifyFindingSensitivity(finding), finding).toEqual({
        sensitive: false,
        reasons: [],
      });
    }
  });

  it("gates ordinary prose that names a bare token (documented trade)", () => {
    // The round-7 widening that made `tok§en` classify: a bare `token` is a
    // security topic. The cost is documented noise on prose that merely mentions
    // one; relaxing it would reopen the split, so it is pinned here.
    for (const finding of [
      "token bucket rate limiter is too small",
      "rename the token in the parser",
    ]) {
      expect(classifyFindingSensitivity(finding)).toEqual({
        sensitive: true,
        reasons: [{ kind: "security-topic", match: "token" }],
      });
    }
  });
});

describe("classifyFindingSensitivity — the compact pass leaves ordinary prose alone", () => {
  // Deleting separators must not invent words across a sentence boundary: a plain
  // space is still a word break, so ordinary house style keeps publishing.
  it.each([
    ["a code span and an em dash", "`src/a.ts:12` — off-by-one in the loop bound"],
    ["curly quotes around a word", "“quoted” note"],
  ])("still publishes %s without a human answer", (_label, finding) => {
    expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
  });

  it("keeps a prose `auth` mention sensitive, which predates the compact pass", () => {
    // The round-7 probe list expected "the auth flow — see the note" to publish. It
    // does not: `auth` is a security topic in the primary pass, and the round-6
    // classifier already returned the same verdict (verified before this change).
    // Relaxing it would be a classifier change, not a test fix, so the row is
    // pinned as sensitive and the deviation is reported instead.
    expect(classifyFindingSensitivity("the auth flow — see the note")).toEqual({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
  });
});

describe("classifyFindingSensitivity — not sensitive rows", () => {
  // Every row here is a finding the workflow may publish without a human answer.
  // The `author`/`sessionless`/`cryptic`/`envelope` rows pin the word boundaries:
  // without them a substring match would gate ordinary naming findings.
  it.each([
    ["off-by-one", "`src/a.ts:12` — off-by-one in the loop bound"],
    ["null check", "`src/b.ts:5` — missing null check"],
    ["naming", "naming: rename `foo` to `bar` for consistency"],
    ["performance", "the loop allocates on every iteration"],
    ["placeholder password", `password=\${DB_PASSWORD} is the documented sample`],
    ["placeholder token", "password=<token> is the documented shape"],
    ["masked placeholder", "password=xxxx in the example is fine"],
    ["redacted placeholder", "the fixture replaces the password with REDACTED"],
    ["placeholder aws key", "AKIAXXXX is a placeholder in the README"],
    ["the word author", "`src/author.ts` — the author name is truncated"],
    ["the word sessionless", "sessionless requests are allowed by design"],
    ["the word cryptic", "a cryptic error message hides the cause"],
    ["the word envelope", "the envelope wrapper swallows the error"],
    ["a plain path", "`src/review-findings.ts` grows past 400 lines"],
  ])("does not treat a %s finding as sensitive", (_label, finding) => {
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it("keeps `reasons` empty iff not sensitive for every table row", () => {
    for (const finding of [
      "`src/a.ts:12` — off-by-one in the loop bound",
      "`src/auth/session.ts:42` — the token is not rotated",
      "AKIAXXXX is a placeholder",
      "the access token is never rotated",
    ]) {
      const verdict = classifyFindingSensitivity(finding);
      expect(verdict.reasons.length > 0).toBe(verdict.sensitive);
    }
  });
});

describe("classifyFindingSensitivity — adversarial input", () => {
  it("reports every rule family that fires, not just the first", () => {
    // No early exit after a matching family: the human reading the gate is told
    // every reason the finding was stopped for, so a single finding carrying a
    // topic, a credential and a deny path must report all three.
    const verdict = classifyFindingSensitivity(
      "`src/auth/session.ts:42` — session token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged",
    );
    expect(verdict.sensitive).toBe(true);
    expect([...new Set(verdict.reasons.map((reason) => reason.kind))].sort()).toEqual([
      "credential-shaped",
      "deny-path",
      "security-topic",
    ]);
  });

  it("is deterministic and de-duplicates a repeated match", () => {
    // The reasons are persisted, so the same text must produce the same verdict
    // twice — and a repeated match must not be recorded twice.
    const finding = "auth is checked, auth again, and auth once more";
    const first = classifyFindingSensitivity(finding);
    expect(classifyFindingSensitivity(finding)).toEqual(first);
    expect(first.reasons).toEqual([{ kind: "security-topic", match: "auth" }]);
  });

  it("terminates on rule-shaped non-matching input of pathological length", () => {
    // ReDoS guard: these strings are made of rule-shaped fragments but match no
    // rule, which is the shape that makes a backtracking regex hang. No timing is
    // asserted (that would be flaky); the test suite's own timeout is the bound,
    // and the redactor must terminate on the same input.
    for (const [label, text] of [
      ["a scheme with no userinfo", `a://${"x".repeat(40_000)}`],
      ["scheme-like runs of colons", `a${":".repeat(40_000)}`],
      // The placeholder-span search must stay linear on an unterminated run.
      ["unterminated angle brackets", "<".repeat(40_000)],
    ] as const) {
      const verdict = classifyFindingSensitivity(text);
      expect(verdict, label).toEqual({ sensitive: false, reasons: [] });
      expect(redactFindingToOneLiner(text, 16).length, label).toBeLessThanOrEqual(16);
    }

    // A repeated PEM prefix is no longer "non-matching": `-----BEGIN` is an
    // anchor, so it is sensitive by rule. What the guard still pins is that the
    // scan terminates and the redactor ships nothing of it.
    const pemRun = "-----BEGIN ".repeat(4000);
    expect(classifyFindingSensitivity(pemRun).sensitive).toBe(true);
    expect(redactFindingToOneLiner(pemRun, 16)).toBe("[redacted]");
  });

  it("stays linear on a long finding and a long word list", () => {
    // The anchors are one alternation ({@link FINDING_CREDENTIAL_ANCHORS} compiled
    // once), read once per reading, so the scan is linear in the text with a
    // constant factor of the table size. The bound is generous on purpose (a slow CI
    // box must not flake the suite); the timings are reported so a regression is
    // visible in the log rather than only in a timeout.
    const longFinding = `audit note: ${"the loop allocates on every iteration. ".repeat(1800)}`;
    const longWords = `${"a ".repeat(10_000)}`;
    const timings: string[] = [];
    for (const [label, text, budget] of [
      ["60k-char finding", longFinding, 5_000],
      ["10k-word finding", longWords, 5_000],
    ] as const) {
      const startedAt = performance.now();
      const verdict = classifyFindingSensitivity(text);
      redactFindingToOneLiner(text);
      const elapsed = performance.now() - startedAt;
      timings.push(`${label}: ${elapsed.toFixed(1)}ms (${text.length} chars)`);
      expect(verdict.sensitive, label).toBe(false);
      expect(elapsed, label).toBeLessThan(budget);
    }
    console.log(`[bd-183 anchor scan] ${timings.join(", ")}`);
  });

  it("merges both passes into one deterministic reasons array", () => {
    // The union must not depend on Set iteration order: the record persists the
    // reasons, so 100 runs have to produce the same array in the same order.
    const finding = "pass·word = hunter2hunter2 — au—th tokens in secrets·/prod.yaml";
    const first = JSON.stringify(classifyFindingSensitivity(finding).reasons);
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(classifyFindingSensitivity(finding).reasons)).toBe(first);
    }
    // Both passes contribute, so this is not one pass repeated.
    expect(classifyFindingSensitivity(finding).reasons.length).toBeGreaterThan(1);
  });

  it("merges all three readings into one deterministic reasons array", () => {
    // The union must not depend on Set iteration order: the record persists the
    // reasons, so 100 runs have to produce the same array in the same order. This
    // finding has one reason from the compact reading and one from the
    // whitespace-deleted reading.
    const finding = "au — th bypass and committed ghp_ 16C7e42F292c6912E7710c838347Ae178B4a";
    const first = JSON.stringify(classifyFindingSensitivity(finding).reasons);
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(classifyFindingSensitivity(finding).reasons)).toBe(first);
    }
    const matches = classifyFindingSensitivity(finding).reasons.map((reason) => reason.match);
    expect(matches).toContain("auth (separators removed)");
    // The `ghp_` anchor is torn from its body by the space, so the primary
    // reading sees only the anchor and the whitespace-deleted reading finds the
    // joined shape; whichever fires, the record must be the same every run.
    expect(matches).toContain("ghp_");
  });

  it("records a spaced credential once when its unbroken form is reported", () => {
    // De-duplication is by kind plus the whitespace-free match, so the joined view
    // of a credential the primary pass already caught — including the same shape
    // with the next word welded on — is not recorded a second time.
    const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
    const verdict = classifyFindingSensitivity(`${token} and rotated ghp_ ${token.slice(4)}`);
    expect(verdict.reasons).toEqual([{ kind: "credential-shaped", match: token }]);
  });

  it("masks a credential whose value is split across lines", () => {
    // A finding is markdown, so a credential can arrive wrapped. Both shapes must
    // still be masked; no masked line may retain a run long enough to be a token
    // body (the credential rules all require at least 16 characters).
    const splitToken = "ghp_16C7e42F292c6912E7710c83\n8347Ae178B4a";
    expect(classifyFindingSensitivity(splitToken).sensitive).toBe(true);
    const maskedToken = redactFindingToOneLiner(splitToken);
    expect(maskedToken).toContain("[redacted]");
    expect(maskedToken).not.toContain("ghp_");
    expect(maskedToken).not.toMatch(/[A-Za-z0-9]{16,}/u);

    const splitAssignment = "token =\n8f14e45fceea167a5a36dedd4bea2543";
    expect(classifyFindingSensitivity(splitAssignment).sensitive).toBe(true);
    expect(redactFindingToOneLiner(splitAssignment)).not.toContain(
      "8f14e45fceea167a5a36dedd4bea2543",
    );
  });
});

describe("BENIGN_TYPOGRAPHY and the NFKC fold", () => {
  it("relies on the fold, not the allowlist, for the ellipsis and exotic spaces", () => {
    // why: those four entries were unreachable — normalizeFindingText NFKC-folds
    // them to ASCII before either isBenignTypography call site — so they were
    // dropped from the set. This test pins the fold: a normalisation change would
    // otherwise re-purpose the removal as a silent regression.
    expect("…".normalize("NFKC")).toBe("...");
    expect("\u00A0".normalize("NFKC")).toBe(" ");
    expect("\u202F".normalize("NFKC")).toBe(" ");
    expect("\u2009".normalize("NFKC")).toBe(" ");
  });

  it("still publishes a finding that uses one of those characters", () => {
    for (const finding of [
      "the retry loop … allocates on every iteration",
      "non\u00A0breaking space in the prose",
      "a\u202Fparagraph break in the prose",
      "a\u2009thin space in the prose",
    ]) {
      expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
    }
  });
});

describe("FINDING_DENY_PATH_PATTERNS", () => {
  it("covers the documented credential and auth-tree set", () => {
    // The set is part of the contract bd-183 documents; a removal is a behaviour
    // change, not a refactor.
    for (const pattern of [
      ".env",
      "*.pem",
      "*.key",
      "id_rsa",
      "id_ed25519",
      "secrets/",
      ".aws/",
      ".ssh/",
      "credentials",
      "src/auth/",
      "src/crypto/",
      "src/secrets/",
      "src/session/",
      ".github/workflows/",
    ]) {
      expect(FINDING_DENY_PATH_PATTERNS).toContain(pattern);
    }
  });

  it("gates a path that only ends at a deny directory (documented widening)", () => {
    // Round 7 widened a directory pattern to a token that ends at the directory,
    // because `~/.ssh` with no trailing slash is still the credential store. The
    // cost is that a path merely *ending* there also gates; accepted, one
    // question, fail-closed.
    const verdict = classifyFindingSensitivity("`wiki/src/auth` is stale");
    expect(verdict.reasons.map((reason) => reason.kind)).toContain("deny-path");
  });
});

describe("FINDING_CREDENTIAL_ANCHORS", () => {
  it("covers the documented anchor families", () => {
    // The set is the contract `docs/bd-183-userguide.md` documents; a removal is a
    // behaviour change, not a refactor.
    const anchors = FINDING_CREDENTIAL_ANCHORS.map((entry) => entry.anchor);
    for (const anchor of [
      "ghp_",
      "gho_",
      "ghu_",
      "ghs_",
      "ghr_",
      "github_pat_",
      "akia",
      "asia",
      "sk-",
      "sk_live_",
      "xoxb-",
      "xoxp-",
      "xoxa-",
      "xoxr-",
      "xoxs-",
      "eyj",
      "-----begin",
      "-----end",
      "private key",
      "id_rsa",
      "id_ed25519",
      "ssh-rsa",
      "authorization: bearer",
      ".pem",
      ".key",
      ".env",
      ".npmrc",
      "credentials",
      ".ssh",
      ".aws",
      "secret_access_key",
    ]) {
      expect(anchors).toContain(anchor);
    }
  });

  it.each(FINDING_CREDENTIAL_ANCHORS)(
    "classifies a bare %s anchor as $kind",
    ({ anchor, kind }) => {
      // One row per table entry: an anchor nothing matches is dead weight in a
      // gate table, and the kind decides whether the record reads as a credential
      // or a path. A bare anchor is never a placeholder, so this must fire.
      const verdict = classifyFindingSensitivity(`the audit noted ${anchor} here`);
      expect(verdict.sensitive).toBe(true);
      expect(verdict.reasons.map((reason) => reason.kind)).toContain(kind);
    },
  );

  it("folds case but reports the substring it found", () => {
    // `AKIA` and `akia` are the same anchor; the record shows what was in the text
    // so the human can find it.
    expect(classifyFindingSensitivity("the sample uses akia in a config").reasons).toContainEqual({
      kind: "credential-shaped",
      match: "akia",
    });
  });
});

describe("classifyFindingSensitivity — split invariance (property)", () => {
  // The durable guard against round-after-round archaeology: a separator inserted
  // anywhere in a secret must not change the verdict. The rows below are the shapes
  // every earlier round tried to split; the separators are the classes the three
  // readings are written for (whitespace, typography, invisible characters) plus a
  // Cyrillic homoglyph, which is `unclassifiable-text` but must still be sensitive.
  const SECRETS = [
    ["a GitHub token", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["an AWS key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a PEM header", "-----BEGIN RSA PRIVATE KEY-----"],
    [
      "a JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["a URI with a password", "postgres://appuser:s3cr3t@db.internal/app"],
    ["an ssh key name", "id_rsa"],
    ["an env file", ".env"],
  ] as const;

  // why not `.`: an ASCII punctuation insertion inside an anchor is a different
  // string, not a spaced one — the documented boundary, pinned by the next test.
  const SEPARATORS = [" ", "\t", "\n", "—", "·", "\u200B", "р"] as const;

  it.each(SECRETS)("stays sensitive for every separator position of %s", (_label, secret) => {
    for (const separator of SEPARATORS) {
      for (let position = 0; position <= secret.length; position += 1) {
        const variant = `${secret.slice(0, position)}${separator}${secret.slice(position)}`;
        const verdict = classifyFindingSensitivity(`audit note: ${variant} in the log`);
        expect(
          verdict.sensitive,
          `${JSON.stringify(separator)} at ${position} of ${secret} → ${JSON.stringify(variant)}`,
        ).toBe(true);
      }
    }
  });

  it("documents the punctuation boundary: `.` inside an anchor is a different string", () => {
    // A `.` inserted between the letters of an anchor breaks the anchor itself, and
    // making the anchor fuzzy would make every short anchor match everything. The
    // miss is harmless by construction: on the publish path the projection either
    // masks the token body or, when the body was split into innocuous chunks,
    // redacts the whole finding ({@link findReassemblyViolations}).
    for (const finding of [
      "gh.p_16C7e42F292c6912E7710c838347Ae178B4a",
      "AK.IAIOSFODNN7EXAMPLE",
      "id.rsa sits in the repository root",
    ]) {
      expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
    }
    // A `.` anywhere *outside* the anchor still classifies, so this is a narrow
    // boundary rather than a general way to blind the rules.
    for (const finding of [
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a.",
      "committed ghp_16C7e42F292c6912E838.347Ae178B4a",
    ]) {
      expect(classifyFindingSensitivity(finding).sensitive, finding).toBe(true);
    }
  });

  it.each([
    ["a comma", ","],
    ["a semicolon", ";"],
  ])(
    "misses a %s-split anchor in the rules, and the projection masks the body anyway",
    (_label, separator) => {
      // Punctuation inside an anchor is the documented boundary for the *rules* (a
      // fuzzy anchor would match every short anchor against everything). The miss
      // decides nothing here: the contiguous body still trips the opaque-run rule, so
      // the token becomes `[value]` instead of reaching the line. Pinned because the
      // separator classes the two property tests carry differ by exactly this one —
      // the publication invariance list includes `.`, `,` and `;`, the classifier's
      // does not — so the seam must be visible where it is claimed.
      const token = "16C7e42F292c6912E7710c838347Ae178B4a";
      const finding = `leaked g${separator}hp_${token} in the log`;
      expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
      expect(projectFindingText(finding)).toBe(`leaked g${separator}[value] in the log`);
      expect(projectFindingText(finding)).not.toContain(token);
    },
  );

  it("leaves a whitespace-chunked body unclassified but unprojectable", () => {
    // Round-10 Critical, stated where the classifier's boundary is documented: the
    // chunks are 15/11/10 characters, so no rule — contiguous or welded — sees the
    // body. That miss does not decide publication: deleting the spaces from the
    // projected line reassembles the body, and the projection then redacts the whole
    // finding (`finding-publication.test.ts` pins the rendered result).
    const chunked = "the fixture stores gh.p_ 16C7e42F292c691 2E7710c8383 47Ae178B4a verbatim";
    expect(classifyFindingSensitivity(chunked)).toEqual({ sensitive: false, reasons: [] });
    expect(projectFindingText(chunked)).toBe("[redacted]");
  });
});

describe("classifyFindingSensitivity — round-9 Criticals", () => {
  it.each([
    ["angle brackets", "ghp_<16C7e42F292c6912E7710c838347Ae178B4a> leaked in the fixture"],
    ["a shell expansion", `ghp_\${16C7e42F292c6912E7710c838347Ae178B4a} leaked in the fixture`],
  ])("gates a pasted token wrapped in %s", (_label, finding) => {
    // The placeholder exemption only covers a template whose *inner* body is a
    // documented mask/word/name. A pasted 16+ body is the secret with a wrapper on
    // it, so it gates and the one-liner is the wholesale marker.
    const verdict = classifyFindingSensitivity(finding);
    expect(verdict.sensitive).toBe(true);
    expect(verdict.reasons.map((reason) => reason.kind)).toContain("credential-shaped");
    const oneLiner = redactFindingToOneLiner(finding);
    expect(oneLiner).toBe("[redacted]");
    expect(oneLiner).not.toContain("16C7e42F292c6912E7710c838347Ae178B4a");
  });

  it("keeps a documented template exempt", () => {
    // The other direction of the same rule: `ghp_<token>` and `AKIA${KEY}` are how
    // documentation spells a key, so they must not gate.
    for (const finding of [
      "ghp_<token> appears in the docs",
      `AKIA\${KEY} is expanded by the script`,
      "ghp_<REDACTED> appears in the docs",
    ]) {
      expect(classifyFindingSensitivity(finding), finding).toEqual({
        sensitive: false,
        reasons: [],
      });
    }
  });

  it("redacts wholesale when a lookalike sits inside an opaque run", () => {
    // `ghр_` (Cyrillic er) breaks the anchor, so the finding is sensitive only as
    // `unclassifiable-text`; masking the single code point would ship the body.
    const finding = "ghр_16C7e42F292c6912E7710c838347Ae178B4a";
    expect(classifyFindingSensitivity(finding).reasons.map((reason) => reason.kind)).toContain(
      "unclassifiable-text",
    );
    expect(redactFindingToOneLiner(finding)).toBe("[redacted]");
    expect(redactFindingToOneLiner(finding)).not.toContain("16C7e42F292c6912E7710c838347Ae178B4a");
  });

  it("keeps masking a prose lookalike that is not inside a run", () => {
    // The cost of the rule is bounded: `café`/`prоof` have no 16+ body behind them,
    // so they stay maskable rather than forcing the wholesale marker.
    expect(redactFindingToOneLiner("the prоof directory — is unread")).toBe(
      "the pr?of directory — is unread",
    );
    expect(redactFindingToOneLiner("update the naïve café fixture")).toBe(
      "update the na?ve caf? fixture",
    );
  });
});

describe("classifyFindingSensitivity — the two-character-class signal", () => {
  it.each([
    ["a numeric port", "port = 1234567890123456"],
    ["a numeric timeout", "timeout=30000000000000000"],
    ["a uuid", "uuid = 550e8400-e29b-41d4-a716-446655440000"],
    ["a line number after a path", "src/a.ts:1234567890123456789"],
  ])("publishes %s without a human answer", (_label, finding) => {
    // An all-digit run is a number and a UUID is an identifier; neither is a
    // disclosure question. Before the two-character-class signal both gated, and a
    // gate that fires on configuration noise is one the operator learns to skip.
    expect(classifyFindingSensitivity(finding)).toEqual({ sensitive: false, reasons: [] });
  });

  it("still gates a key-less assignment with a mixed-class body", () => {
    // The other direction: hex/base32/base64 bodies mix a digit with a letter, so
    // they keep gating even when the key name is split or unknown. A commit sha
    // gating is the accepted cost of not reading the key (docs/bd-183-userguide.md).
    for (const finding of [
      "sha = 0123456789abcdef0123456789abcdef",
      "myk ey = 8f14e45fceea167a5a36dedd4bea2543 is committed",
      "wrapped = 0123456789abcdefABCDEF0123456789",
    ]) {
      expect(classifyFindingSensitivity(finding).sensitive, finding).toBe(true);
    }
  });
});

describe("classifyFindingSensitivity — suppression cost", () => {
  it("stays linear on repeated anchors (the quadratic-suppression guard)", () => {
    // Round 9 measured 2.9 s at 20k repeats. Two quadratic terms were removed:
    // the containment scan (exact de-duplication by kind + case-folded match now
    // collapses the repeats before any comparison) and the unbounded URL-scheme
    // quantifier in the url-userinfo rule (a bounded scheme is linear on the same
    // text). The bounds are generous on purpose; the timings are reported.
    const timings: string[] = [];
    const measure = (text: string): { elapsed: number; sensitive: boolean } => {
      const startedAt = performance.now();
      const verdict = classifyFindingSensitivity(text);
      return { elapsed: performance.now() - startedAt, sensitive: verdict.sensitive };
    };
    // Short units on purpose: the repeats are the load, not the surrounding prose,
    // and a smaller text keeps the suite's total CPU (and with it every other
    // timing-sensitive suite) in budget.
    const nonMatching = "xx yy ".repeat(20_000);
    const baseline = measure(nonMatching);
    expect(baseline.sensitive).toBe(false);
    const durations: number[] = [];
    for (const repeats of [5_000, 10_000, 20_000]) {
      const text = "sk- ".repeat(repeats);
      const measured = measure(text);
      expect(measured.sensitive).toBe(true);
      const elapsed = measured.elapsed;
      durations.push(elapsed);
      timings.push(`${repeats} repeats (${text.length} chars): ${elapsed.toFixed(1)}ms`);
    }
    timings.push(
      `non-matching baseline (${nonMatching.length} chars): ${baseline.elapsed.toFixed(1)}ms`,
    );
    console.log(`[bd-183 suppression cost] ${timings.join(", ")}`);
    // 4x the input must not cost more than linearly more: the old scan doubled the
    // per-character cost at every step.
    const smallest = Math.max(1, durations[0] ?? 1);
    const largest = durations[2] ?? smallest;
    // Linear: 4x the input → ~4x the time. Quadratic: ~16x. The bound sits between
    // them so load noise cannot flip it, and only a regression can.
    expect(largest / smallest).toBeLessThan(10);
    expect(largest).toBeLessThan(3_000);
  });
});

describe("parsePublicationAnswer", () => {
  it.each([
    ["publish", "publish"],
    ["publish it", "publish"],
    ["publish this", "publish"],
    ["publish as-is", "publish"],
    ["publish it as is", "publish"],
    ["publish it as-is", "publish"],
    ["include it", "publish"],
    ["ship it", "publish"],
    ["redact", "redact"],
    ["redact it", "redact"],
    ["redacted please", "redact"],
    ["publish redacted", "redact"],
    ["publish a redacted one-liner", "redact"],
    ["publish the redacted version", "redact"],
    ["summarize it", "redact"],
    ["summarise the finding", "redact"],
    ["one-liner", "redact"],
    ["withhold", "withhold"],
    ["withhold it", "withhold"],
    ["withheld", "withhold"],
    ["no", "withhold"],
    ["skip it", "withhold"],
    ["do not publish", "withhold"],
    ["don't publish it", "withhold"],
  ])("records %j as %s", (answer, expected) => {
    expect(parsePublicationAnswer(answer)).toMatchObject({ kind: expected, source: "human" });
  });

  it("accepts trailing punctuation, surrounding quotes, and a `please`", () => {
    for (const answer of ["publish it.", "  Publish it!  ", "'publish it'", "Withhold."]) {
      expect(parsePublicationAnswer(answer).source).toBe("human");
    }
  });

  it("does not read bare `as is` or bare `include` as publish permission", () => {
    // Both are plausible answers to the disposition question on the same comment;
    // only the option label (`publish as-is` / `include it`) releases a finding
    // (bd-183 review).
    for (const answer of ["as is", "as is, please", "as-is please", "include"]) {
      expect(parsePublicationAnswer(answer)).toEqual({
        kind: "withhold",
        source: "default",
        reason: PUBLICATION_WITHHELD_BY_DEFAULT,
      });
    }
    // The labelled forms still publish.
    for (const answer of ["publish as-is", "publish it as is", "include it"]) {
      expect(parsePublicationAnswer(answer)).toMatchObject({ kind: "publish", source: "human" });
    }
  });

  it("records a human withhold for the option label, not a default withhold", () => {
    // The source distinguishes "the human said withhold" from "we could not read
    // the reply": only the latter is re-askable, and the gate reason differs.
    expect(parsePublicationAnswer("do not publish")).toEqual({
      kind: "withhold",
      source: "human",
      reason: PUBLICATION_WITHHELD_BY_HUMAN,
    });
  });

  it("defaults to withhold for conditional or temporal replies", () => {
    // A conditional yes is not a yes: recording it would release every sensitive
    // finding in the record immediately (bd-183 review, Warning).
    for (const answer of [
      "publish after we rotate the key",
      "publish once CI clears",
      "if CI passes, publish",
      "not yet",
      "publish when the build is green",
      "maybe later",
    ]) {
      expect(parsePublicationAnswer(answer)).toEqual({
        kind: "withhold",
        source: "default",
        reason: PUBLICATION_WITHHELD_CONDITIONAL,
      });
    }
  });

  it("defaults to withhold for any text that is not one of the three options", () => {
    for (const answer of [
      "",
      "   ",
      "lgtm",
      "I'll think about it",
      "yes, ship it",
      "publish the release",
      "never publish this",
      "publish no",
      "no — withhold",
      "publish but only the redacted version",
      "redact the credential",
      "withhold — do not publish",
    ]) {
      expect(parsePublicationAnswer(answer)).toEqual({
        kind: "withhold",
        source: "default",
        reason: PUBLICATION_WITHHELD_BY_DEFAULT,
      });
    }
  });

  it("records the human's own words for an accepted reply", () => {
    const decision = parsePublicationAnswer("publish it");
    expect(decision.kind).toBe("publish");
    if (decision.kind !== "publish") throw new Error("expected a publish decision");
    expect(decision.source).toBe("human");
    expect(decision.answer).toBe("publish it");
  });

  it("returns a redact decision without a one-liner (filled per finding)", () => {
    // The redaction depends on the finding text, not on the answer, so parsing
    // cannot produce it; an empty one-liner is treated as withheld downstream.
    expect(parsePublicationAnswer("redact")).toEqual({
      kind: "redact",
      source: "human",
      answer: "redact",
      oneLiner: "",
    });
  });
});

describe("redactFindingToOneLiner", () => {
  it("masks a credential shape and redacts the code span that held the path", () => {
    const finding =
      "`src/auth/session.ts:42` — the session token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";
    const oneLiner = redactFindingToOneLiner(finding);
    expect(oneLiner).toContain("[redacted]");
    expect(oneLiner).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
    expect(oneLiner).not.toContain("src/auth/session.ts");
  });

  it("tags a deny-set path with [path]", () => {
    const oneLiner = redactFindingToOneLiner("secrets/prod.yaml is world readable");
    expect(oneLiner).toContain("[path]");
    expect(oneLiner).not.toContain("secrets/prod.yaml");
  });

  it("drops URLs and redacts fenced blocks", () => {
    const oneLiner = redactFindingToOneLiner(
      ["see https://internal.example/secret for details", "```", "key=abc", "```"].join("\n"),
    );
    expect(oneLiner).not.toContain("internal.example");
    expect(oneLiner).not.toContain("key=abc");
    expect(oneLiner).toContain("[redacted]");
  });

  it("collapses whitespace and caps by code point with the ellipsis in the cap", () => {
    const oneLiner = redactFindingToOneLiner(`a\n\nb   c ${"word ".repeat(80)}`, 24);
    expect(oneLiner.startsWith("a b c word")).toBe(true);
    expect(Array.from(oneLiner).length).toBeLessThanOrEqual(24);
    expect(oneLiner.endsWith("…")).toBe(true);
  });

  it("never returns raw sensitive text, and never an empty string", () => {
    expect(redactFindingToOneLiner("`src/auth/x.ts`")).toBe("[redacted]");
    expect(redactFindingToOneLiner("   ")).toBe("[redacted]");
    for (const finding of [
      "-----BEGIN PRIVATE KEY----- leaked",
      "postgres://appuser:s3cr3t@db.internal/app",
      "token = 8f14e45fceea167a5a36dedd4bea2543",
    ]) {
      const oneLiner = redactFindingToOneLiner(finding);
      expect(oneLiner).toContain("[redacted]");
      expect(oneLiner).not.toContain("s3cr3t");
      expect(oneLiner).not.toContain("8f14e45fceea167a5a36dedd4bea2543");
    }
  });

  it("returns [redacted] wholesale when a separator hid a credential or deny path", () => {
    // Neither line matches in the primary pass: the bullet/hidden dot splits the
    // token, so the fragment a normal mask would keep *is* the secret. A wholesale
    // marker beats guessing which separator hid it.
    for (const finding of [
      "secrets·/prod.yaml is world readable",
      "ghp_•16C7e42F292c6912E7710c838347Ae178B4a leaked in the fixture",
    ]) {
      expect(redactFindingToOneLiner(finding)).toBe("[redacted]");
    }
  });

  it("returns [redacted] wholesale when a space split a credential", () => {
    // The round-8 Critical: the finding is sensitive for an ordinary reason (the
    // `·` separator makes the compact pass fire), and masking only what is visible
    // would ship `ghp_` plus the split-off token body. The output must be the
    // marker alone, so neither the body nor a whitespace-free version survives.
    const finding = "rotate keys · also committed ghp_ 16C7e42F292c6912E7710c838347Ae178B4a";
    const oneLiner = redactFindingToOneLiner(finding);
    expect(oneLiner).toBe("[redacted]");
    expect(oneLiner).not.toContain("16C7e42F292c6912E7710c838347Ae178B4a");
    expect(oneLiner.replace(/\s+/gu, "")).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
  });

  it("over-fires on wrapped prose rather than miss a split path (documented)", () => {
    // `item.p` + newline + `em` is prose, not a path, but the compact pass reads
    // `item.pem`. Fail-closed noise: one extra question, and the note says why.
    expect(classifyFindingSensitivity("the item.p\nem probe").reasons).toEqual([
      { kind: "deny-path", match: "item.pem (separators removed)" },
    ]);
  });

  it("redacts every round-8 leak case wholesale", () => {
    // Each of these shipped the secret verbatim before the anchor rule: two splits
    // longer than any join window, a PEM header torn by a layout newline or a
    // doubled space, and an assignment whose *key* was split. The output must be
    // the marker alone — neither the body nor a whitespace-free form of it.
    const secrets = ["16C7e42F292c6912E7710c838347Ae178B4a", "hunter2hunter2", "PRIVATE KEY"];
    for (const finding of [
      "committed ghp_ 16C7 42F2 92c6912e7710c838347Ae178B4a in a test",
      "the prefix is ghp_. the body 16C7e42F292c6912E7710c838347Ae178B4a leaks",
      "-----BEGIN RSA\nPRIVATE KEY----- leaked",
      "-----BEGIN RSA  PRIVATE KEY----- leaked",
      "passw ord = hunter2hunter2 is used",
    ]) {
      const oneLiner = redactFindingToOneLiner(finding);
      expect(oneLiner, finding).toBe("[redacted]");
      for (const secret of secrets) {
        expect(oneLiner, finding).not.toContain(secret);
        expect(oneLiner.replace(/\s+/gu, ""), finding).not.toContain(secret);
      }
    }
  });

  it("keeps the cap on the wholesale marker", () => {
    const oneLiner = redactFindingToOneLiner("secrets·/prod.yaml is world readable", 4);
    expect(Array.from(oneLiner).length).toBeLessThanOrEqual(4);
    expect(oneLiner).not.toContain("prod");
  });

  it("keeps its dashes when the primary pass already masked the secret", () => {
    // Ordinary typography is not removed from an approved one-liner; only a hidden
    // join forces the wholesale marker.
    expect(
      redactFindingToOneLiner("token = 8f14e45fceea167a5a36dedd4bea2543 — in the fixture"),
    ).toBe("[redacted] — in the fixture");
  });

  it("leaves a safe finding intact", () => {
    expect(redactFindingToOneLiner("the loop allocates on every iteration")).toBe(
      "the loop allocates on every iteration",
    );
  });

  it("masks a credential written in fullwidth Latin", () => {
    // The classifier refuses a fullwidth credential, so the one-liner the human
    // may approve must not carry it either: the token becomes `[redacted]` and no
    // non-ASCII survives into the approved line.
    const oneLiner = redactFindingToOneLiner("ｔｏｋｅｎ = 8f14e45fceea167a5a36dedd4bea2543");
    expect(oneLiner).toContain("[redacted]");
    expect(oneLiner).not.toContain("8f14e45fceea167a5a36dedd4bea2543");
    expect(oneLiner).not.toMatch(/[^\u0020-\u007E]/u);
  });

  it("replaces leftover lookalikes but keeps ordinary typography", () => {
    // A lookalike is by definition unreadable to the classifier, so it becomes `?`
    // in the redacted line; typography is kept, because dropping an em dash is
    // obfuscation rather than information removal.
    const withLookalike = redactFindingToOneLiner("the prоof directory — is unread");
    expect(withLookalike).toBe("the pr?of directory — is unread");
    expect(withLookalike).not.toMatch(/\p{Script=Cyrillic}/u);

    const withDashes = redactFindingToOneLiner(
      "token = 8f14e45fceea167a5a36dedd4bea2543 — in the fixture",
    );
    expect(withDashes).toBe("[redacted] — in the fixture");
  });
});
