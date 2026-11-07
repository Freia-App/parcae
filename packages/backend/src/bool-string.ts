// No imports: the log entry reads this, and that entry may load only Node
// builtins (the transcriber worker loads it).

/**
 * Parse a boolean-like env string. Returns `true`, `false`, or `null` for
 * unrecognised values (which Zod converts to a validation error).
 *
 * Accepts: true/false, 1/0, yes/no, on/off, empty string → false.
 * Used by both `envBoolean` and `parseNameList` so the accepted set
 * is consistent.
 */
export function parseBoolString(v: string): boolean | null {
  switch (v.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
    case "":
      return false;
    default:
      return null;
  }
}
