import { ActionError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@template/contracts";

/**
 * Passwords that meet the length rule but appear near the top of every breach list. Short on
 * purpose: the length rule does most of the work, this catches the obvious ones.
 */
const COMMON = new Set([
  "1234567890",
  "12345678910",
  "123456789a",
  "0123456789",
  "0987654321",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "qwertyuiop",
  "qwerty1234",
  "qwerty12345",
  "asdfghjkl1",
  "zxcvbnm123",
  "password12",
  "password123",
  "password1234",
  "passw0rd123",
  "iloveyou12",
  "letmein123",
  "welcome123",
  "welcome1234",
  "changeme123",
  "administrator",
  "admin12345",
  "abc1234567",
  "abcdefghij",
  "aaaaaaaaaa",
  "1111111111",
  "0000000000",
  "football123",
  "baseball123",
  "superman123",
  "princess123",
  "sunshine123",
  "trustno1234",
  "dragon1234",
  "monkey1234",
  "starwars123",
  "maythe4thbewithyou",
  "threepigs123",
  "bigbadwolf123",
  "123123123123",
  "987654321a",
  "q1w2e3r4t5",
  "11223344556677",
]);

/** Returns the reason a password isn't allowed, or null when it is. */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}) {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common. Choose another.";
  if (new Set(lower).size < 4) return "Use a password with more variety.";
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower === local)
    return "Don't use your email as your password.";
  return null;
}

export function assertPassword(
  password: string,
  field: string,
  context: { email?: string; name?: string } = {},
): void {
  const problem = passwordProblem(password, context);
  if (problem) throw new ActionError("invalid_input", problem, { [field]: problem });
}
