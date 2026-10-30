import { AppError } from '../../utils/apiError.js';

export class SupportError extends AppError {
  constructor(code, message = code, statusCode = 409) {
    super(message, statusCode, { code });
  }
}
