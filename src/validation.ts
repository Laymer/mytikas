export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const normalize = (s: string) =>
  s.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
export function email(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw new HttpError(400, "Enter a valid email address.");
  return value.trim().toLowerCase();
}
export function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    throw new HttpError(400, "Use a password of 12–128 characters.");
  return value;
}
export function applicationInput(body: any) {
  const name =
    typeof body.characterName === "string"
      ? body.characterName.normalize("NFKC").trim().replace(/\s+/gu, " ")
      : "";
  if (!/^[\p{L}]{2,24} [\p{L}]{2,24}$/u.test(name))
    throw new HttpError(
      400,
      "Enter your first name and surname, separated by a space (2–24 letters each).",
    );
  const motivation =
    typeof body.motivation === "string" ? body.motivation.trim() : "";
  if ([...motivation].length < 1 || [...motivation].length > 300)
    throw new HttpError(400, "Motivation must contain 1–300 characters.");
  if (body.acceptRules !== true || !Number.isInteger(body.rulesId))
    throw new HttpError(400, "Accept the current guild rules.");
  return {
    name,
    key: normalize(name),
    motivation,
    rulesId: body.rulesId as number,
  };
}
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new HttpError(400, "Invalid reference.");
  return value;
}
