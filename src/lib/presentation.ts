export function formatUsd(value: number): string {
  const fractionDigits = value > 0 && value < 0.001
    ? 4
    : value > 0 && value < 0.01
      ? 3
      : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
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
    return "Docubase's cloud service hit an unexpected error. Existing data was preserved; try again in a moment.";
  }
  if (message) return message;
  return "Something went wrong. Please try again.";
}
