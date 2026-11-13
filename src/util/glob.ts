/**
 * Dependency-free glob matching shared by permission rules, skill discovery
 * and file search. Supports `*`, `**`, `?`, `[abc]`, `[!abc]` and `{a,b}`,
 * plus a leading `!` for negation on a pattern list.
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

function escapeRegex(input: string): string {
  return input.replace(REGEX_SPECIALS, "\\$&");
}

function compileSegment(pattern: string): string {
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` spans directories; a trailing `**` matches everything.
        let next = index + 2;
        if (pattern[next] === "/") {
          out += "(?:.*/)?";
          next += 1;
        } else {
          out += ".*";
        }
        index = next;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close !== -1) {
        const body = pattern.slice(index + 1, close);
        const negated = body.startsWith("!") || body.startsWith("^");
        const chars = negated ? body.slice(1) : body;
        out += `[${negated ? "^" : ""}${chars.replace(/\\/g, "\\\\")}]`;
        index = close + 1;
        continue;
      }
    }
    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close !== -1) {
        const alternatives = pattern
          .slice(index + 1, close)
          .split(",")
          .map((part) => compileSegment(part));
        out += `(?:${alternatives.join("|")})`;
        index = close + 1;
        continue;
      }
    }
    out += escapeRegex(char);
    index += 1;
  }
  return out;
}

/** Compiles a glob into an anchored RegExp over a posix-style path. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const anchored = normalized.startsWith("/");
  const body = compileSegment(anchored ? normalized.slice(1) : normalized);
  return new RegExp(`^${anchored ? "" : ""}${body}$`);
}

export function matchGlob(pattern: string, value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (globToRegExp(pattern).test(normalized)) return true;
  // A bare pattern without a slash also matches the basename, so `*.env`
  // catches `config/.env` the way users expect.
  if (!pattern.includes("/")) {
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    return globToRegExp(pattern).test(base);
  }
  return false;
}

/**
 * Matches a value against an ordered rule list. Later patterns win; a
 * negated pattern (`!foo`) reverses the match. Returns undefined when no
 * pattern applies, so callers can distinguish "no opinion" from "deny".
 */
export function matchAny(patterns: string[], value: string): boolean | undefined {
  let matched: boolean | undefined;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    if (!pattern) continue;
    if (matchGlob(pattern, value)) {
      matched = !negated;
    } else if (negated) {
      // A negated pattern that does not match leaves the value accepted once
      // an earlier positive pattern has matched.
      continue;
    }
  }
  return matched;
}
