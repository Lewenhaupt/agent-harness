/**
 * Deterministic sensitivity classification for review findings (bd-183).
 *
 * Publishing a deferred finding is a disclosure decision, so a finding that
 * touches credentials, auth, crypto, sessions or environment handling must
 * never reach a PR body on the model's own judgement. The classifier is
 * therefore **rule-based and pure**: the same orchestrator model that wrote the
 * finding cannot decide that it is safe, because the answer is a function of the
 * finding text and a rule table, not of a prompt.
 *
 * **Borderline is sensitive.** When any rule matches, `sensitive` is `true`;
 * there is no "maybe" branch and no confidence score. The gate costs one human
 * answer; a wrongly published credential cannot be un-published. The rules are
 * deliberately over-inclusive (an assignment shaped `token: value` is secret
 * shaped even when the value is prose), and every rule carries the reason it
 * fired so the human reading the gate sees which rule stopped it.
 *
 * The text the rules read is **normalised first** ({@link normalizeFindingText}),
 * because matching raw code points lets a homoglyph spelling walk past every
 * rule: `ＡＵＴＨＯＲＩＺＡＴＩＯＮ` and `prоof` (Cyrillic `о`) are still auth and
 * still proof to any reader, so they must classify as such.
 *
 * Four rule families:
 *
 * 1. **Security topics** — word-boundary matches for the auth / crypto / secret
 *    / session / env vocabulary. Word boundaries are what keep `author` and
 *    `sessionless` out: a finding about authorship is not a security finding.
 *    A topic word alone is not enough: it must be paired with a disclosure-risk
 *    signal (bypass, injection, plaintext, exposure, …), because "the sessions
 *    map is written without a lock" and "process.env is read twice" are
 *    reliability findings, not publication questions (bd-252).
 * 2. **Credential-shaped strings** — private key blocks, cloud and forge token
 *    prefixes, JWTs, bearer headers, URI userinfo, `key = value` assignments and
 *    a credential noun beside a sink or a broken lifecycle (`secrets are written
 *    to stdout`, `the access token is never rotated`). A documented placeholder
 *    (`xxxx`, `REDACTED`, `<token>`, `${VAR}`) is not a credential: those shapes
 *    appear in documentation, and flagging them would make the gate noise the
 *    operator learns to skip.
 * 3. **Deny paths** — the path tokens a finding names are checked against
 *    {@link FINDING_DENY_PATH_PATTERNS}; a bare filename is a candidate too, so
 *    `id_rsa` is caught without a directory prefix.
 * 4. **Unclassifiable text** — whatever is left outside printable ASCII after
 *    normalisation and outside {@link BENIGN_TYPOGRAPHY}, restricted to code
 *    points that can carry a hidden word (Unicode letters, marks and numbers).
 *    There is no reliable mapping for lookalikes, so letterlike text is refused,
 *    not guessed (the doctrine `src/publish-gate.ts` applies to paths).
 *    Typography and non-letterlike symbols are exempt because punctuation, an
 *    arrow or an emoji cannot spell a keyword; refusing them would turn every
 *    ordinary finding into a disclosure question and hide the real one (bd-252).
 *
 * **A separator is not an escape hatch, so the text is read three times.**
 * A separator between letters is a hidden join, not a word boundary: `pass·word`,
 * `au — th`, `pass\nword` and `ghp_ 16C7…` are `password`, `auth`, `password` and
 * a GitHub token to every reader, including whoever reads the PR body.
 *
 * 1. The **primary pass** reads the normalised text as written.
 * 2. The **compact pass** ({@link compactClassificationText}) deletes benign
 *    typography, layout whitespace and the whitespace framing a typographic
 *    separator, then runs every family over the result.
 * 3. The **whitespace-deleted pass** ({@link weldedClassificationText}) deletes
 *    every whitespace character and runs the shape families over the result,
 *    which crosses *any* number of spaces at once (`passw ord = …`,
 *    `secrets /prod.yaml`, `id_rs a`).
 *
 * **The rule that replaced reconstruction is the anchor rule.** Asking "did I
 * rebuild the credential?" cannot be won: round 8 showed that every join window
 * of N words is escaped by a split into N+1. Asking "does the text contain a
 * credential **anchor**?" can, because an anchor — `ghp_`, `AKIA`, `-----BEGIN`,
 * `PRIVATE KEY`, `.ssh`, `.env`, `authorization: bearer`, and the rest of
 * {@link FINDING_CREDENTIAL_ANCHORS} — is *meaningless without a secret behind
 * it*. Its presence alone is therefore the disclosure question, and nothing has
 * to be reassembled for the rule to fire. Anchors are matched on all three
 * readings, so no split can move one out of view. Over-matching is an extra
 * human question (naming `ghp_` in prose now gates); under-matching publishes a
 * token.
 *
 * The readings are unioned and each reason's `match` says which reading fired.
 * **Not claimed:** an ASCII *punctuation* insertion inside an anchor or a shape
 * (`ghp_16C7-…`, `gh-p_16C7…`) is a different string, and a secret with no
 * anchor at all (a bare hex blob, indistinguishable from a commit id) is not
 * classified — both are stated in `docs/bd-183-userguide.md`.
 *
 * Also the downstream safety surface for the human's answer:
 * {@link parsePublicationAnswer} maps free-text answers deterministically and
 * strictly — only a reply that *is* one of the three options the gate names is
 * recorded, so a conditional or partial yes withholds — and
 * {@link redactFindingToOneLiner} produces the publishable redacted line.
 * `src/finding-publication.ts` re-derives what may be published from the durable
 * record using these functions.
 *
 * **This classifier is advisory, and the guarantee is elsewhere.** It decides
 * whether to *ask a human*, not whether text is safe to publish. "Is this string a
 * secret?" is unbounded pattern recognition against an adversary who can insert
 * separators, homoglyphs or brackets — every review round found another evasion —
 * so the publish path no longer depends on the answer: `projectFindingText` projects
 * every deferred finding to a shape with no code span, path token or non-ASCII text,
 * and redacts wholesale a body whose reassembled reading welds into a token run; a
 * body with no class mixing is the named residual. An over-match costs one question.
 *
 * Pure: text in, verdict out. No I/O, no throwing. The zod schemas at the top are
 * the same declarations `src/review-findings.ts` validates the record with, so
 * the writer and the disk validator cannot drift.
 */

import { z } from "zod";

/**
 * The reason kinds, as a zod schema; the TS type is derived from it.
 *
 * **Single-sourced on purpose** (bd-183 review): the record on disk is validated
 * by these same schemas, so a new kind cannot type-check in one place and fail
 * `safeParse` in the other — which would discard the whole record, taking the
 * round count and an in-flight wait's findings with it.
 */
export const FindingSensitivityReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("security-topic"), match: z.string() }),
  z.object({ kind: z.literal("credential-shaped"), match: z.string() }),
  z.object({ kind: z.literal("deny-path"), match: z.string() }),
  z.object({ kind: z.literal("unclassifiable-text"), match: z.string() }),
]);

/** One rule that fired, plus the text that triggered it. */
export type FindingSensitivityReason = z.infer<typeof FindingSensitivityReasonSchema>;

/** The kind alone, for callers that report or assert which rule family fired. */
export type FindingSensitivityReasonKind = FindingSensitivityReason["kind"];

/**
 * The verdict for one finding: `reasons` is empty iff `sensitive` is false.
 *
 * The `.refine()` keeps that invariant on the record read back from disk too: a
 * verdict that breaks it cannot be interpreted (sensitive with no reason cannot
 * be shown to a human, reasons without sensitivity contradict themselves), so the
 * record reads as absent — fail-closed, because "no record" publishes nothing.
 */
export const FindingSensitivitySchema = z
  .object({
    sensitive: z.boolean(),
    reasons: z.array(FindingSensitivityReasonSchema),
  })
  .refine((value) => value.sensitive === value.reasons.length > 0, {
    message: "reasons must be non-empty iff sensitive",
  });

/** The verdict for one finding. */
export type FindingSensitivity = z.infer<typeof FindingSensitivitySchema>;

/** One security-topic rule: a single regex, matched once per finding. */
interface SecurityTopicRule {
  id: string;
  pattern: RegExp;
  /**
   * Ignore a match that sits inside a documentation placeholder (`<token>`,
   * `${TOKEN}`, `{{ token }}`).
   *
   * why: only the `tokens` rule needs it — a placeholder span is a documentation
   * shape, not a credential mention — while the other topic words stay
   * sensitive wherever they appear.
   */
  skipPlaceholderSpans?: boolean;
}

/** One credential-shaped rule; `secretPrefix` is the non-secret part of a match. */
interface CredentialShapedRule {
  id: string;
  pattern: RegExp;
  /** Carries no entropy (a token prefix or an assignment key); stripped first. */
  secretPrefix?: RegExp;
}

/**
 * The auth / crypto / secret / session / env vocabulary, in a fixed order so the
 * reasons a record carries are stable across runs (they are persisted).
 *
 * Each entry is a word-boundary match. `\bauth(?:…)?\b` deliberately does not
 * match `author`/`authority`, and `\bsessions?\b` does not match `sessionless`.
 */
const SECURITY_TOPIC_RULES: readonly SecurityTopicRule[] = [
  {
    id: "auth",
    // why: the auth family is the broadest security topic, and `\b` is what
    // keeps "author" (a normal review word) out of the gate.
    pattern:
      /\bauth(?:entication|enticated|enticate|orization|orized|orize|[sz]ation|[sz]ed|[sz]e)?\b/iu,
  },
  {
    id: "auth-scheme",
    // why: a bare `Bearer` mention is how findings quote a credential header;
    // the token itself is often elided, so the scheme is the only signal left.
    pattern: /\bbearers?\b/iu,
  },
  {
    id: "crypto",
    // why: `crypt` with a boundary matches crypto/cryptography but not "cryptic"
    // (the boundary fails inside the word), which keeps prose out.
    pattern:
      /\b(?:crypt(?:o|ography|ographic|ographically)?|encrypt(?:ion|ed|ing|s)?|decrypt(?:ion|ed|ing|s)?|cipher(?:text|s)?|hmac|kdf|pbkdf2|bcrypt|scrypt|argon2)\b/iu,
  },
  {
    id: "secrets",
    // why: secret/credential/api key are the nouns findings use for a leak; a
    // bare "password" is intentionally NOT here so a documented placeholder
    // assignment (`password=${DB_PASSWORD}`) stays non-sensitive.
    pattern: /\b(?:secrets?|credentials?|api[-_ ]?keys?)\b/iu,
  },
  {
    id: "tokens",
    // why: a token name is a credential mention even without an assignment (a
    // finding saying `token never rotates` is about a credential). The optional
    // qualifier keeps the compound form (`access token`) as one readable match,
    // and placeholder spans are skipped so the documented `password=<token>`
    // shape the credential rules deliberately ignore is not re-flagged here.
    pattern: /\b(?:(?:access|refresh|auth|session|bearer|api|private)[-_ ]?)?tokens?\b/iu,
    skipPlaceholderSpans: true,
  },
  {
    id: "session",
    // why: session material (cookie/jwt/oauth) is bearer authority: leaking it
    // in a PR body is a disclosure even when no token literal is quoted.
    pattern: /\b(?:sessions?|cookies?|jwt|jwk|oauth2?|csrf|sso)\b/iu,
  },
  {
    id: "env",
    // why: environment handling is where secrets live; `\benv\b` covers
    // `process.env` and "env var" without matching "envelope".
    pattern: /\b(?:env|environment(?:al|ally)?|dotenv)\b/iu,
  },
];

/** One disclosure-risk signal: the word family and the regex that finds it. */
interface DisclosureRiskRule {
  id: string;
  pattern: RegExp;
}

/**
 * Words that turn a security *topic* into a disclosure question (bd-252).
 *
 * why a second table: a topic word alone describes an area of the code, not a
 * leak. "the sessions map is written without a lock" is a concurrency defect,
 * and gating it cost bd-233 two full workflow stalls. A risk word names what
 * went wrong, so the pair is the signal that the PR body may expose something.
 *
 * Deliberately **excluded**: reliability and concurrency vocabulary (`race`,
 * `lock`, `retry`, `timeout`, `deadlock`, `leak` of a goroutine/connection is
 * covered only by the word itself, which is accepted over-match), generic
 * logging verbs without a sink (`log`, `writes`), and severity words (`bug`,
 * `failure`). They describe defects, not disclosure, and are the false positives
 * this floor exists to remove. Credentials, deny paths and anchors stay
 * unconditional: those *are* the real signal, so they do not need this table.
 */
const DISCLOSURE_RISK_RULES: readonly DisclosureRiskRule[] = [
  {
    id: "bypass",
    // why: an auth-check bypass is a security defect regardless of the topic
    // word that names it.
    pattern: /\bbypass(?:es|ed|ing)?\b/iu,
  },
  {
    id: "injection",
    // why: SQL/command/header injection is where untrusted data crosses a trust
    // boundary; the word names the defect, not the area.
    pattern: /\binject(?:s|ed|ing|ion|ions)?\b/iu,
  },
  {
    id: "web-vulnerability",
    // why: XSS/CSRF/SSRF have no innocent reading in a review finding.
    pattern: /\b(?:xss|csrf|ssrf)\b/iu,
  },
  {
    id: "leak",
    // why: "leaked" is the direct statement that material escaped; leakage is
    // the same claim as a noun.
    pattern: /\bleak(?:s|ed|ing|age|ages)?\b/iu,
  },
  {
    id: "exposure",
    // why: expose/exposed/exposure name the disclosure act itself.
    pattern: /\bexpos(?:e|es|ed|ing|ure|ures)\b/iu,
  },
  {
    id: "disclosure",
    // why: disclose/disclosed/disclosure is the same act from the other side.
    pattern: /\bdisclos(?:e|es|ed|ing|ure|ures)\b/iu,
  },
  {
    id: "plaintext",
    // why: a secret in plaintext/cleartext is exposed by definition.
    pattern: /\b(?:plain|clear)[- ]?text\b/iu,
  },
  {
    id: "in-the-clear",
    // why: the idiomatic form carries the same claim as plaintext.
    pattern: /\bin the clear\b/iu,
  },
  {
    id: "hardcoded",
    // why: a hard-coded key/password is committed material, not a topic mention.
    pattern: /\bhard[- ]?cod(?:e|ed|es|ing)\b/iu,
  },
  {
    id: "traversal",
    // why: path traversal is an input-validation defect with a direct data-access
    // consequence.
    pattern: /\btraversal\b/iu,
  },
  {
    id: "escalation",
    // why: privilege escalation is an authorization defect; the topic word alone
    // (auth) would not distinguish it from a naming finding.
    pattern: /\bescalat(?:e|es|ed|ing|ion|ions)\b/iu,
  },
  {
    id: "spoofing",
    // why: spoof/spoofed names identity forgery, not a topic area.
    pattern: /\bspoof(?:s|ed|ing)?\b/iu,
  },
  {
    id: "vulnerability",
    // why: vulnerable/vulnerability is how a security defect is reported.
    pattern: /\bvulnerab(?:le|ility|ilities)\b/iu,
  },
  {
    id: "exploit",
    // why: an exploit is the concrete abuse path, not the code area.
    pattern: /\bexploit(?:s|ed|ing|able|ables)?\b/iu,
  },
  {
    id: "unauthenticated",
    // why: unauthenticated access is an auth bypass in one word.
    pattern: /\bunauthenticated\b/iu,
  },
  {
    id: "unauthorized",
    // why: unauthorized access is the consequence an auth finding publishes.
    pattern: /\bunauthori[sz]ed\b/iu,
  },
  {
    id: "misconfiguration",
    // why: a misconfiguration is a concrete exposure path, unlike the config area
    // itself (`env` alone).
    pattern: /\bmisconfig(?:uration|urations|ured|ure|ures)?\b/iu,
  },
  {
    id: "timing",
    // why: a constant-time defect is a real crypto finding; the word pair names
    // the attack, while `crypto` alone only names the module.
    pattern: /\b(?:timing[- ]attack|constant[- ]time)\b/iu,
  },
  {
    id: "replay",
    // why: replay is a concrete token/session abuse path.
    pattern: /\breplay(?:s|ed|ing)?\b/iu,
  },
  {
    id: "exfiltration",
    // why: exfiltration states that data left the boundary, which is disclosure.
    pattern: /\bexfiltrat(?:e|es|ed|ing|ion)\b/iu,
  },
];

/** One credential noun; the shared prefix every sink/lifecycle rule reads. */
const CREDENTIAL_NOUN_SOURCE =
  "(?:secrets?|credentials?|tokens?|api[-_ ]?keys?|passwords?|private keys?)";

/**
 * Containers that hold the credential itself, so the compound is still its subject.
 *
 * why closed: `the credential cache is written to disk` is the credential reaching
 * disk, so it is a disclosure, while `token usage`/`token count`/`token bucket`
 * describe metrics or state the credential is not the subject of. Only this list
 * may sit between the noun and the sink verb.
 */
const CREDENTIAL_CONTAINER_SOURCE = "(?:cache|store|material|contents)";

/**
 * The subject a sink/lifecycle rule reads: the credential noun, or the credential
 * noun plus its closed container noun (`credential cache`), or the
 * `session material` idiom the topic table names the same way.
 */
const CREDENTIAL_SUBJECT_SOURCE =
  `(?:${CREDENTIAL_NOUN_SOURCE}\\s+${CREDENTIAL_CONTAINER_SOURCE}` +
  `|${CREDENTIAL_NOUN_SOURCE}` +
  "|sessions?\\s+material)";

/** One credential-sink rule: a credential noun beside a sink or lifecycle break. */
interface CredentialSinkRule {
  id: string;
  pattern: RegExp;
}

/** One concrete sink verb: the participle a disclosure phrase ends on. */
const SINK_PARTICIPLE_SOURCE =
  "(?:written|logged|printed|echoed|dumped|leaked|exposed|revealed|swallowed)";

/**
 * Auxiliary verbs a sink phrase may chain before the participle — and only these.
 *
 * why bounded and closed: an open chain is a character window in disguise. No
 * negation token is listed, so a negated sink can only reach the lifecycle arm.
 */
const SINK_AUXILIARY_SOURCE =
  "(?:is|are|was|were|has|have|had|will|would|can|could|may|might|should|must|gets?|got|be|been|being)";

/**
 * Adverbs allowed between the auxiliary chain and the participle.
 *
 * why closed: `the token is accidentally logged` is the same disclosure as `is
 * logged`, but a free adverb slot would let `is never logged` through again.
 */
const SINK_ADVERB_SOURCE =
  "(?:silently|still|also|only|then|now|accidentally|apparently|currently|always|sometimes)";

/**
 * Credential nouns beside a concrete sink or a broken lifecycle (bd-252).
 *
 * why this family and not more risk words: the risk floor exists so a bare topic
 * word (`sessions`, `env`) is not a disclosure question, but a credential noun
 * used as the subject of "written to stdout", "logged", "swallowed" or
 * "never rotated" is the bd-183 regression class — the secret is named and its
 * handling says it escaped or was never contained. A bare output verb in the risk
 * table would re-open AC1 (`the sessions map is written without a lock`), so the
 * compound phrase is the signal instead.
 *
 * why literal adjacency and no character window (bd-252 round-2 review): a window
 * lets any noun-ish subject plus any output verb in the same clause gate. The
 * credential noun must be the sink's *subject*: no other word can sit between it
 * and the verb beyond a bounded auxiliary chain and one closed adverb.
 * `token usage is logged for metrics`, `the password reset flow writes audit rows`
 * and `the token rotate helper is never called` therefore stay out, while the
 * round-1 W1 pins stay in.
 *
 * why the two arms are separate grammars (bd-252 round-3 review): the sink arm has
 * to accept auxiliary chains — `is being logged`, `has been logged`, `will be
 * logged`, `can be logged` — or a critic's ordinary paraphrase of `is logged`
 * walks back out as publishable. The lifecycle arm is the opposite: negation is
 * the signal there (`never rotated` is a defect), so `never|not|no longer` lives
 * only in that arm. In the sink arm a negated sink (`the api key is never logged`)
 * is an *absence* claim, so putting negation in the sink arm gated exactly the
 * findings that say the credential did not escape.
 *
 * Deliberately **excluded**: a sink verb whose subject is not the credential noun
 * (the review's `token bucket`, `token usage`, `password reset flow`, `token
 * rotate helper` rows), a sink verb with no credential noun in the same phrase
 * (`the sessions map is written without a lock`), and generic lifecycle prose
 * (`the token bucket is full`). Those are reliability findings, not disclosures.
 * The reasons are `credential-shaped` because a named credential used as the
 * subject of a sink or lifecycle break is the same real signal as a token shape.
 */
const CREDENTIAL_SINK_RULES: readonly CredentialSinkRule[] = [
  {
    id: "output",
    // why: "secrets are written to stdout", "the api key is logged" and
    // "the access token was leaked" say the credential itself reached an
    // observer. An auxiliary chain (`is being`, `has been`, `will be`, `can be`)
    // and up to two closed, non-negating adverbs may sit between the noun and
    // the sink verb — nothing else, and no negation token.
    pattern: new RegExp(
      `\\b${CREDENTIAL_SUBJECT_SOURCE}\\b\\s+` +
        `(?:${SINK_AUXILIARY_SOURCE}\\s+){0,3}` +
        `(?:${SINK_ADVERB_SOURCE}\\s+){0,2}` +
        `${SINK_PARTICIPLE_SOURCE}\\b`,
      "iu",
    ),
  },
  {
    id: "lifecycle",
    // why: a credential that is never rotated/expired/revoked is a lifecycle
    // break even when no literal leaks in the finding. Only the negation form is
    // accepted, so "the token rotate helper is never called" does not match: the
    // noun must be the subject of the negated lifecycle verb.
    pattern: new RegExp(
      `\\b${CREDENTIAL_SUBJECT_SOURCE}\\b\\s+` +
        "(?:(?:is|are|was|were|gets?|got|be|been)\\s+)?" +
        "(?:never|no longer|not)\\s+" +
        "(?:rotated|rotates|expires|expire|invalidated|revoked)\\b",
      "iu",
    ),
  },
];

/**
 * Credential-shaped string rules. Order is fixed for the same reason as above.
 *
 * Every match is passed through {@link isPlaceholderSecret} first, so a
 * documented placeholder (`ghp_xxxx…`, `AKIAXXXX`, `<token>`, `${VAR}`) does not
 * classify. That is the difference between a usable gate and one that fires on
 * every doc snippet.
 */
const CREDENTIAL_SHAPED_RULES: readonly CredentialShapedRule[] = [
  {
    id: "private-key-block",
    // why whitespace-tolerant: a PEM header wraps (`-----BEGIN RSA\nPRIVATE
    // KEY-----`) and a copy-paste doubles a space. A literal single-space pattern
    // is a one-character bypass, and — because the compact pass welds a layout
    // newline into `RSAPRIVATE` — a space-requiring pattern could never match the
    // welded reading either. The header is the only part of a PEM block a rule can
    // recognize, so it must match however it is laid out.
    pattern: /-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY\s*-----/gu,
  },
  {
    id: "private-key-block-end",
    // why the `\s*` spelling: the footer inherits the same wrapping (and the same
    // doubled-space paste) as the header; matching only the header would leave a
    // finding that quotes the tail of a key unclassified.
    pattern: /-----END\s*(?:[A-Z0-9]+\s*)?PRIVATE\s+KEY\s*-----/gu,
  },
  {
    id: "aws-access-key-id",
    // why: AWS key ids are fixed-prefix + 16 base32 chars; the prefix is
    // entropy-free, so it is stripped before the placeholder check.
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|ANPA|ANVA|AROA|AIPA|APKA)[A-Z0-9]{16}\b/gu,
    secretPrefix: /^(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|ANPA|ANVA|AROA|AIPA|APKA)/u,
  },
  {
    id: "github-token",
    // why: every GitHub token family has a fixed prefix; matching the prefix
    // only (not the whole token) keeps the reason readable in the record.
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
    secretPrefix: /^(?:gh[pousr]_|github_pat_)/u,
  },
  {
    id: "api-key",
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/gu,
    secretPrefix: /^sk-(?:ant-|proj-)?/u,
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
    secretPrefix: /^xox[baprs]-/u,
  },
  {
    id: "jwt",
    // why: a JWT is three dot-separated base64url segments and always starts
    // with the base64 of `{"`; that prefix is the shape, not a guess.
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  },
  {
    id: "bearer-token",
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    secretPrefix: /^bearer\s+/iu,
  },
  {
    id: "url-userinfo",
    // why: `scheme://user:pass@host` carries the password in the URI, which is
    // the most common way a connection string leaks into a finding.
    // why the bounded scheme: an unbounded `[a-z0-9+.-]*` re-scans to the end of
    // the text from every word boundary that a hyphen or dot creates, which is
    // quadratic on `x-x-x-…` (measured: 20k units → 774 ms). An RFC 3986 scheme is
    // at most a handful of characters, so bounding it is free and keeps the scan
    // linear.
    pattern: /\b[a-z][a-z0-9+.-]{0,32}:\/\/[^\s/:@]+:[^\s/@]+@/giu,
  },
  {
    id: "credential-assignment",
    // why: an assignment is secret-shaped even when the value is prose; the
    // placeholder guard is what lets documentation through.
    pattern:
      /\b(?:password|passwd|pwd|api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|token)\s*[:=]\s*(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[A-Za-z0-9._~+/=!@#$%^&*-]{8,})/giu,
    secretPrefix: /^[\w-]+\s*[:=]\s*["']?/u,
  },
];

/**
 * Paths that are sensitive by location alone.
 *
 * Patterns: a trailing `/` is a directory prefix (matched at the start of the
 * token or after a `/`, so `~/.ssh/id_rsa` hits `.ssh/`), `*.x` is an extension
 * on the basename, `x.*` is a basename prefix with a suffix, and anything else
 * is an exact basename. The set covers credential stores, key material, and the
 * source trees where auth/session/crypto logic lives (a finding naming one of
 * those is a pointer to the sensitive code, whatever the words say).
 */
export const FINDING_DENY_PATH_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_dsa",
  "id_dsa.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "credentials",
  "credentials.*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws/",
  ".ssh/",
  ".gnupg/",
  ".docker/",
  ".kube/",
  ".config/gh/",
  "secrets/",
  "src/auth/",
  "src/crypto/",
  "src/secrets/",
  "src/session/",
  ".github/workflows/",
] as const;

/** One credential or deny anchor: the substring, and which family it belongs to. */
export interface CredentialAnchor {
  /** Lower-case anchor text; matching is case-insensitive. */
  anchor: string;
  kind: "credential-shaped" | "deny-path";
}

/**
 * The anchor table: a substring with no innocent reading in a review finding.
 *
 * This is the rule that replaced reconstructing a split credential. Round 8
 * proved the window approach cannot win — every join of N words is escaped by a
 * split into N+1 — so the classifier stops asking "did I rebuild the token?" and
 * asks "does the text contain an anchor?". An anchor is meaningless without a
 * secret behind it, so its presence *alone* is the disclosure question and no
 * pass has to put the pieces back together. That is why a split in either
 * direction (`ghp_ 16C7…`, `the prefix is ghp_. the body …`) cannot hide it.
 *
 * Matching is case-insensitive and **boundary-free**: in a whitespace-deleted
 * reading there are no boundaries left to trust, and any boundary requirement is
 * exactly the hole a split walks through. The reported `match` is the found
 * substring with its original case, so the gate record shows what the classifier
 * actually saw.
 *
 * The cost is over-match and it is accepted: a finding that merely *names*
 * `ghp_`, `ASIA` or `credentials` in prose now takes the human route, and so
 * does prose containing `sk-` (`risk-free`, `task-oriented`). One extra question
 * is cheap; a published token is not. A documented placeholder body (`AKIAXXXX`,
 * `ghp_<token>`) is still exempt — see {@link isPlaceholderAnchorOccurrence}.
 *
 * Deliberately **not** covered: an ASCII punctuation insertion inside the anchor
 * itself (`gh-p_16C7…`). That is a different string, not a spaced one; making
 * the anchor fuzzy would make every short anchor match everything.
 */
export const FINDING_CREDENTIAL_ANCHORS: readonly CredentialAnchor[] = [
  // Forge tokens: each family has a fixed prefix that carries no entropy.
  { anchor: "ghp_", kind: "credential-shaped" },
  { anchor: "gho_", kind: "credential-shaped" },
  { anchor: "ghu_", kind: "credential-shaped" },
  { anchor: "ghs_", kind: "credential-shaped" },
  { anchor: "ghr_", kind: "credential-shaped" },
  { anchor: "github_pat_", kind: "credential-shaped" },
  // Cloud key ids: `AKIA`/`ASIA` are AWS access-key-id prefixes.
  { anchor: "akia", kind: "credential-shaped" },
  { anchor: "asia", kind: "credential-shaped" },
  // SaaS API keys.
  { anchor: "sk-", kind: "credential-shaped" },
  { anchor: "sk_live_", kind: "credential-shaped" },
  // Slack token families.
  { anchor: "xoxb-", kind: "credential-shaped" },
  { anchor: "xoxp-", kind: "credential-shaped" },
  { anchor: "xoxa-", kind: "credential-shaped" },
  { anchor: "xoxr-", kind: "credential-shaped" },
  { anchor: "xoxs-", kind: "credential-shaped" },
  // A JWT's first three bytes: base64url of `{"`. Nothing else starts `eyJ`.
  { anchor: "eyj", kind: "credential-shaped" },
  // PEM private-key headers, either end and in any spelling.
  { anchor: "-----begin", kind: "credential-shaped" },
  { anchor: "-----end", kind: "credential-shaped" },
  { anchor: "private key", kind: "credential-shaped" },
  // The header a quoted SSH public key starts with.
  { anchor: "ssh-rsa", kind: "credential-shaped" },
  // The header findings paste from a proxy log.
  { anchor: "authorization: bearer", kind: "credential-shaped" },
  // The env var name every AWS SDK reads the secret from.
  { anchor: "secret_access_key", kind: "credential-shaped" },
  // Key material and credential stores, named with no path needed.
  { anchor: "id_rsa", kind: "deny-path" },
  { anchor: "id_ed25519", kind: "deny-path" },
  { anchor: ".pem", kind: "deny-path" },
  { anchor: ".key", kind: "deny-path" },
  { anchor: ".env", kind: "deny-path" },
  { anchor: ".npmrc", kind: "deny-path" },
  { anchor: ".ssh", kind: "deny-path" },
  { anchor: ".aws", kind: "deny-path" },
  { anchor: "credentials", kind: "deny-path" },
] as const;

/** Default cap for a redacted one-liner; matches the comment-excerpt spirit. */
const ONE_LINER_DEFAULT_MAX_CHARS = 160;

/** At most this many code points of the human's answer are recorded verbatim. */
const PUBLICATION_ANSWER_MAX_CHARS = 200;

/** Ellipsis counted inside the cap, exactly like `excerptComment`. */
const ELLIPSIS = "…";

/** The record clause for a human who chose to withhold. */
export const PUBLICATION_WITHHELD_BY_HUMAN =
  "the human withheld permission to publish this finding";

/** The record clause for an answer the parser could not read (fail closed). */
export const PUBLICATION_WITHHELD_BY_DEFAULT =
  "no publication choice was recognized; the finding stays withheld";

/**
 * The record clause for a conditional/temporal reply ("publish after …").
 *
 * Kept distinct from the by-default clause so the gate can say the answer was
 * seen but not actionable now: a conditional yes is not a yes.
 */
export const PUBLICATION_WITHHELD_CONDITIONAL =
  "the reply was conditional or not one of the three publication options; the finding stays withheld";

/**
 * The publication decision, as a zod schema; the TS type is derived from it.
 *
 * Single-sourced with the record validator for the same reason as
 * {@link FindingSensitivityReasonSchema}: a new `source` must not diverge between
 * the writer and the disk schema.
 */
export const FindingPublicationDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publish"), source: z.literal("human"), answer: z.string() }),
  z.object({
    kind: z.literal("redact"),
    source: z.literal("human"),
    answer: z.string(),
    oneLiner: z.string(),
  }),
  z.object({
    kind: z.literal("withhold"),
    source: z.enum(["human", "default"]),
    reason: z.string(),
  }),
]);

/**
 * What a human said about publishing one sensitive finding.
 *
 * `publish` carries the raw text; `redact` carries the `oneLiner` only (the raw
 * finding must never be substituted back in); `withhold` is the default and the
 * fail-closed answer for anything unparseable.
 */
export type FindingPublicationDecision = z.infer<typeof FindingPublicationDecisionSchema>;

/** Docs-facing placeholder words: a value equal to one of these is not a secret. */
const PLACEHOLDER_WORD_PATTERN =
  /^(?:redacted|redact|changeme|change[-_ ]?me|example|placeholder|password|passwd|pwd|secret|token|key|value|dummy|sample|string|none|null|undefined|todo|fixme)$/iu;

/**
 * A bracketed template span: `<token>`, `${DB_PASSWORD}`, `{{ token }}`, or one of
 * the projection markers (`[redacted]`, `[path]`).
 *
 * The inner body is captured so it can be judged on its own: a template is only a
 * placeholder when what is *inside* it is a name, a mask or a word. Anchored, and
 * bounded like {@link PLACEHOLDER_SPAN_PATTERN} so an unterminated run stays
 * linear.
 */
const BRACKETED_PLACEHOLDER_PATTERN =
  /^(?:<([^>\n]{0,200})>|\$\{([^}\n]{0,200})\}|\{\{\s*([^}\n]{0,200}?)\s*\}\}|\[(?:redacted|path)\])/u;

/**
 * A body with no mask, word or name signal: an opaque alphanumeric run.
 *
 * why: this is the round-9 Critical. A pasted token *inside* a template
 * (`ghp_<16C7…>`, `ghp_${16C7…}`) is not documentation — exempting any bracketed
 * body lets a real secret through, so a 16+ alphanumeric body gates.
 */
const OPAQUE_BODY_PATTERN = /^[A-Za-z0-9]{16,}$/u;

/**
 * A documented identifier in a template: `${DB_PASSWORD}`, `{{ apiKey }}`.
 *
 * why the underscore requirement: a name a human can read (`DB_PASSWORD`) is
 * documentation; a pasted base64/hex body has no word boundary and is caught by
 * {@link OPAQUE_BODY_PATTERN} instead.
 */
const DOCUMENTED_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/u;

/** A value made only of mask characters (`xxxx`, `****`, `....`). */
const PLACEHOLDER_ALPHABET_PATTERN = /^[xX*.#_-]+$/u;

/** Token delimiters for path extraction; also used to split for masking. */
const TOKEN_DELIMITERS = /[\s,;()<>'"`[\]{}|]+/u;

/** Same delimiters, capturing, so a split keeps the separators to rejoin on. */
const TOKEN_DELIMITERS_CAPTURED = /([\s,;()<>'"`[\]{}|]+)/u;

/** Sentence punctuation that ends a token but is not part of the path. */
const TRAILING_PUNCTUATION = /[.,;!?]+$/u;

/**
 * A `:line` or `:line:column` suffix names a location, not part of the path. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/u;

/**
 * A `file:12 - …` location rather than an assignment.
 *
 * why: findings quote `path:line` constantly, and the whitespace-deleted reading
 * turns `ts:12 - off-by-one in the loop` into one long `[:=]` value. A colon
 * followed by a line number and then a non-word character is a location; an
 * assignment's value does not start with digits that stop dead at `-` or `)`.
 */
const LINE_NUMBER_AFTER_DELIMITER = /^:\d+(?::\d+)?(?!\w)/u;

/**
 * How much text before a delimiter is inspected for a known assignment key.
 *
 * why bounded: the key must end at the delimiter, and the longest key in the
 * table (`client_secret`) fits with room to spare, so a fixed window keeps the
 * scan linear instead of slicing the whole prefix for every match.
 */
const PRECEDING_CONTEXT_CHARS = 40;

/**
 * A `key = value` whose key the rules cannot see (split, renamed, or absent).
 *
 * why it does not matter what the key is: a space inside an assignment key
 * (`passw ord = …`) hides the key from every named-key rule, and the value is
 * still exactly what a leak looks like. Sixteen characters is long enough that
 * ordinary prose rarely reaches it; {@link isEntropyShapedAssignment} removes
 * what is left.
 */
const ASSIGNMENT_VALUE_PATTERN = /[:=]\s*[A-Za-z0-9/+_-]{16,}/gu;

/**
 * The named keys whose own rule already owns the span after the delimiter.
 *
 * why skip: `token = 8f14…` is masked in place and keeps its surrounding prose,
 * which is a better one-liner than the wholesale marker. Treating the known key
 * as an *unknown* assignment would throw that away, so the key-less rule stands
 * down whenever a named key ends at the delimiter.
 */
const KNOWN_ASSIGNMENT_KEY_BEFORE =
  /(?:password|passwd|pwd|api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|token)\s*$/iu;

/** Characters a credential anchor's body is made of. */
const ANCHOR_BODY_PATTERN = /^[A-Za-z0-9_/+=-]*/u;

/** How many characters behind an anchor are inspected for a placeholder body. */
const ANCHOR_BODY_WINDOW_CHARS = 40;

/**
 * A documentation mask at the start of an anchor's body (`AKIAXXXX`, `ghp_****`).
 *
 * why a leading run and not the whole body: in a whitespace-deleted reading the
 * body runs on into the next prose word (`AKIAXXXXisaplaceholder…`), so only the
 * mask the author typed is meaningful.
 */
const LEADING_MASK_RUN_PATTERN = /^[xX*#]{3,}/u;

/**
 * Format characters (`Cf`): zero-width space/non-joiner/joiner, the word joiner,
 * the BOM and their relatives.
 *
 * why: an invisible character inside a keyword is not a word boundary. A human
 * reads `pass\u200Bword` as `password` and so does whoever reads the PR body,
 * so the rules must see one word; leaving the character in makes the token
 * invisible to every rule family at once.
 */
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/gu;

/**
 * Typography a finding may contain: characters that cannot hide a security word.
 *
 * why the grouping: every entry is punctuation — nothing a reader could mistake
 * for a letter or digit — so none of them can spell `auth`, `secret`, `token`,
 * `.env` or a credential. Refusing them would ask a human a disclosure question
 * about `"src/a.ts:12" — off-by-one`, which buries the real security question in
 * noise. A separator can *hide* a word by joining two halves, so the same
 * characters are deleted for the compact pass;
 * {@link compactClassificationText} is what makes the exemption safe.
 *
 * why no ellipsis and no exotic spaces: NFKC folds `…` to `...` and the
 * non-breaking, narrow non-breaking and thin spaces to a plain space *before*
 * either call site, so listing them here would be unreachable code. The fold is
 * pinned by a test instead.
 *
 * Deliberately **not** here: anything from another script, math alphanumerics,
 * letterlike symbols, combining marks, control characters — lookalikes and
 * unclassifiable text, which stay refused.
 */
const BENIGN_TYPOGRAPHY: readonly string[] = [
  // Dashes and bars: the house separator in findings, and its typographic kin.
  "\u2014",
  "\u2013",
  "\u2015",
  "\u2212",
  // Quotation marks, including guillemets and low quotes: quoting a symbol, not
  // spelling one.
  "\u2018",
  "\u2019",
  "\u201A",
  "\u201B",
  "\u201C",
  "\u201D",
  "\u201E",
  "\u201F",
  "\u00AB",
  "\u00BB",
  "\u2039",
  "\u203A",
  // Inline marks used in prose: middle dot, bullet, section sign, degree.
  "\u00B7",
  "\u2022",
  "\u00A7",
  "\u00B0",
];

/** Set form of {@link BENIGN_TYPOGRAPHY}; the check runs per code point. */
const BENIGN_TYPOGRAPHY_SET: ReadonlySet<string> = new Set(BENIGN_TYPOGRAPHY);

/**
 * Layout whitespace: the characters the refuse rule also exempts.
 *
 * why: a finding is multi-line markdown, so these are layout. They are also a
 * place to split a word (`pass\nword`), which is why the compact pass deletes
 * them even though the refuse rule exempts them.
 */
const LAYOUT_WHITESPACE_PATTERN = /[\t\n\r\f\v]/gu;

/** Any whitespace run; the whitespace-deleted reading and de-duplication need it. */
const WHITESPACE_RUN_PATTERN = /\s+/gu;

/**
 * Appended to a compact-reading match: the joined span, plus why it is not verbatim.
 *
 * why: the gate record shows the human which rule fired. A word they cannot find
 * in the finding (because the separator was deleted for the rule pass) needs the
 * note, or the reason looks fabricated — and the two deletion readings need
 * different notes, because only one of them ever deletes a plain space.
 */
const COMPACT_MATCH_NOTE = " (separators removed)";

/** Appended to a whitespace-deleted-pass match: the shape exists only welded. */
const WHITESPACE_MATCH_NOTE = " (whitespace removed)";

/** Both notes, for stripping presentation back off a match before comparing it. */
const MATCH_NOTE_SUFFIXES: readonly string[] = [COMPACT_MATCH_NOTE, WHITESPACE_MATCH_NOTE];

/**
 * The benign set as a regex character class, so the two deletion readings derive
 * from the one list instead of repeating it.
 *
 * why `\u{…}`: every entry is a code point, and an escape keeps the class valid
 * whatever the character is.
 */
const BENIGN_TYPOGRAPHY_CLASS = BENIGN_TYPOGRAPHY.map(
  (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
).join("");

/** Any benign-typography character, for deleting one that stands alone. */
const BENIGN_TYPOGRAPHY_PATTERN = new RegExp(`[${BENIGN_TYPOGRAPHY_CLASS}]`, "gu");

/**
 * A benign character with a word character on both sides, plus the whitespace
 * framing it.
 *
 * why: `au — th` is `auth` with a spaced-out dash inside it, so the spaces belong
 * to the separator, not to the prose around it. Deleting only the dash leaves
 * `au  th` and the split survives — the round-7 Critical in its last form.
 */
const FRAMED_SEPARATOR_PATTERN = new RegExp(
  `(?<=\\w)\\s*[${BENIGN_TYPOGRAPHY_CLASS}]\\s*(?=\\w)`,
  "gu",
);

/**
 * Candidate text the rules cannot classify: anything outside printable ASCII once
 * layout whitespace is set aside — minus {@link BENIGN_TYPOGRAPHY}, filtered by
 * the caller.
 *
 * why printable ASCII: this is the "refuse, don't guess" doctrine of
 * `src/publish-gate.ts`, and for the same reason — there is no reliable mapping
 * for lookalikes (`prоof` with a Cyrillic `о`, `аuth` with a Cyrillic `а`), so a
 * character that survives normalisation as non-ASCII and is not benign
 * typography is refused rather than read as whatever it resembles. A lookalike
 * in a path (`café.png`, `prоof/…`) takes the human route, which costs one
 * answer instead of publishing text nobody read.
 *
 * Only letterlike code points reach the refusal: an arrow, emoji or math symbol
 * cannot spell a keyword or spoof a letter, and refusing it gated ordinary
 * findings on a stray `→` (bd-252). See
 * {@link LETTERLIKE_CODE_POINT_PATTERN}.
 *
 * why ASCII whitespace is exempt: a finding is multi-line markdown, so `\n` and
 * `\t` are layout, not evasion — a word interrupted by a newline is not the
 * word, so refusing `\n` would gate every review for no security gain.
 *
 * NFKC already neutralises the folds it can: the Kelvin sign becomes `K` and the
 * `ﬁ` ligature becomes `fi`, so those characters reach this check as ASCII and
 * match the rules exactly like the letters they look like — stricter, not
 * looser. What survives as non-ASCII (Cyrillic `а`, the OHM sign's `Ω`, `µ`'
 * Greek `μ`) is what the rules genuinely cannot map.
 */
const NON_PRINTABLE_ASCII_PATTERN = /[^\x20-\x7E\t\n\r\f\v]/gu;

/**
 * Code points that can carry a hidden word: Unicode letters, marks and numbers.
 *
 * why only these (bd-252): the refuse rule exists to stop a lookalike from
 * spelling a keyword the ASCII rules cannot read (`prоof`, `аuth`). An arrow, a
 * check mark, an emoji or a math operator cannot spell a word nor spoof a letter,
 * so refusing it only turns ordinary findings (`the lock is taken → then
 * released`) into a disclosure question. Non-letterlike symbols outside the
 * benign list are therefore exempt and recorded nowhere.
 */
const LETTERLIKE_CODE_POINT_PATTERN = /[\p{L}\p{M}\p{N}]/u;

/** True when a code point can spell or spoof a letter, mark or digit. */
function isLetterlikeCodePoint(character: string): boolean {
  return LETTERLIKE_CODE_POINT_PATTERN.test(character);
}

/** How many distinct offending code points the recorded reason names. */
const UNCLASSIFIABLE_DISTINCT_CAP = 8;

/**
 * Words that make a reply conditional or defer the decision.
 *
 * why: "publish after we rotate the key" is a real instruction that must not
 * release the raw text *now*; the reply is read as the default withhold with a
 * reason that names it, so the orchestrator knows the human was heard.
 */
const CONDITIONAL_REPLY_PATTERN =
  /\b(?:after|afterwards|once|when|whenever|if|unless|until|till|before|later|hold|wait|pending|then|yet)\b/u;

/**
 * Accepted publish-as-is replies, anchored at both ends.
 *
 * why: the gate comment names three options, and only a reply that *is* one of
 * them may release a security-class finding. Free text that merely contains
 * `publish` ("yes, publish the release", "publish but only the redacted one")
 * must not be read as permission — the earlier keyword match did exactly that
 * (bd-183 review, Warning).
 *
 * `as-is` only counts with `publish` in front of it, and a bare `include` is not
 * accepted (only `include it`): "as is, please" and "include" are ordinary
 * answers to the disposition question on the same comment, not permission to
 * publish a credential (bd-183 review).
 */
const PUBLISH_REPLY_PATTERN =
  /^(?:please\s+)?(?:publish(?:\s+(?:it|this|that))?(?:\s+as(?:-|\s)is)?|include\s+it|ship\s+it)(?:\s+please)?$/u;

/** Accepted redact replies: the option label plus its unambiguous synonyms. */
const REDACT_REPLY_PATTERN =
  /^(?:please\s+)?(?:(?:publish\s+)?redact(?:ed)?(?:\s+(?:it|one[- ]?liner|version|summary))?|publish\s+(?:a\s+|the\s+)?redacted\s+(?:one[- ]?liner|version|summary)|one[- ]?liner|summari[sz]e(?:\s+(?:it|this|the\s+finding))?)(?:\s+please)?$/u;

/**
 * Accepted withhold replies. Checked first, so a negation can never be read as
 * the positive keyword it contains ("do not publish" is a withhold).
 */
const WITHHOLD_REPLY_PATTERN =
  /^(?:please\s+)?(?:withhold(?:\s+it)?|withheld|(?:do\s+not|don'?t)\s+publish(?:\s+(?:it|this|that))?|no|skip(?:\s+it)?)(?:\s+please)?$/u;

/**
 * True when a value is documentation, not a secret.
 *
 * A bracketed span is judged by its **inner body**, recursively: `<token>`,
 * `${DB_PASSWORD}` and `{{ apiKey }}` are documentation, while
 * `<16C7e42F292c6912E7710c838347Ae178B4a>` is the secret with a template wrapped
 * around it and therefore gates (round-9 Critical). Everything else must be a
 * mask (`xxxx`, `****`), a documented word (`REDACTED`, `placeholder`) or a
 * documented identifier.
 */
function isDocumentedPlaceholderBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === "") return true;
  const bracketed = BRACKETED_PLACEHOLDER_PATTERN.exec(trimmed);
  if (bracketed !== null) {
    const inner = bracketed[1] ?? bracketed[2] ?? bracketed[3];
    if (inner === undefined) return true;
    return isDocumentedPlaceholderBody(inner);
  }
  if (OPAQUE_BODY_PATTERN.test(trimmed)) return false;
  return (
    PLACEHOLDER_ALPHABET_PATTERN.test(trimmed) ||
    PLACEHOLDER_WORD_PATTERN.test(trimmed) ||
    DOCUMENTED_IDENTIFIER_PATTERN.test(trimmed)
  );
}

/**
 * True when a matched credential is documentation, not a secret.
 *
 * The prefix (token family or assignment key) is stripped first, because
 * `AKIA`/`ghp_`/`token =` carry no entropy and would otherwise defeat the
 * mask-character check.
 */
function isPlaceholderSecret(match: string, secretPrefix: RegExp | undefined): boolean {
  const stripped = secretPrefix === undefined ? match : match.replace(secretPrefix, "");
  const body = stripped.replace(/^["']+|["']+$/gu, "").trim();
  return body === "" || isDocumentedPlaceholderBody(body);
}

/**
 * True when a deny-set pattern names this path token.
 *
 * Kept as one small interpreter instead of regex-per-pattern so the documented
 * `FINDING_DENY_PATH_PATTERNS` stays readable (and testable) as data.
 */
function denyPathPatternMatches(pattern: string, token: string): boolean {
  if (pattern.endsWith("/")) {
    // why the last form: a finding may name the directory itself (`~/.ssh`, or a
    // bare `.ssh`) with no trailing slash, which is still a pointer into the
    // credential store — and it is the shape a deleted separator leaves behind
    // (`~/.ss·h`). The bare-token form is also what a dot-directory looks like in
    // prose (`the .ssh folder`), which the slash-anchored forms cannot reach.
    //
    // why dot-directories only: `secrets/` and `src/auth/` are ordinary English and
    // ordinary paths, so an exact-token match on the bare word would gate every
    // finding that says "secrets". A `.`-prefixed name cannot be prose.
    return (
      token.startsWith(pattern) ||
      token.includes(`/${pattern}`) ||
      token.endsWith(`/${pattern.slice(0, -1)}`) ||
      (pattern.startsWith(".") && token === pattern.slice(0, -1))
    );
  }
  const basename = token.split("/").pop() ?? token;
  if (pattern.startsWith("*.")) return basename.endsWith(pattern.slice(1));
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return basename.startsWith(prefix) && basename.length > prefix.length;
  }
  return basename === pattern;
}

/** The deny-set pattern a token names, if any (the first in the documented order). */
function findDenyPathPattern(token: string): string | undefined {
  if (token === "" || token.includes("://")) return undefined;
  return FINDING_DENY_PATH_PATTERNS.find((pattern) => denyPathPatternMatches(pattern, token));
}

/** A path token with sentence punctuation and a `:line` suffix removed. */
function normalizePathToken(token: string): string {
  return token.replace(TRAILING_PUNCTUATION, "").replace(LINE_SUFFIX, "");
}

/**
 * Path tokens in a finding.
 *
 * Every token is a candidate (the deny set is specific enough that prose words
 * never match), because a bare `id_rsa` has neither a slash nor an extension and
 * a path-likeness heuristic would silently let it through. URL tokens are
 * skipped: they belong to the credential rules, and `https://example.com/x` must
 * not be classified by its hostname path.
 */
function findingTokens(finding: string): readonly string[] {
  return finding
    .split(TOKEN_DELIMITERS)
    .map(normalizePathToken)
    .filter((token) => token !== "" && !token.includes("://"));
}

/**
 * The text the rules run against.
 *
 * Format characters are removed, then the string is NFKC-normalised.
 *
 * **NFKC** on purpose: compatibility folding turns fullwidth Latin and
 * punctuation into their ASCII forms (`ＡＵＴＨ` → `AUTH`, `．ｅｎｖ` →
 * `.env`), which is the realistic evasion — a keyboard or a copy-paste from a
 * CJK-locale document produces exactly those forms. Folding a fullwidth
 * spelling into ASCII is not a judgement call about intent: the folded text is
 * what the reader sees, so it is what the rule table must classify.
 *
 * Lookalikes NFKC cannot fold (Cyrillic/Greek letters) are not guessed at; they
 * are caught by {@link residualUnclassifiableMatch} for the refuse path instead.
 */
export function normalizeFindingText(finding: string): string {
  return finding.replace(FORMAT_CHARACTER_PATTERN, "").normalize("NFKC");
}

/** `\u{1F600}`-style escape, so a lookalike in a record is unambiguous. */
function escapeCodePoint(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, "0")}}`;
}

/** True when a character is benign typography: exempt from the refuse rule. */
function isBenignTypography(character: string): boolean {
  return BENIGN_TYPOGRAPHY_SET.has(character);
}

/**
 * The text with the separators deleted, for the second classification pass.
 *
 * why: a benign-typography character or a layout newline **between the letters of
 * a word is not a word boundary**. `pass·word`, `au—th`, `tok§en`, `~/.ss·h` and
 * `pass\nword` are `password`, `auth`, `token`, `~/.ssh` and `password` to every
 * reader, including whoever reads the PR body — so a `\b` that fails inside them
 * is a hiding place, not a word edge. The primary pass keeps the separators (so
 * ordinary prose and real paths tokenise exactly as written); this pass deletes
 * them so the same rule families can read the joined text, and the readings are
 * unioned.
 *
 * Two deletions, because a separator arrives in two shapes:
 *
 * 1. a benign character **with a word character on both sides** is a hidden join
 *    however it is spaced — `au — th`, `pass · word`, `tok § en` are `auth`,
 *    `password`, `token` — so the character **and the whitespace framing it** go
 *    ({@link FRAMED_SEPARATOR_PATTERN}); that is what lets the topic family read
 *    the joined word.
 * 2. otherwise the benign character goes, and any leftover layout whitespace goes
 *    with it (`pass\nword`, `pass·word`).
 *
 * A plain space between two words with no separator stays: that is a real word
 * break, so prose is not welded (`secrets are handled` stays two words). Spaced
 * *shapes* that no typography marks (`ghp_ 16C7…`, `id_rs a`) are the
 * whitespace-deleted pass's job; see {@link weldedClassificationText}.
 */
function compactClassificationText(normalized: string): string {
  return normalized
    .replace(FRAMED_SEPARATOR_PATTERN, "")
    .replace(BENIGN_TYPOGRAPHY_PATTERN, "")
    .replace(LAYOUT_WHITESPACE_PATTERN, "");
}

/**
 * The text with every whitespace character deleted, for the third reading.
 *
 * why every one and not a window: a window of N adjacent words is beaten by a
 * split into N+1 words — round 8 demonstrated both directions (a four-word split
 * of a token, and a prefix torn from its body by a full stop). Deleting *all*
 * whitespace crosses any number of spaces at once, so `passw ord = …`,
 * `secrets /prod.yaml`, `id_rs a` and `legacy.p em` all present the shape their
 * rule needs.
 *
 * why derived from the compact reading: a split can use both a separator and a
 * space (`pass·word = …`), and the two deletions compose.
 *
 * why only the shape families run on this reading: welding every space turns a
 * sentence into one token, so the topic vocabulary would fire on fabricated
 * words (`secrets are handled` → `secretsarehandled`). An anchor, a credential
 * prefix or a deny directory is a specific string; welding prose cannot invent
 * one. See {@link matchWeldedReasons}.
 */
function weldedClassificationText(compact: string): string {
  return compact.replace(WHITESPACE_RUN_PATTERN, "");
}

/**
 * The offending characters of an unclassifiable finding, deduped, capped and
 * escaped, or `null` when only ASCII, benign typography and non-letterlike
 * symbols remain.
 *
 * Escaped rather than quoted because a lookalike pasted next to the text it
 * spoofs is unreadable in a gate comment; `\u{043E}` says exactly which code
 * point stopped the finding. Only letterlike code points can hide a word, so an
 * arrow or emoji is not a disclosure question (bd-252).
 */
function residualUnclassifiableMatch(text: string): string | null {
  const distinct = [...new Set(text.match(NON_PRINTABLE_ASCII_PATTERN) ?? [])].filter(
    (character) => !isBenignTypography(character) && isLetterlikeCodePoint(character),
  );
  if (distinct.length === 0) return null;
  const escaped = distinct.slice(0, UNCLASSIFIABLE_DISTINCT_CAP).map(escapeCodePoint);
  const more = distinct.length > UNCLASSIFIABLE_DISTINCT_CAP ? ` ${ELLIPSIS}` : "";
  return `${escaped.join(" ")}${more}`;
}

/** Stable identity of a reason; also the de-duplication key. */
function reasonKey(reason: FindingSensitivityReason): string {
  return `${reason.kind}\u0000${reason.match}`;
}

/** Stable de-duplication: the record persists these, so order must not drift. */
function dedupeReasons(reasons: readonly FindingSensitivityReason[]): FindingSensitivityReason[] {
  const seen = new Set<string>();
  const deduped: FindingSensitivityReason[] = [];
  for (const reason of reasons) {
    const key = reasonKey(reason);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reason);
  }
  return deduped;
}

/**
 * Documentation placeholder spans: `<token>`, `${TOKEN}`, `{{ token }}`.
 *
 * why: these are the shapes {@link isDocumentedPlaceholderBody} already treats as a
 * documented placeholder for credentials, so a topic word inside one is
 * documentation too. Only the `tokens` rule consults them.
 *
 * why the bounded body: an unterminated `<` run would make the span search
 * quadratic, and no placeholder value is 200 characters long. A longer span is
 * simply not a placeholder, so a token inside it still gates (fail-closed).
 */
const PLACEHOLDER_SPAN_PATTERN = /<[^>\n]{0,200}>|\$\{[^}\n]{0,200}\}|\{\{[^}\n]{0,200}\}\}/gu;

/** A half-open range of the classified text. */
interface TextSpan {
  start: number;
  end: number;
}

/** Ranges covered by a documentation placeholder shape. */
function placeholderSpans(text: string): readonly TextSpan[] {
  return [...text.matchAll(PLACEHOLDER_SPAN_PATTERN)].flatMap((matched) =>
    matched.index === undefined
      ? []
      : [{ start: matched.index, end: matched.index + matched[0].length }],
  );
}

/** A global clone of a pattern, so one text can be scanned for a later match. */
function asGlobal(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}

/**
 * The first topic match, or `null`.
 *
 * why not `pattern.exec`: a rule that skips placeholder spans must be able to
 * look past a skipped match for a real one later in the finding.
 */
function firstTopicMatch(text: string, rule: SecurityTopicRule): string | null {
  if (rule.skipPlaceholderSpans !== true) {
    const matched = rule.pattern.exec(text);
    return matched === null ? null : matched[0];
  }
  const spans = placeholderSpans(text);
  for (const matched of text.matchAll(asGlobal(rule.pattern))) {
    const index = matched.index;
    if (index === undefined) continue;
    if (spans.some((span) => index >= span.start && index < span.end)) continue;
    return matched[0];
  }
  return null;
}

/** `RegExp` metacharacters, for building an anchor pattern from literal text. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The anchors as one alternation, longest first.
 *
 * why one pattern and not a loop: a scan per anchor is linear but with a factor
 * of the table size; one alternation is a single pass over the text, and the
 * shortest alternative can never shadow a longer one (`sk_live_` before `sk-`).
 */
const CREDENTIAL_ANCHOR_PATTERN = new RegExp(
  [...FINDING_CREDENTIAL_ANCHORS]
    .sort((left, right) => right.anchor.length - left.anchor.length)
    .map((entry) => escapeRegExp(entry.anchor))
    .join("|"),
  "giu",
);

/** Anchor text (lower-cased) to the family it belongs to. */
const CREDENTIAL_ANCHOR_KINDS: ReadonlyMap<string, CredentialAnchor["kind"]> = new Map(
  FINDING_CREDENTIAL_ANCHORS.map(({ anchor, kind }) => [anchor, kind]),
);

/**
 * True when this anchor occurrence introduces a documented placeholder.
 *
 * why: the placeholder exemption predates the anchor rule and still applies —
 * `AKIAXXXX` in a README documents a key rather than leaking one. A *bare*
 * anchor (nothing credential-like behind it, `ghp_` at the end of a sentence) is
 * not a placeholder: the anchor alone is the disclosure question, which is the
 * whole point of the rule. Only an explicit template (`ghp_<token>`,
 * `AKIA${KEY}`) excuses an anchor that has no body of its own.
 */
function isPlaceholderAnchorOccurrence(text: string, endIndex: number): boolean {
  const rest = text.slice(endIndex, endIndex + ANCHOR_BODY_WINDOW_CHARS);
  const body = ANCHOR_BODY_PATTERN.exec(rest)?.[0] ?? "";
  if (body !== "") {
    // why the mask run first: in a whitespace-deleted reading the body runs on
    // into the next prose word (`AKIAXXXXisaplaceholder…`), so only the mask prefix
    // the author typed is meaningful. A pasted body does not start with three mask
    // characters, so the round-9 abuse still gates via the opaque-body guard.
    return LEADING_MASK_RUN_PATTERN.test(body) || isDocumentedPlaceholderBody(body);
  }
  // why the whole span and not the rest of the sentence: only the template is
  // judged, so `ghp_<token> appears in the docs` stays documentation while
  // `ghp_<16C7…>` gates on the pasted body inside the brackets.
  const span = BRACKETED_PLACEHOLDER_PATTERN.exec(rest.trimStart());
  return span !== null && isDocumentedPlaceholderBody(span[0]);
}

/**
 * One rule match plus the rule that produced it.
 *
 * why the rule id: suppression may only compare matches from *different* rules.
 * The matches of one global regex are disjoint by construction, so a same-rule
 * containment check can never fire — and paying for it made the scan quadratic in
 * the number of matches (bd-183 round 9, Warning: `sk-` ×20k → 2.9 s).
 */
interface RuleReason {
  reason: FindingSensitivityReason;
  rule: string;
}

/** The rule id of the anchor alternation (one regex, so one id). */
const CREDENTIAL_ANCHOR_RULE = "anchor";

/** The reason alone, for the public verdict. */
function reasonsOf(matches: readonly RuleReason[]): FindingSensitivityReason[] {
  return matches.map((match) => match.reason);
}

/**
 * True for the benign `process.env` reference the `.env` anchor would catch.
 *
 * why: the anchor table is boundary-free on purpose so a split cannot hide a
 * credential, but `.env` inside `process.env` names an environment lookup, not a
 * credential path. Without this exemption every `process.env` reliability finding
 * re-opens the bd-233 false positive (bd-252 review).
 *
 * why the left boundary (bd-252 round-2 review): matching only the seven literal
 * characters before `.env` also exempts `xprocess.env` / `myprocess.env`, which a
 * leaked path can use to dodge the deny-path anchor. `process` must start at the
 * string or after a non-word character; a real file reference such as `the .env`
 * or `secrets/.env` has no `process` prefix and stays deny-path.
 */
function isProcessEnvReference(text: string, index: number, match: string): boolean {
  if (match.toLowerCase() !== ".env") return false;
  const processStart = index - "process".length;
  if (processStart < 0) return false;
  if (text.slice(processStart, index).toLowerCase() !== "process") return false;
  if (processStart === 0) return true;
  return !/\w/u.test(text[processStart - 1] ?? "");
}

/**
 * Anchor reasons in one reading.
 *
 * why every occurrence: a finding can quote one token in a code span and a
 * second in prose, and the record is what the human reads.
 */
function anchorReasons(text: string): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const matched of text.matchAll(CREDENTIAL_ANCHOR_PATTERN)) {
    const index = matched.index;
    if (index === undefined) continue;
    const kind = CREDENTIAL_ANCHOR_KINDS.get(matched[0].toLowerCase());
    if (kind === undefined) continue;
    if (isPlaceholderAnchorOccurrence(text, index + matched[0].length)) continue;
    if (isProcessEnvReference(text, index, matched[0])) continue;
    reasons.push({ reason: { kind, match: matched[0] }, rule: CREDENTIAL_ANCHOR_RULE });
  }
  return reasons;
}

/** Credential-shaped reasons in one string. */
function credentialReasons(text: string, options: { welded?: boolean } = {}): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const rule of CREDENTIAL_SHAPED_RULES) {
    for (const matched of text.matchAll(rule.pattern)) {
      if (isPlaceholderSecret(matched[0], rule.secretPrefix)) continue;
      // why: welding a placeholder value onto the following prose makes it look
      // like a longer secret (`password=xxxx in the example`). In the welded
      // reading only, a matched value with no entropy signal is a word.
      const value =
        rule.secretPrefix === undefined ? matched[0] : matched[0].replace(rule.secretPrefix, "");
      if (options.welded === true && !hasEntropySignal(value)) continue;
      reasons.push({
        reason: { kind: "credential-shaped", match: matched[0] },
        rule: `credential:${rule.id}`,
      });
    }
  }
  return reasons;
}

/**
 * Credential-shaped reasons from the sink/lifecycle family (bd-252).
 *
 * why every occurrence: a finding can name one credential beside a leak and a
 * second beside a lifecycle break; the record is what the human reads. The
 * patterns are bounded per sentence so a match cannot span unrelated prose.
 */
function credentialSinkReasons(text: string): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const rule of CREDENTIAL_SINK_RULES) {
    for (const matched of text.matchAll(asGlobal(rule.pattern))) {
      reasons.push({
        reason: { kind: "credential-shaped", match: matched[0] },
        rule: `credential-sink:${rule.id}`,
      });
    }
  }
  return reasons;
}

/** Deny-path reasons over the tokens of one string. */
function denyPathReasons(text: string): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const token of findingTokens(text)) {
    if (findDenyPathPattern(token) !== undefined) {
      reasons.push({ reason: { kind: "deny-path", match: token }, rule: "deny-path-token" });
    }
  }
  return reasons;
}

/**
 * Deny-set directories found anywhere in a whitespace-deleted reading.
 *
 * why a plain substring: deleting the whitespace removes the only boundary left
 * (`secrets /prod.yaml` → `secrets/prod.yaml`), and welding the previous word on
 * (`thesecrets/prod.yaml`) must not hide the directory again. A deny directory
 * name is specific enough that a substring cannot be invented by prose.
 */
function weldedDenyPathReasons(text: string): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const pattern of FINDING_DENY_PATH_PATTERNS) {
    if (!pattern.endsWith("/")) continue;
    const index = text.indexOf(pattern);
    if (index === -1) continue;
    reasons.push({
      reason: { kind: "deny-path", match: text.slice(index, index + pattern.length) },
      rule: `deny-path-welded:${pattern}`,
    });
  }
  return reasons;
}

/**
 * True when a matched value carries a signal that it is a key, not a word.
 *
 * why: in a whitespace-deleted reading the right edge of a value is unknown, so
 * a short placeholder can be welded onto the prose that follows it
 * (`password=xxxx in the example` → `password=xxxxintheexample`). A digit, an
 * upper-case letter or a `/`, `+` or `_` is what an actual key has and a run of
 * lower-case prose does not.
 */
function hasEntropySignal(value: string): boolean {
  return /[0-9A-Z/+_]/u.test(value);
}

/**
 * A canonical UUID, which is an identifier rather than a key body.
 *
 * why: `uuid = 550e8400-e29b-41d4-a716-446655440000` is configuration, and the
 * hyphens would otherwise satisfy the separator-class signal below. A 32-char
 * hex blob with no hyphens still gates: it is indistinguishable from a digest and
 * that is the documented cost of a key-less rule.
 */
const UUID_VALUE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A value that is only digits: a number (port, timeout, epoch), never a key body.
 *
 * why: without this, `port = 1234567890123456` gates and the operator learns to
 * skip the gate. A key body mixes classes — hex/base32/base64 carry letters — so
 * requiring a letter is what separates a number from a credential. A commit sha
 * still gates (it has letters); that is the accepted cost of not reading the key.
 */
const NUMERIC_VALUE_PATTERN = /^\d+$/u;

/**
 * True when a bare `[:=] value` really is an assignment.
 *
 * why the entropy test: a 16+ character run with no digit, no upper-case letter
 * and no `/`, `+` or `_` is a word (or a welded sentence), not a key — without
 * the test, `line 42: the loop allocates on every iteration` would gate once the
 * spaces are deleted. A `scheme://` URL is not an assignment either.
 *
 * why the two-character-class signal: an all-digit run is a number and a UUID is
 * an identifier, so neither is a disclosure question. Everything else a leak
 * looks like — lowercase hex, base32, base64 — mixes a digit with a letter and
 * still gates.
 */
function isEntropyShapedAssignment(match: string): boolean {
  const value = match.replace(/^[:=]\s*/u, "");
  if (value.startsWith("//")) return false;
  if (LINE_NUMBER_AFTER_DELIMITER.test(match)) return false;
  if (NUMERIC_VALUE_PATTERN.test(value)) return false;
  if (UUID_VALUE_PATTERN.test(value)) return false;
  return hasEntropySignal(value) && /[A-Za-z]/u.test(value);
}

/**
 * Assignment-shaped reasons whose key the rules cannot name.
 *
 * why the known-key skip: `token = 8f14…` is already owned by
 * {@link CREDENTIAL_SHAPED_RULES}, which masks the value in place and keeps the
 * surrounding prose — a better one-liner than the wholesale marker. Treating
 * that span as an unknown assignment would throw it away for no safety gain.
 */
function assignmentReasons(text: string): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const matched of text.matchAll(ASSIGNMENT_VALUE_PATTERN)) {
    const index = matched.index;
    if (index === undefined) continue;
    const before = text.slice(Math.max(0, index - PRECEDING_CONTEXT_CHARS), index);
    if (KNOWN_ASSIGNMENT_KEY_BEFORE.test(before)) continue;
    if (!isEntropyShapedAssignment(matched[0])) continue;
    reasons.push({
      reason: { kind: "credential-shaped", match: matched[0] },
      rule: "assignment",
    });
  }
  return reasons;
}

/**
 * Drop repeats, then drop a shape an earlier *different* rule already covered.
 *
 * why two steps: a leak dump repeats the same anchor tens of thousands of times,
 * and those repeats are one reason — folding them first is what makes a
 * pathological finding cheap (round 9 measured 2.9 s at 20k repeats).
 *
 * why cross-rule only: the matches of one global regex never overlap, so a
 * containment check between two matches of the same rule can only be false.
 * Skipping it removes the quadratic term that made the old scan slow, without
 * changing a single verdict — the pairs that used to be suppressed (`ghp_` →
 * `ghp_16C7…`, `.pem` → `item.pem`) always come from different rules.
 */
function dedupeShapeContainment(matches: readonly RuleReason[]): RuleReason[] {
  const seen = new Set<string>();
  const unique: RuleReason[] = [];
  for (const match of matches) {
    const key = shapeIdentity(match.reason);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(match);
  }
  const kept: RuleReason[] = [];
  for (const match of unique) {
    if (isShapeReason(match.reason) && kept.some((known) => containsAcrossRules(known, match))) {
      continue;
    }
    kept.push(match);
  }
  return kept;
}

/** Case-folded, whitespace-free identity of a shape reason. */
function shapeIdentity(reason: FindingSensitivityReason): string {
  return `${reason.kind}\u0000${compactMatchKey(reason.match).toLowerCase()}`;
}

/**
 * The shape families of one reading, most specific match first.
 *
 * why this order: the whole-token rules run before the anchors, so a finding that
 * quotes a full `ghp_…` token, a PEM block or `id_rsa` reports the shape the
 * human can act on and the bare anchor behind it is suppressed. A split leaves
 * only the anchor, which is exactly the case the anchor rule exists for.
 *
 * why the sink family runs last: its match spans a whole phrase, so putting it
 * after the specific shapes means it can never suppress an unrelated credential,
 * path or anchor through containment. An earlier specific shape may still subsume
 * a sink phrase, which is harmless — the shape reason is the more actionable one,
 * and the family only adds a reason, never removes a verdict.
 */
function matchShapeReasons(text: string, options: { welded?: boolean } = {}): RuleReason[] {
  return dedupeShapeContainment([
    ...credentialReasons(text, options),
    ...assignmentReasons(text),
    ...denyPathReasons(text),
    ...anchorReasons(text),
    ...credentialSinkReasons(text),
  ]);
}

/** Every family over one reading; the refuse rule is not one of them. */
function matchRuleReasons(text: string): RuleReason[] {
  const reasons: RuleReason[] = [];
  for (const rule of SECURITY_TOPIC_RULES) {
    const matched = firstTopicMatch(text, rule);
    if (matched !== null) {
      reasons.push({
        reason: { kind: "security-topic", match: matched },
        rule: `topic:${rule.id}`,
      });
    }
  }
  return [...reasons, ...matchShapeReasons(text)];
}

/** True when any disclosure-risk word family appears in one reading. */
function hasDisclosureRiskSignal(text: string): boolean {
  return DISCLOSURE_RISK_RULES.some((rule) => rule.pattern.test(text));
}

/** Drop topic reasons when no risk signal turned them into a disclosure question. */
function withoutSecurityTopicReasons(reasons: readonly RuleReason[]): RuleReason[] {
  return reasons.filter((entry) => entry.reason.kind !== "security-topic");
}

/**
 * The shape families over the whitespace-deleted reading.
 *
 * why never the topic rules here: welding every space turns a sentence into one
 * token, so the topic vocabulary would fire on fabricated words (`secrets are
 * handled` would become `secretsarehandled`). Anchors, credential prefixes and
 * deny directories are specific strings; prose cannot weld one by accident.
 */
function matchWeldedReasons(text: string): RuleReason[] {
  return dedupeShapeContainment([
    ...matchShapeReasons(text, { welded: true }),
    ...weldedDenyPathReasons(text),
  ]);
}

/**
 * True when a reading matched a marker whose secret no mask can reach.
 *
 * why wholesale: an anchor names a *class* of secret and a key-less assignment
 * names a value whose key the rules could not read. Masking the marker leaves the
 * material behind it (`-----BEGIN …` masks the header, the encoded key follows),
 * so the only safe one-liner is the marker alone.
 */
function hasUnmaskableMarker(text: string): boolean {
  return anchorReasons(text).length > 0 || assignmentReasons(text).length > 0;
}

/** One character of an opaque run (the class {@link OPAQUE_BODY_PATTERN} widens). */
const OPAQUE_RUN_CHARACTER = /^[A-Za-z0-9_/+=-]$/u;

/** Any code point outside printable ASCII and outside layout whitespace. */
const NON_ASCII_CHARACTER = /[^\x20-\x7E\t\n\r\f\v]/u;

/** At least this many opaque characters make a run a credential-shaped body. */
const OPAQUE_RUN_MIN_CHARS = 16;

/**
 * True when an unreadable code point sits inside an opaque run.
 *
 * why: a lookalike that replaces one character of an anchor — `ghр_16C7…` with a
 * Cyrillic `р` — breaks the anchor but leaves the token body intact. Masking just
 * the code point would ship the body in the line a human approves (round-9
 * Critical). A prose lookalike (`café`) has no long run behind it, so it stays
 * maskable rather than forcing a wholesale marker.
 */
function hasLookalikeInsideOpaqueRun(text: string): boolean {
  let index = 0;
  for (const character of text) {
    const length = character.length;
    if (NON_ASCII_CHARACTER.test(character)) {
      const surrounding = opaqueRunBefore(text, index) + opaqueRunAfter(text, index + length);
      if (surrounding >= OPAQUE_RUN_MIN_CHARS) return true;
    }
    index += length;
  }
  return false;
}

/** Length of the opaque run ending just before `index`. */
function opaqueRunBefore(text: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!OPAQUE_RUN_CHARACTER.test(text[cursor] ?? "")) break;
    count += 1;
  }
  return count;
}

/** Length of the opaque run starting at `index`. */
function opaqueRunAfter(text: string, index: number): number {
  let count = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (!OPAQUE_RUN_CHARACTER.test(text[cursor] ?? "")) break;
    count += 1;
  }
  return count;
}

/** A match without its presentation note; the note is not part of the match. */
function withoutMatchNote(match: string): string {
  const note = MATCH_NOTE_SUFFIXES.find((suffix) => match.endsWith(suffix));
  return note === undefined ? match : match.slice(0, -note.length);
}

/** Whitespace-free identity of a match, for comparing the deletion readings. */
function compactMatchKey(match: string): string {
  return withoutMatchNote(match).replace(WHITESPACE_RUN_PATTERN, "");
}

/**
 * True when an earlier, different rule already reported this shape.
 *
 * why not equality: a deletion pass re-reads the same shape with the separators
 * gone (`password = 8f14…` → `password=8f14…`), and a whitespace deletion welds
 * the neighbouring words on (`ghp_16C7…in`, `theitem.pem`). Either form is the
 * credential or path an earlier pass already caught, and recording it twice would
 * only make the gate comment repeat itself.
 *
 * why both directions: an anchor is a *prefix* of the shape it heads, so whichever
 * order the two arrive in, one contains the other. The suppression can never
 * erase the only reason of a kind — it requires an earlier reason of the same
 * kind from a different rule — so the verdict cannot flip off here.
 */
function containsAcrossRules(known: RuleReason, candidate: RuleReason): boolean {
  if (known.reason.kind !== candidate.reason.kind) return false;
  if (known.rule === candidate.rule) return false;
  return containsShape(known.reason, candidate.reason);
}

/**
 * Kind-compatible containment, ignoring which rule produced either match.
 *
 * why the rule-blind form exists for the cross-reading check: the same rule id
 * runs over every reading, so deleting whitespace changes the match without
 * changing the rule (`secrets/prod.yaml` → `secrets/prod.yamlisworldreadable`).
 * The per-reading check can be rule-strict because one regex's matches are
 * disjoint; this one cannot, or the welded neighbour would be recorded again.
 */
function containsShape(
  known: FindingSensitivityReason,
  candidate: FindingSensitivityReason,
): boolean {
  if (known.kind !== candidate.kind) return false;
  const knownKey = compactMatchKey(known.match).toLowerCase();
  const candidateKey = compactMatchKey(candidate.match).toLowerCase();
  return (
    candidateKey.startsWith(knownKey) ||
    candidateKey.endsWith(knownKey) ||
    knownKey.startsWith(candidateKey) ||
    knownKey.endsWith(candidateKey)
  );
}

/** True for the two shape-anchored kinds (the ones a deletion pass may re-read). */
function isShapeReason(reason: FindingSensitivityReason): boolean {
  return reason.kind === "credential-shaped" || reason.kind === "deny-path";
}

/**
 * Reasons from `found` that `earlier` did not already report, annotated.
 *
 * Topic reasons de-duplicate exactly (a re-read word is either the same match or
 * a different word); shape reasons also tolerate a welded neighbour, because a
 * whitespace or separator deletion presents the same shape differently. Both use a
 * case-folded key, and both compare only across *different* rules for the reason
 * {@link dedupeShapeContainment} gives.
 */
function newPassReasons(
  found: readonly RuleReason[],
  earlier: readonly RuleReason[],
  note: string,
): RuleReason[] {
  const reported = new Set(earlier.map((entry) => foldedReasonKey(entry.reason)));
  const addedKeys = new Set<string>();
  const added: RuleReason[] = [];
  for (const entry of found) {
    const key = foldedReasonKey(entry.reason);
    if (reported.has(key) || addedKeys.has(key)) continue;
    if (
      isShapeReason(entry.reason) &&
      (earlier.some((known) => containsShape(known.reason, entry.reason)) ||
        added.some((known) => containsShape(known.reason, entry.reason)))
    ) {
      continue;
    }
    addedKeys.add(key);
    added.push(entry);
  }
  return added.map((entry) => ({
    ...entry,
    reason: { ...entry.reason, match: `${entry.reason.match}${note}` },
  }));
}

/** Case-folded identity of one reason, for exact cross-reading de-duplication. */
function foldedReasonKey(reason: FindingSensitivityReason): string {
  return `${reason.kind}\u0000${reason.match.toLowerCase()}`;
}

/** The reasons each reading found; later readings hold only what earlier ones missed. */
interface ClassificationPasses {
  primary: readonly RuleReason[];
  /** Compact-reading reasons, annotated with {@link COMPACT_MATCH_NOTE}. */
  separated: readonly RuleReason[];
  /** Whitespace-deleted-reading reasons, annotated with {@link WHITESPACE_MATCH_NOTE}. */
  whitespaceFree: readonly RuleReason[];
  /**
   * True when a reading matched a marker a mask cannot reach — an anchor or a
   * key-less assignment — so the only safe one-liner is `[redacted]` alone.
   */
  hasUnmaskableMarker: boolean;
  /**
   * True when any reading matched a disclosure-risk signal (bd-252).
   *
   * why: topic reasons are only recorded when this is true, so the risk floor
   * covers the primary, separator and whitespace-free readings alike; a risk
   * word split by a separator must still count.
   */
  hasDisclosureRisk: boolean;
}

/**
 * Run the families over the text, then over the two separator-deleted readings.
 *
 * why union and not either/or: over-matching costs one human question, while
 * under-matching publishes the credential the separator was hiding. A reason an
 * earlier reading already reported is not repeated, so a finding with no hidden
 * split yields exactly what it did before these readings existed.
 */
function classificationPasses(normalized: string): ClassificationPasses {
  const primary = matchRuleReasons(normalized);
  const compact = compactClassificationText(normalized);
  // why: nothing was deleted, so the compact reading would only repeat the primary
  // reasons — skip it and keep the verdict byte-identical to the single-pass one.
  const separated =
    compact === normalized
      ? []
      : newPassReasons(matchRuleReasons(compact), primary, COMPACT_MATCH_NOTE);
  const welded = weldedClassificationText(compact);
  const earlier = [...primary, ...separated];
  const whitespaceFree =
    welded === compact
      ? []
      : newPassReasons(matchWeldedReasons(welded), earlier, WHITESPACE_MATCH_NOTE);
  const hasUnmaskableMarkerInAnyReading =
    hasUnmaskableMarker(normalized) ||
    (compact !== normalized && hasUnmaskableMarker(compact)) ||
    (welded !== normalized && hasUnmaskableMarker(welded));
  const hasDisclosureRisk =
    hasDisclosureRiskSignal(normalized) ||
    (compact !== normalized && hasDisclosureRiskSignal(compact)) ||
    (welded !== normalized && hasDisclosureRiskSignal(welded));
  return {
    primary,
    separated,
    whitespaceFree,
    hasUnmaskableMarker: hasUnmaskableMarkerInAnyReading,
    hasDisclosureRisk,
  };
}

/**
 * Classify one finding.
 *
 * Borderline matches are sensitive: the verdict is `sensitive` whenever any rule
 * fires, and `reasons` records exactly which rules did. A finding with no match
 * is not sensitive, which is the only case in which the orchestrator may publish
 * its text without a human answer.
 *
 * The rules read the normalised text, but the recorded `match` strings come from
 * that same normalised text on purpose: the gate comment shows the human what
 * the classifier actually saw, and a fullwidth `ＡＵＴＨ` is reported as `AUTH`
 * rather than as a code-point sequence. A reason from a deletion pass carries its
 * note ({@link COMPACT_MATCH_NOTE} / {@link WHITESPACE_MATCH_NOTE}), because its
 * span is not verbatim in the finding.
 *
 * The unclassifiable check runs **after** the families, so a finding that both
 * matches a rule and carries lookalikes reports both and never short-circuits.
 *
 * A `security-topic` reason is recorded only when a disclosure-risk signal also
 * matched (bd-252): the topic word names an area of the code, and only the risk
 * word says that publishing the finding could expose something. Credential,
 * deny-path and unclassifiable reasons stay unconditional — they are the real
 * signal, so AC2 does not depend on this floor.
 */
export function classifyFindingSensitivity(finding: string): FindingSensitivity {
  const text = normalizeFindingText(finding);
  const passes = classificationPasses(text);
  const primary = passes.hasDisclosureRisk
    ? passes.primary
    : withoutSecurityTopicReasons(passes.primary);
  const separated = passes.hasDisclosureRisk
    ? passes.separated
    : withoutSecurityTopicReasons(passes.separated);
  const reasons: FindingSensitivityReason[] = reasonsOf(primary);
  const unclassifiable = residualUnclassifiableMatch(text);
  if (unclassifiable !== null) reasons.push({ kind: "unclassifiable-text", match: unclassifiable });
  reasons.push(...reasonsOf(separated), ...reasonsOf(passes.whitespaceFree));
  const deduped = dedupeReasons(reasons);
  return { sensitive: deduped.length > 0, reasons: deduped };
}

/**
 * Merge verdicts for the same finding into one, keeping the union of their reasons.
 *
 * why: a finding is sensitive when *any* verdict says so — the live table now, the
 * verdict stored by an earlier round, or a judgment made under a stricter table
 * since. The merged reasons are what a carried-forward record stores, so the
 * rebuilt record can explain itself to the human; intersection (or "latest wins")
 * would let one weaker verdict release text nobody approved.
 *
 * A schema-valid sensitive verdict always carries at least one reason
 * ({@link FindingSensitivitySchema} refines that invariant), so "sensitive" here
 * is exactly "a reason survived" and the result can be written back and read.
 */
export function mergeFindingSensitivity(
  verdicts: readonly FindingSensitivity[],
): FindingSensitivity {
  const reasons = dedupeReasons(verdicts.flatMap((verdict) => verdict.reasons));
  return { sensitive: reasons.length > 0, reasons };
}

/** Collapse whitespace and cap by code point, ellipsis counted in the cap. */
function capCodePoints(text: string, maxChars: number): string {
  const cap = Math.max(1, maxChars);
  const characters = Array.from(text);
  if (characters.length <= cap) return text;
  if (cap === 1) return ELLIPSIS;
  const head = characters
    .slice(0, cap - 1)
    .join("")
    .trimEnd();
  return `${head}${ELLIPSIS}`;
}

/** The human's own words, bounded; used for the recorded `answer` only. */
function boundedAnswer(text: string): string {
  return capCodePoints(text.replace(/\s+/gu, " ").trim(), PUBLICATION_ANSWER_MAX_CHARS);
}

/**
 * Normalise a reply for the anchored option match.
 *
 * Curly quotes are unified (a phone keyboard types them), whitespace collapses,
 * surrounding quotes are dropped, and trailing punctuation is removed. Nothing
 * else is rewritten: the point of the anchored patterns is that the reply is
 * compared as written, not that it is liberalised until it matches.
 */
function normalizePublicationAnswer(text: string): string {
  const unified = text.replace(/[’‘]/gu, "'").toLowerCase();
  const collapsed = unified.replace(/\s+/gu, " ").trim();
  return collapsed
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/[.!;,…]+$/u, "")
    .trim();
}

/**
 * Read a free-text human answer as a publication decision.
 *
 * **Strict on purpose.** The reply is recorded as a decision only when its
 * normalised form *is* one of the three options the gate comment names (option
 * labels plus a small set of exact synonyms, optional "please" and trailing
 * punctuation). Everything else — free text, a conditional or temporal reply
 * ("publish after we rotate the key", "once CI clears", "not yet"), a partial
 * permission ("publish but only the redacted version") — withholds with
 * `source: "default"`. A conditional yes is not a yes, and a decision recorded
 * here releases every sensitive finding in the record, not just the one the
 * human was thinking about.
 *
 * Order is part of the contract:
 *
 * 1. the withhold forms are checked first, so a negation is never read as the
 *    positive keyword it contains ("do not publish" is a withhold);
 * 2. redaction is checked before publication ("publish a redacted one-liner");
 * 3. a conditional marker gets its own default-withhold reason so the session can
 *    see the answer was heard but not treated as permission;
 * 4. unrecognised text is the plain default withhold.
 *
 * `source: "default"` vs `source: "human"` is meaningful: only the former is
 * re-askable (the gate can say the reply was not a decision), and both withhold.
 *
 * The `redact` result carries an empty `oneLiner` on purpose:
 * `applyPublicationAnswer` fills it per finding, because the redaction depends on
 * the finding text and not on the answer. A record with an empty one-liner is
 * treated as withheld by the publication gate.
 */
export function parsePublicationAnswer(text: string): FindingPublicationDecision {
  const normalized = normalizePublicationAnswer(text);
  if (normalized === "") {
    return { kind: "withhold", source: "default", reason: PUBLICATION_WITHHELD_BY_DEFAULT };
  }
  if (WITHHOLD_REPLY_PATTERN.test(normalized)) {
    return { kind: "withhold", source: "human", reason: PUBLICATION_WITHHELD_BY_HUMAN };
  }
  if (REDACT_REPLY_PATTERN.test(normalized)) {
    return { kind: "redact", source: "human", answer: boundedAnswer(text), oneLiner: "" };
  }
  if (PUBLISH_REPLY_PATTERN.test(normalized)) {
    return { kind: "publish", source: "human", answer: boundedAnswer(text) };
  }
  if (CONDITIONAL_REPLY_PATTERN.test(normalized)) {
    return { kind: "withhold", source: "default", reason: PUBLICATION_WITHHELD_CONDITIONAL };
  }
  return { kind: "withhold", source: "default", reason: PUBLICATION_WITHHELD_BY_DEFAULT };
}

/** Replace every credential-shaped match that is not a documented placeholder. */
function maskCredentialShaped(text: string): string {
  let masked = text;
  for (const rule of CREDENTIAL_SHAPED_RULES) {
    masked = masked.replace(rule.pattern, (match) =>
      isPlaceholderSecret(match, rule.secretPrefix) ? match : "[redacted]",
    );
  }
  return masked;
}

/**
 * Replace deny-set path tokens with `[path]`.
 *
 * Splitting with a capturing delimiter keeps the separators, so the prose around
 * a path survives unchanged; only the token itself is replaced.
 */
function maskDenyPaths(text: string): string {
  return text
    .split(TOKEN_DELIMITERS_CAPTURED)
    .map((part) => {
      const token = part.replace(TRAILING_PUNCTUATION, "").replace(LINE_SUFFIX, "");
      return findDenyPathPattern(token) === undefined ? part : "[path]";
    })
    .join("");
}

/**
 * The publishable one-liner for a sensitive finding.
 *
 * Lossy on the safe side by construction: a fenced block or an inline code span
 * collapses to `[redacted]` (a span can carry a credential shape no rule
 * recognizes, so its content is not trusted — but the marker keeps the fact that
 * something was removed), URLs are dropped, every credential shape becomes
 * `[redacted]`, every deny-set path becomes `[path]`, whitespace collapses, and
 * the result is capped by code point with the ellipsis inside the cap. If nothing
 * survives, the line is `[redacted]` — never an empty string that a renderer
 * might fill with the raw finding.
 *
 * The finding is normalised first ({@link normalizeFindingText}) so a credential
 * written in fullwidth Latin is masked instead of shipped as-is. Non-ASCII that
 * is not {@link BENIGN_TYPOGRAPHY} becomes `?`: the residual is by definition
 * text the classifier refused to read (`unclassifiable-text`), so a lookalike
 * must not survive into the line the human approves — `?` keeps the shape of the
 * sentence while dropping the code point that could not be trusted. Benign
 * typography (an em dash, curly quotes) is kept: replacing it would be obfuscation
 * rather than information removal, and it carries no hidden word.
 *
 * One case skips all of that: when a reading finds an **anchor**, a key-less
 * assignment, a credential or a deny path that the primary pass did not (or cannot)
 * mask, there is no safe fragment to keep — the whole line becomes `[redacted]`.
 * An anchor is the clearest instance: `-----BEGIN …` masks a *header* and the key
 * body follows it, and `ghp_` masks a *class*, not a span. That covers a
 * typographic split (`secrets·/prod.yaml`), a spaced-out one (`ghp_ 16C7…`, with
 * any number of spaces) and a split inside the key (`passw ord = …`), because
 * masking only what is visible would ship the halves.
 *
 * A lookalike inside an opaque run is the second wholesale case: `ghр_16C7…` with
 * a Cyrillic `р` breaks the anchor but leaves the token body, so masking the code
 * point alone would ship it ({@link hasLookalikeInsideOpaqueRun}). A prose
 * lookalike (`café`, `prоof`) has no long run behind it and stays maskable.
 */
export function redactFindingToOneLiner(
  finding: string,
  maxChars: number = ONE_LINER_DEFAULT_MAX_CHARS,
): string {
  const normalized = normalizeFindingText(finding);
  // why wholesale: a split shape and an unmaskable marker both mean the visible
  // "fragment" the pass would keep *is* the secret or its announcement. A
  // wholesale marker beats guessing which separator hid it, and it is the only
  // output for which "no anchor, no token body, no whitespace-free form of one"
  // can be verified.
  const { separated, whitespaceFree, hasUnmaskableMarker } = classificationPasses(normalized);
  const splitsSecret = [...reasonsOf(separated), ...reasonsOf(whitespaceFree)].some(isShapeReason);
  if (hasUnmaskableMarker || splitsSecret || hasLookalikeInsideOpaqueRun(normalized)) {
    return capCodePoints("[redacted]", maxChars);
  }
  // Fenced blocks first: their inner backticks would confuse the inline pass.
  const withoutFences = normalized.replace(/```[\s\S]*?```/gu, " [redacted] ");
  const withoutCodeSpans = withoutFences.replace(/`[^`]*`/gu, " [redacted] ");
  const withoutUrls = withoutCodeSpans.replace(/https?:\/\/[^\s)\]}>"']+/giu, " ");
  const withoutSecrets = maskCredentialShaped(withoutUrls);
  const withoutPaths = maskDenyPaths(withoutSecrets);
  const withoutLeftovers = withoutPaths.replace(NON_PRINTABLE_ASCII_PATTERN, (character) =>
    isBenignTypography(character) ? character : "?",
  );
  const collapsed = withoutLeftovers.replace(/\s+/gu, " ").trim();
  return capCodePoints(collapsed === "" ? "[redacted]" : collapsed, maxChars);
}
