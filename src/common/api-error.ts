import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { FastifyReply } from 'fastify';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export class ApiException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, retryable = false) {
    super({ error: { code, message, retryable } } satisfies ApiErrorBody, status);
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null && 'error' in response && typeof response.error === 'object') {
        void reply.status(exception.getStatus()).send(response);
        return;
      }
      void reply.status(exception.getStatus()).send({
        error: {
          code: exception instanceof BadRequestException ? 'validation_failed' : 'request_failed',
          message: exception.message,
          retryable: false,
        },
      } satisfies ApiErrorBody);
      return;
    }

    console.error(exception);
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: {
        code: 'internal_error',
        message: 'An unexpected server error occurred.',
        retryable: true,
      },
    } satisfies ApiErrorBody);
  }
}
