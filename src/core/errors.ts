/** Throw this from run() for a message the user should read as-is (bad input, wrong key...). */
export class ToolError extends Error {
  override name = 'ToolError';
}
