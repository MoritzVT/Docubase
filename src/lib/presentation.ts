export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 2 : 2,
    maximumFractionDigits: value < 0.01 ? 3 : 2,
  }).format(value);
}

export function readableError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const message = raw.trim();
  if (
    /^internal$/i.test(message) ||
    /(?:functions\/internal|\binternal\b)/i.test(message)
  ) {
    return "The cloud analysis hit an unexpected error. Existing results were preserved; refresh the analysis to retry.";
  }
  if (message) return message;
  return "Something went wrong. Please try again.";
}
