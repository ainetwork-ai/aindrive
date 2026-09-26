/**
 * The bits of java.util.regex / java.lang.String the ported agent classes rely
 * on, so a Java pattern string can be pasted in unchanged and behave the same.
 *
 * Differences handled (JDK 21 semantics — what the phone's unit tests run on):
 *  - `\s` is ASCII only in Java ([ \t\n\x0B\f\r]); JS adds NBSP, U+3000, U+FEFF…
 *  - `.` also stops at U+0085 in Java.
 *  - `CASE_INSENSITIVE` (no UNICODE_CASE) folds ASCII only: JS `i` WITHOUT the
 *    `u` flag never folds a non-ASCII character onto an ASCII one, which is the
 *    same for patterns written in ASCII + Hangul like these.
 *  - `\b` and `\w` are ASCII in both (JDK 19+ made `\b` agree with `\w`).
 *  - `matches()` is a full match; `find()` is `RegExp.test`.
 */

const JAVA_SPACE = "\\t\\n\\x0B\\f\\r ";

/** Rewrite a Java pattern source into an equivalent JS one. */
function toJs(src) {
  let out = "", inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      i++;
      if (n === "s") out += inClass ? JAVA_SPACE : `[${JAVA_SPACE}]`;
      else if (n === "S") {
        if (inClass) throw new Error("\\S inside a class is not supported");
        out += `[^${JAVA_SPACE}]`;
      } else out += c + n;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      // A leading `^` or `]` belongs to the class.
      if (src[i + 1] === "^") { out += "^"; i++; }
      continue;
    }
    out += c === "." ? "[^\\n\\r\\u0085\\u2028\\u2029]" : c;
  }
  return out;
}

/** Pattern.compile(src[, CASE_INSENSITIVE]) for `find()` use. */
export function jre(src, { ci = false, unicode = false, global = false } = {}) {
  return new RegExp(toJs(src), (ci ? "i" : "") + (unicode ? "u" : "") + (global ? "g" : ""));
}

/** Pattern.compile(src, …) for `matches()`: anchored at both ends. */
export function jreFull(src, opts) {
  return jre(`^(?:${src})$`, opts);
}

/** String.trim(): strips every char <= U+0020, and only those. */
export function javaTrim(s) {
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) <= 0x20) a++;
  while (b > a && s.charCodeAt(b - 1) <= 0x20) b--;
  return s.slice(a, b);
}

/** String.split(regex): like JS split, minus trailing empty strings (when anything matched). */
export function javaSplit(s, re) {
  const parts = s.split(re);
  if (parts.length === 1) return parts;
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** String.hashCode(): 31-based over UTF-16 code units, as a signed 32-bit int. */
export function javaHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** Character.isUpperCase(s.charAt(0)): Lu or Other_Uppercase. */
export function isUpperCaseAt0(s) {
  return s.length > 0 && /\p{Uppercase}/u.test(s[0]);
}

/** Any Hangul syllable (U+AC00–U+D7A3): the "written in Korean" test used throughout. */
export const hasHangul = (s) => /[가-힣]/.test(s);
