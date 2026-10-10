/** What the person sees when the model call itself fails; stream errors are otherwise masked. */
export function describeModelError(error: unknown, modelLabel: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient (credits|balance)|not enough credits|credit balance|\b402\b/i.test(message))
    return `${modelLabel} can't run: the AI account is out of credits. Ask whoever runs this app to add some.`;
  if (
    /\b(401|403)\b/.test(message) &&
    /unauthor|forbidden|invalid.*key|authentication/i.test(message)
  )
    return `${modelLabel} can't run: the AI key was refused. Ask whoever runs this app to check it.`;
  if (/model not found|not_found_error|\b404\b/i.test(message))
    return `${modelLabel} isn't available. Pick another model.`;
  if (/overloaded|rate.?limit|\b429\b|\b529\b|capacity/i.test(message))
    return `${modelLabel} is busy right now. Try again in a moment or pick another model.`;
  if (/daily free allocation|\b3036\b/i.test(message))
    return "Today's free Workers AI allowance is used up. Try again after 00:00 UTC.";
  return `${modelLabel} couldn't answer. Try again in a moment.`;
}
