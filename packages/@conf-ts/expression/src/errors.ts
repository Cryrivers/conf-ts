export const formatInvalid = (expr?: string, detail?: string): string => {
  if (!expr) {
    return 'invalid expression';
  }
  return detail ? `invalid expression: ${expr}, ${detail}` : `invalid expression: ${expr}`;
};

export const formatParseError = (expr: string): string => {
  return `parse expression error: ${expr}`;
};

export const raiseInvalid = (expr?: string, detail?: string): never => {
  throw new Error(formatInvalid(expr, detail));
};

export const raiseParseError = (expr: string): never => {
  throw new Error(formatParseError(expr));
};
