class AiError extends Error {
  constructor(message, status = 400, code = 'AI_INVALID_INPUT') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
module.exports = { AiError };
