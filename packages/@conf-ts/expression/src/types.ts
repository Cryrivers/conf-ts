export type ExpressionOptions = {
  optionalMemberAccess?: boolean;
  /** Alias for `optionalMemberAccess`. */
  loose?: boolean;
};

export type CompileOptions = ExpressionOptions & {
  /** Throw when code generation is unavailable instead of using the interpreter. */
  strict?: boolean;
};

export type Compiled<Context = unknown, ReturnType = unknown> = (
  env: Context,
) => ReturnType;
